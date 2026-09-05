import * as THREE from 'three';
import { PointerLockControls } from 'three/examples/jsm/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';

const MAP_SIZE = 81;
const CELL_SIZE = 2;
const WALL_HEIGHT = 4.2;
const PLAYER_HEIGHT = 1.72;
const PLAYER_RADIUS = 0.34;
const GRID_CELLS = MAP_SIZE * MAP_SIZE;
const PATH_DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const START_CELL = { x: 1, z: 1 };
const EXIT_CELL = { x: MAP_SIZE - 2, z: MAP_SIZE - 2 };

let gameState = 'TITLE';
let maze = [];
let enemyPath = [];
let pathTimer = 0;
let enemyActive = false;
let enemyAnimT = 0;
let enemyStunTimer = 0;
let flashlightOn = false;
let battery = 100;
let isGrounded = true;
let wasGrounded = true;
let elapsed = 0;
let bobTime = 0;
let landingKick = 0;
let hudRefreshTimer = 0;
let mapSpawnTimer = null;
let mapRetryTimer = null;
let mapCollected = false;
let mapOpen = false;
let aoFailureReported = false;
const MAP_MIN_SPAWN_DISTANCE = 30;
let graphicsContextLost = false;

const keys = Object.create(null);
const velocity = new THREE.Vector3();
const moveDirection = new THREE.Vector3();
const forwardDirection = new THREE.Vector3();
const rightDirection = new THREE.Vector3();
const upDirection = new THREE.Vector3(0, 1, 0);
const cameraDirectionVector = new THREE.Vector3();
const enemyDirectionVector = new THREE.Vector3();
const worldLookDirection = new THREE.Vector3();
const cameraBasePosition = new THREE.Vector3();
const enemyWaypoint = new THREE.Vector3();
const bfsQueue = new Int32Array(GRID_CELLS);
const bfsParents = new Int32Array(GRID_CELLS);
const bfsVisited = new Uint32Array(GRID_CELLS);
let bfsStamp = 0;
const clock = new THREE.Clock();

const ui = {
  title: document.querySelector('#title-screen'),
  overlay: document.querySelector('#overlay-screen'),
  hud: document.querySelector('#hud'),
  crosshair: document.querySelector('#crosshair'),
  vignette: document.querySelector('#vignette'),
  proximity: document.querySelector('#proximity'),
  objective: document.querySelector('#objective'),
  flash: document.querySelector('#flash'),
  status: document.querySelector('#status'),
  batteryFill: document.querySelector('#battery-fill'),
  batteryPct: document.querySelector('#battery-pct'),
  batteryWrap: document.querySelector('#battery-wrap'),
  threatFill: document.querySelector('#threat-fill'),
  threatReadout: document.querySelector('#threat-readout'),
  heading: document.querySelector('#heading'),
  depth: document.querySelector('#depth'),
  compass: document.querySelector('#compass'),
  compassValue: document.querySelector('#compass-value'),
  mapScreen: document.querySelector('#map-screen'),
  mapCanvas: document.querySelector('#map-canvas'),
  start: document.querySelector('#start-btn')
};

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x020306);
scene.fog = new THREE.FogExp2(0x020306, 0.018);

const camera = new THREE.PerspectiveCamera(78, window.innerWidth / window.innerHeight, 0.1, 420);
camera.rotation.order = 'YXZ';
camera.position.set(3, PLAYER_HEIGHT, 3);

const renderer = new THREE.WebGLRenderer({
  canvas: document.querySelector('#game-canvas'),
  antialias: false,
  stencil: true,
  powerPreference: 'high-performance'
});
renderer.setSize(window.innerWidth, window.innerHeight);
const renderPixelRatio = Math.min(window.devicePixelRatio, window.innerWidth < 900 ? 1 : 1.25);
renderer.setPixelRatio(renderPixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const controls = new PointerLockControls(camera, renderer.domElement);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const getAoSize = () => ({
  width: Math.max(1, Math.floor(window.innerWidth * renderPixelRatio * 0.55)),
  height: Math.max(1, Math.floor(window.innerHeight * renderPixelRatio * 0.55))
});
let aoPass = null;
let aoUsable = false;
if (renderer.capabilities.isWebGL2) {
  const { width, height } = getAoSize();
  const supportsAoTargets = renderer.extensions.has('EXT_color_buffer_float');
  const supportsAoShader = renderer.capabilities.maxFragmentUniforms >= 32;
  if (supportsAoTargets && supportsAoShader) {
    try {
      aoPass = new SSAOPass(scene, camera, width, height, 8);
      aoPass.kernelRadius = 2.4;
      aoPass.minDistance = 0.004;
      aoPass.maxDistance = 0.055;
      aoPass.enabled = false;
      composer.addPass(aoPass);
      aoUsable = true;
      aoPass.setSize(width, height);
    } catch (error) {
      disableAmbientOcclusion('during initialization', error);
    }
  } else {
    console.info('Ambient occlusion disabled: this GPU does not support its render targets or shader budget.');
  }
} else {
  console.info('Ambient occlusion disabled: WebGL2 is unavailable.');
}
const grainPass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    intensity: { value: 0.024 },
    danger: { value: 0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float time;
    uniform float intensity;
    uniform float danger;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    void main() {
      vec2 centered = vUv - 0.5;
      float vignette = smoothstep(0.28, 0.82, length(centered));
      float grain = (hash(vUv * (700.0 + time * 0.1)) - 0.5) * intensity;
      vec2 aberration = centered * (0.001 + danger * 0.002);
      float red = texture2D(tDiffuse, vUv + aberration).r;
      float green = texture2D(tDiffuse, vUv).g;
      float blue = texture2D(tDiffuse, vUv - aberration).b;
      vec3 color = vec3(red, green, blue) + grain;
      color *= 1.0 - vignette * (0.18 + danger * 0.2);
      color.r += danger * vignette * 0.045;
      gl_FragColor = vec4(color, 1.0);
    }
  `
});
composer.addPass(grainPass);
composer.addPass(new OutputPass());

const ambientLight = new THREE.HemisphereLight(0x243044, 0x030405, 0.42);
scene.add(ambientLight);
const moonLight = new THREE.DirectionalLight(0x6383a0, 0.7);
moonLight.position.set(-28, 35, -18);
moonLight.castShadow = true;
moonLight.shadow.mapSize.set(1024, 1024);
moonLight.shadow.camera.left = -110;
moonLight.shadow.camera.right = 110;
moonLight.shadow.camera.top = 110;
moonLight.shadow.camera.bottom = -110;
moonLight.shadow.camera.near = 1;
moonLight.shadow.camera.far = 230;
scene.add(moonLight);

const texLoader = new THREE.TextureLoader();
const wallTex = texLoader.load('textures/wall.jfif', texture => {
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(1, 2);
  texture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 8);
});
wallTex.colorSpace = THREE.SRGBColorSpace;
const wallMat = new THREE.MeshStandardMaterial({
  map: wallTex,
  color: 0x707782,
  roughness: 0.91,
  metalness: 0.06
});
const floorMat = new THREE.MeshStandardMaterial({ color: 0x10151a, roughness: 0.96, metalness: 0.08 });
const ceilingMat = new THREE.MeshStandardMaterial({ color: 0x090c11, roughness: 1 });

function generateMaze(size) {
  const result = Array.from({ length: size }, () => Array(size).fill(1));
  const stack = [{ x: 1, z: 1 }];
  result[1][1] = 0;
  const directions = [[2, 0], [-2, 0], [0, 2], [0, -2]];
  while (stack.length) {
    const current = stack[stack.length - 1];
    const candidates = directions
      .map(([dx, dz]) => ({ x: current.x + dx, z: current.z + dz, dx, dz }))
      .filter(next => next.x > 0 && next.x < size - 1 && next.z > 0 && next.z < size - 1 && result[next.z][next.x] === 1);
    if (!candidates.length) {
      stack.pop();
      continue;
    }
    const next = candidates[Math.floor(Math.random() * candidates.length)];
    result[current.z + next.dz / 2][current.x + next.dx / 2] = 0;
    result[next.z][next.x] = 0;
    stack.push({ x: next.x, z: next.z });
  }
  // Add occasional chambers so the map feels like a place instead of a repeated corridor.
  for (let i = 0; i < 34; i += 1) {
    const x = 3 + Math.floor(Math.random() * (size - 7));
    const z = 3 + Math.floor(Math.random() * (size - 7));
    if (x % 2 === 1 && z % 2 === 1) {
      for (let dz = -1; dz <= 1; dz += 1) for (let dx = -1; dx <= 1; dx += 1) result[z + dz][x + dx] = 0;
    }
  }
  result[EXIT_CELL.z][EXIT_CELL.x] = 0;
  result[EXIT_CELL.z][EXIT_CELL.x - 1] = 0;
  return result;
}

function cellToWorld(x, z) {
  return new THREE.Vector3(x * CELL_SIZE + CELL_SIZE / 2, 0, z * CELL_SIZE + CELL_SIZE / 2);
}

function buildMap() {
  maze = generateMaze(MAP_SIZE);
  const span = MAP_SIZE * CELL_SIZE;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(span, span), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(span / 2, 0, span / 2);
  floor.receiveShadow = true;
  scene.add(floor);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(span, span), ceilingMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(span / 2, WALL_HEIGHT, span / 2);
  ceiling.receiveShadow = true;
  scene.add(ceiling);

  const wallCount = maze.flat().reduce((total, value) => total + value, 0);
  const wallMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(CELL_SIZE, WALL_HEIGHT, CELL_SIZE), wallMat, wallCount);
  const dummy = new THREE.Object3D();

  let index = 0;
  for (let z = 0; z < MAP_SIZE; z += 1) {
    for (let x = 0; x < MAP_SIZE; x += 1) {
      if (maze[z][x] !== 1) continue;
      const center = cellToWorld(x, z);
      dummy.position.set(center.x, WALL_HEIGHT / 2, center.z);
      dummy.rotation.y = ((x * 17 + z * 31) % 5) * 0.001;
      dummy.updateMatrix();
      wallMesh.setMatrixAt(index++, dummy.matrix);
    }
  }
  wallMesh.instanceMatrix.needsUpdate = true;
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  scene.add(wallMesh);

  // A few readable landmarks make the larger map easier to navigate.
  const markerMat = new THREE.MeshStandardMaterial({ color: 0x3b4246, roughness: 0.7, metalness: 0.2 });
  const markerGlow = new THREE.MeshBasicMaterial({ color: 0x9b2525 });
  for (let i = 0; i < 18; i += 1) {
    const x = 3 + Math.floor(Math.random() * (MAP_SIZE - 6));
    const z = 3 + Math.floor(Math.random() * (MAP_SIZE - 6));
    if (maze[z][x] !== 0 || maze[z + 1]?.[x] !== 0) continue;
    const marker = new THREE.Group();
    marker.position.copy(cellToWorld(x, z));
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 1.9, 8), markerMat);
    base.position.y = 0.95;
    base.castShadow = true;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), markerGlow);
    lamp.position.y = 1.88;
    marker.add(base, lamp);
    scene.add(marker);
  }
}
buildMap();

function findEnemySpawn() {
  let best = { x: 39, z: 39 };
  let bestScore = -Infinity;
  for (let z = 3; z < MAP_SIZE - 3; z += 2) {
    for (let x = 3; x < MAP_SIZE - 3; x += 2) {
      if (maze[z][x] !== 0) continue;
      const fromStart = Math.hypot(x - START_CELL.x, z - START_CELL.z);
      const fromExit = Math.hypot(x - EXIT_CELL.x, z - EXIT_CELL.z);
      const score = Math.min(fromStart, fromExit);
      if (score > bestScore) { bestScore = score; best = { x, z }; }
    }
  }
  return best;
}
const enemySpawnCell = findEnemySpawn();

function buildExit() {
  const exit = new THREE.Group();
  const position = cellToWorld(EXIT_CELL.x, EXIT_CELL.z);
  exit.position.copy(position);
  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x72f4bf });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.1, 14, 48), ringMaterial);
  ring.position.y = 1.7;
  ring.rotation.y = Math.PI / 2;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 3.1), new THREE.MeshBasicMaterial({ color: 0x43e8b1, transparent: true, opacity: 0.13, side: THREE.DoubleSide }));
  plane.position.y = 1.7;
  plane.rotation.y = Math.PI / 2;
  const light = new THREE.PointLight(0x43e8b1, 7, 15, 2);
  light.position.y = 1.7;
  exit.add(ring, plane, light);
  scene.add(exit);
  return { group: exit, ring, plane, light, position };
}
const exit = buildExit();

const flashlight = new THREE.SpotLight(0xffe8cc, 120, 38, Math.PI / 6.6, 0.7, 1.5);
flashlight.castShadow = true;
flashlight.shadow.mapSize.set(1024, 1024);
flashlight.shadow.camera.near = 0.2;
flashlight.shadow.camera.far = 40;
flashlight.visible = false;
scene.add(flashlight, flashlight.target);
const flashDir = new THREE.Vector3(0, 0, -1);
const playerGlow = new THREE.PointLight(0x27334a, 0.65, 5, 2);
scene.add(playerGlow);

function buildFallbackEnemy() {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x07090c, roughness: 0.82, metalness: 0.12 });
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0xff2946 });
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.15, 6, 12), bodyMat);
  torso.position.y = 1.35;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 12), bodyMat);
  head.position.y = 2.45;
  const eyeGeometry = new THREE.SphereGeometry(0.07, 8, 6);
  const leftEye = new THREE.Mesh(eyeGeometry, eyeMat);
  leftEye.position.set(-0.14, 2.48, 0.34);
  const rightEye = leftEye.clone();
  rightEye.position.x = 0.14;
  const eyeLight = new THREE.PointLight(0xff1838, 2, 5, 2);
  eyeLight.position.set(0, 2.45, 0.36);
  const armGeometry = new THREE.CapsuleGeometry(0.11, 1.28, 5, 8);
  const leftArm = new THREE.Mesh(armGeometry, bodyMat);
  leftArm.position.set(-0.53, 1.2, 0);
  leftArm.rotation.z = 0.28;
  const rightArm = leftArm.clone();
  rightArm.position.x = 0.53;
  rightArm.rotation.z = -0.28;
  group.add(torso, head, leftEye, rightEye, eyeLight, leftArm, rightArm);
  group.userData.parts = { torso, leftArm, rightArm };
  group.traverse(child => { if (child.isMesh) child.castShadow = true; });
  return group;
}

const enemy = buildFallbackEnemy();
enemy.position.copy(cellToWorld(enemySpawnCell.x, enemySpawnCell.z));
scene.add(enemy);

function buildMapPickup() {
  const group = new THREE.Group();
  group.visible = false;
  const paperMaterial = new THREE.MeshStandardMaterial({ color: 0xc8bca0, roughness: 0.82, metalness: 0.02, side: THREE.DoubleSide });
  const edgeMaterial = new THREE.MeshStandardMaterial({ color: 0x6b2022, roughness: 0.65, metalness: 0.15 });
  const paper = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.06, 0.72), paperMaterial);
  paper.rotation.x = -0.18;
  paper.castShadow = true;
  const fold = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.065, 0.68), edgeMaterial);
  fold.position.x = 0.02;
  fold.rotation.x = -0.18;
  const marker = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), new THREE.MeshBasicMaterial({ color: 0xf2383c }));
  marker.position.set(0.23, 0.11, -0.12);
  const glow = new THREE.PointLight(0xf2383c, 1.8, 4, 2);
  glow.position.y = 0.2;
  group.add(paper, fold, marker, glow);
  group.userData.baseY = 1.05;
  scene.add(group);
  return { group, marker };
}
const mapPickup = buildMapPickup();
const modelLoader = new GLTFLoader();
modelLoader.load('models/monster.glb', loaded => {
  const model = loaded.scene;
  model.scale.setScalar(1.6);
  model.position.y = 0;
  model.traverse(child => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  while (enemy.children.length) enemy.remove(enemy.children[0]);
  enemy.add(model);
  enemy.userData.parts = null;
  enemy.userData.model = model;
  enemy.userData.mixer = loaded.animations.length ? new THREE.AnimationMixer(model) : null;
  if (loaded.animations.length) enemy.userData.mixer.clipAction(loaded.animations[0]).play();
}, undefined, () => {
  // The procedural figure remains playable if the optional model asset fails to load.
});

function worldToCell(value) { return Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(value / CELL_SIZE))); }
function canOccupy(px, pz, radius = PLAYER_RADIUS) {
  const minX = worldToCell(px - radius);
  const maxX = worldToCell(px + radius);
  const minZ = worldToCell(pz - radius);
  const maxZ = worldToCell(pz + radius);
  for (let z = minZ; z <= maxZ; z += 1) for (let x = minX; x <= maxX; x += 1) {
    if (maze[z]?.[x] === 1) return false;
  }
  return true;
}

function bfsPath(sx, sz, gx, gz) {
  if (maze[sz]?.[sx] === 1 || maze[gz]?.[gx] === 1) return [];
  bfsStamp += 1;
  if (bfsStamp >= 0xffffffff) { bfsVisited.fill(0); bfsStamp = 1; }
  const start = sz * MAP_SIZE + sx;
  const goal = gz * MAP_SIZE + gx;
  let head = 0;
  let tail = 0;
  bfsQueue[tail++] = start;
  bfsVisited[start] = bfsStamp;
  bfsParents[start] = -1;
  while (head < tail) {
    const current = bfsQueue[head++];
    if (current === goal) break;
    const x = current % MAP_SIZE;
    const z = Math.floor(current / MAP_SIZE);
    for (const [dx, dz] of PATH_DIRECTIONS) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 1 || nx >= MAP_SIZE - 1 || nz < 1 || nz >= MAP_SIZE - 1 || maze[nz][nx] === 1) continue;
      const next = nz * MAP_SIZE + nx;
      if (bfsVisited[next] === bfsStamp) continue;
      bfsVisited[next] = bfsStamp;
      bfsParents[next] = current;
      bfsQueue[tail++] = next;
    }
  }
  if (bfsVisited[goal] !== bfsStamp) return [];
  const path = [];
  let step = goal;
  while (step !== start) {
    path.unshift({ x: step % MAP_SIZE, z: Math.floor(step / MAP_SIZE) });
    step = bfsParents[step];
  }
  return path;
}

const ambience = new Audio('sounds/amb.mp3');
ambience.loop = true;
ambience.preload = 'auto';
ambience.volume = 0.2;
ambience.addEventListener('error', () => { ui.status.textContent = 'AMBIENCE UNAVAILABLE'; });
ambience.addEventListener('ended', () => {
  ambience.currentTime = 0;
  ambience.play().catch(() => { ui.status.textContent = 'CLICK TO ENABLE AUDIO'; });
});
const flashClick = new Audio('sounds/flash.wav');
flashClick.preload = 'auto';
flashClick.volume = 0.45;
flashClick.addEventListener('error', () => { ui.status.textContent = 'FLASHLIGHT AUDIO UNAVAILABLE'; });
let audioContext;
let heartbeatTimer = null;
let heartbeatDanger = 0;
function startAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (AudioContextClass && !audioContext) audioContext = new AudioContextClass();
  if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {});
  if (ambience.paused) {
    ambience.play().then(() => { ui.status.textContent = 'AUDIO LINKED'; }).catch(() => { ui.status.textContent = 'CLICK TO ENABLE AUDIO'; });
  }
}
function playClick() {
  if (flashClick.error) return;
  flashClick.currentTime = 0;
  flashClick.play().catch(() => {});
}
function heartbeat(distance) {
  heartbeatDanger = Math.max(0, Math.min(1, 1 - distance / 24));
  if (heartbeatDanger < 0.08 || !audioContext || audioContext.state !== 'running') {
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
    return;
  }
  if (heartbeatTimer) return;
  const beat = () => {
    heartbeatTimer = null;
    if (gameState !== 'PLAYING' || heartbeatDanger < 0.08 || audioContext.state !== 'running') return;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 58;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.18 + heartbeatDanger * 0.13, audioContext.currentTime + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.16);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.18);
    heartbeatTimer = setTimeout(beat, Math.max(290, 880 - heartbeatDanger * 580));
  };
  beat();
}

let lastBatteryPct = -1;
function setBatteryUI() {
  const pct = Math.max(0, Math.floor(battery));
  if (pct === lastBatteryPct) return;
  lastBatteryPct = pct;
  const color = pct < 20 ? statusColors.critical : pct < 45 ? statusColors.elevated : statusColors.low;
  ui.batteryFill.style.width = `${pct}%`;
  ui.batteryFill.style.backgroundColor = color;
  ui.batteryFill.style.boxShadow = `0 0 12px ${color}`;
  ui.batteryPct.textContent = `${pct}%`;
  ui.batteryWrap.style.color = color;
}
const statusColors = { low: '#98635f', elevated: '#d39a5a', critical: '#f2383c' };
let lastThreatLevel = -1;
function updateThreatUI(distance) {
  const threat = Math.max(0, Math.min(1, 1 - distance / 24));
  const threatLevel = Math.round(threat * 100);
  if (threatLevel === lastThreatLevel) {
    heartbeat(distance);
    return;
  }
  lastThreatLevel = threatLevel;
  ui.threatFill.style.width = `${Math.round(threat * 100)}%`;
  ui.threatReadout.textContent = threat > 0.7 ? 'CRITICAL' : threat > 0.3 ? 'ELEVATED' : 'LOW';
  ui.threatReadout.style.color = threat > 0.7 ? statusColors.critical : threat > 0.3 ? statusColors.elevated : statusColors.low;
  ui.vignette.style.opacity = `${Math.min(0.48, threat * 0.58)}`;
  ui.proximity.style.opacity = threat > 0.63 ? '1' : '0';
  grainPass.uniforms.danger.value = threat * 0.55;
  heartbeat(distance);
}

function setOverlay(title, message, buttonText, className) {
  ui.overlay.innerHTML = `<div class="overlay-card ${className}"><div class="eyebrow">SIGNAL LOST</div><h2>${title}</h2><p>${message}</p><button class="game-btn" id="ov-btn">${buttonText}</button></div>`;
  ui.overlay.classList.add('show');
  ui.overlay.querySelector('#ov-btn').addEventListener('click', () => { ui.overlay.classList.remove('show'); startGame(); });
}
function clearKeys() {
  for (const key of Object.keys(keys)) delete keys[key];
}
function setAmbientOcclusionEnabled(enabled) {
  if (aoPass) aoPass.enabled = enabled && aoUsable && !aoFailureReported;
}
function disableAmbientOcclusion(reason, error) {
  if (!aoPass) return;
  aoPass.enabled = false;
  aoUsable = false;
  composer.removePass(aoPass);
  if (!aoFailureReported) {
    aoFailureReported = true;
    console.warn(`Ambient occlusion disabled ${reason}:`, error);
  }
  aoPass = null;
}
function renderFrame() {
  if (graphicsContextLost || renderer.getContext().isContextLost()) return;
  try {
    composer.render();
  } catch (error) {
    if (aoPass?.enabled) {
      disableAmbientOcclusion('after a render failure', error);
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    } else {
      throw error;
    }
  }
}
const canvas = renderer.domElement;
canvas.addEventListener('webglcontextlost', event => {
  event.preventDefault();
  graphicsContextLost = true;
  setAmbientOcclusionEnabled(false);
  ui.status.textContent = 'GRAPHICS CONTEXT LOST';
});
canvas.addEventListener('webglcontextrestored', () => {
  graphicsContextLost = false;
  ui.status.textContent = gameState === 'PLAYING' ? 'AUDIO LINKED' : 'AUDIO STANDBY';
  if (gameState === 'PLAYING' && renderer.capabilities.isWebGL2 && !aoFailureReported) setAmbientOcclusionEnabled(true);
});
function drawMap() {
  const context = ui.mapCanvas.getContext('2d');
  if (!context) return;
  const cell = ui.mapCanvas.width / MAP_SIZE;
  const playerX = worldToCell(cameraBasePosition.x);
  const playerZ = worldToCell(cameraBasePosition.z);
  const route = bfsPath(playerX, playerZ, EXIT_CELL.x, EXIT_CELL.z);

  context.fillStyle = '#08090b';
  context.fillRect(0, 0, ui.mapCanvas.width, ui.mapCanvas.height);
  for (let z = 0; z < MAP_SIZE; z += 1) {
    for (let x = 0; x < MAP_SIZE; x += 1) {
      context.fillStyle = maze[z][x] === 1 ? '#252027' : '#10151a';
      context.fillRect(x * cell, z * cell, cell + 0.35, cell + 0.35);
    }
  }

  context.strokeStyle = '#f2383c';
  context.shadowColor = '#f2383c';
  context.shadowBlur = 7;
  context.lineWidth = Math.max(2, cell * 0.55);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo((playerX + 0.5) * cell, (playerZ + 0.5) * cell);
  for (const step of route) context.lineTo((step.x + 0.5) * cell, (step.z + 0.5) * cell);
  context.stroke();
  context.shadowBlur = 0;

  const playerCenterX = (playerX + 0.5) * cell;
  const playerCenterZ = (playerZ + 0.5) * cell;
  context.fillStyle = '#f4e6df';
  context.beginPath();
  context.arc(playerCenterX, playerCenterZ, Math.max(3, cell * 0.8), 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#f2383c';
  context.lineWidth = 2;
  context.stroke();

  const exitCenterX = (EXIT_CELL.x + 0.5) * cell;
  const exitCenterZ = (EXIT_CELL.z + 0.5) * cell;
  context.fillStyle = '#72f4bf';
  context.beginPath();
  context.arc(exitCenterX, exitCenterZ, Math.max(3, cell * 0.85), 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = '#d9fff0';
  context.stroke();

  const lookDirection = camera.getWorldDirection(worldLookDirection);
  context.strokeStyle = '#f4e6df';
  context.lineWidth = 1.5;
  context.beginPath();
  context.moveTo(playerCenterX, playerCenterZ);
  context.lineTo(playerCenterX + lookDirection.x * cell * 2.3, playerCenterZ + lookDirection.z * cell * 2.3);
  context.stroke();
}

function clearMapTimers() {
  if (mapSpawnTimer !== null) window.clearTimeout(mapSpawnTimer);
  if (mapRetryTimer !== null) window.clearTimeout(mapRetryTimer);
  mapSpawnTimer = null;
  mapRetryTimer = null;
}

function findMapSpawnCell() {
  const playerX = cameraBasePosition.x;
  const playerZ = cameraBasePosition.z;
  const candidates = [];
  for (let z = 1; z < MAP_SIZE - 1; z += 1) {
    for (let x = 1; x < MAP_SIZE - 1; x += 1) {
      const position = cellToWorld(x, z);
      const distance = Math.hypot(position.x - playerX, position.z - playerZ);
      if (maze[z][x] === 0 && distance >= MAP_MIN_SPAWN_DISTANCE && (x !== EXIT_CELL.x || z !== EXIT_CELL.z)) {
        candidates.push({ x, z });
      }
    }
  }
  return candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : null;
}

function spawnMap() {
  if (gameState !== 'PLAYING' || mapCollected || mapPickup.group.visible) return;
  const spawnCell = findMapSpawnCell();
  if (!spawnCell) {
    mapRetryTimer = window.setTimeout(() => {
      mapRetryTimer = null;
      spawnMap();
    }, 1000);
    return;
  }
  const position = cellToWorld(spawnCell.x, spawnCell.z);
  mapPickup.group.position.set(position.x, mapPickup.group.userData.baseY, position.z);
  mapPickup.group.visible = true;
  ui.status.textContent = 'NAVIGATION SCHEMATIC SIGNAL DETECTED';
}

function scheduleMapSpawn() {
  clearMapTimers();
  const delay = Math.floor(Math.random() * 30001);
  mapSpawnTimer = window.setTimeout(() => {
    mapSpawnTimer = null;
    spawnMap();
  }, delay);
}

function setMapOpen(open) {
  if (open && (!mapCollected || gameState !== 'PLAYING')) {
    ui.status.textContent = 'MAP NOT RECOVERED';
    return;
  }
  mapOpen = open;
  ui.mapScreen.classList.toggle('show', open);
  ui.mapScreen.setAttribute('aria-hidden', String(!open));
  if (open) {
    drawMap();
    controls.unlock();
    ui.status.textContent = 'MAP OPEN // PRESS M TO CLOSE';
  } else if (gameState === 'PLAYING') {
    controls.lock();
    ui.status.textContent = 'AUDIO LINKED';
  }
}

function collectMap() {
  if (!mapPickup.group.visible || mapCollected) return;
  mapCollected = true;
  mapPickup.group.visible = false;
  ui.status.textContent = 'MAP RECOVERED // PRESS M TO VIEW';
}

function setCompassVisible(visible) {
  ui.compass.classList.toggle('show', visible);
  ui.compass.style.display = visible ? 'block' : 'none';
  ui.compass.setAttribute('aria-hidden', String(!visible));
}

function resetEnemy() {
  enemy.position.copy(cellToWorld(enemySpawnCell.x, enemySpawnCell.z));
  enemy.position.y = 0;
  enemyPath = [];
  pathTimer = 0;
  enemyStunTimer = 0;
  enemyActive = false;
}

function updateMapPickup(now) {
  if (!mapPickup.group.visible) return;
  mapPickup.group.rotation.y = now * 0.0012;
  mapPickup.group.position.y = mapPickup.group.userData.baseY + Math.sin(now * 0.004) * 0.12;
  if (cameraBasePosition.distanceTo(mapPickup.group.position) < 1.35) collectMap();
}

function startGame() {
  if (gameState === 'PLAYING') return;
  clearMapTimers();
  mapCollected = false;
  mapOpen = false;
  ui.mapScreen.classList.remove('show');
  ui.mapScreen.setAttribute('aria-hidden', 'true');
  mapPickup.group.visible = false;
  gameState = 'PLAYING';
  ui.title.classList.add('hidden');
  ui.hud.classList.add('show');
  setCompassVisible(true);
  ui.crosshair.classList.add('show');
  ui.objective.classList.add('show');
  ui.status.textContent = 'AUDIO LINKED';
  camera.position.copy(cellToWorld(START_CELL.x, START_CELL.z));
  camera.position.y = PLAYER_HEIGHT;
  camera.rotation.set(0, 0, 0);
  cameraBasePosition.copy(camera.position);
  velocity.set(0, 0, 0);
  wasGrounded = true;
  bobTime = 0;
  landingKick = 0;
  clearKeys();
  isGrounded = true;
  battery = 100;
  ambience.currentTime = 0;
  lastBatteryPct = -1;
  lastThreatLevel = -1;
  flashlightOn = false;
  flashlight.visible = false;
  setAmbientOcclusionEnabled(true);
  resetEnemy();
  scheduleMapSpawn();
  startAudio();
  controls.lock();
  setBatteryUI();
}
function playerDied() {
  if (gameState !== 'PLAYING') return;
  gameState = 'DEAD';
  if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
  ambience.pause();
  setAmbientOcclusionEnabled(false);
  controls.unlock();
  setMapOpen(false);
  setCompassVisible(false);
  clearMapTimers();
  flashlightOn = false;
  flashlight.visible = false;
  ui.flash.classList.add('active');
  setTimeout(() => ui.flash.classList.remove('active'), 260);
  setTimeout(() => setOverlay('YOU DIED', 'The signal ended in the dark.', 'RE-ENTER THE MAZE', 'danger'), 420);
}
function playerWon() {
  if (gameState !== 'PLAYING') return;
  gameState = 'WIN';
  if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
  ambience.pause();
  setAmbientOcclusionEnabled(false);
  controls.unlock();
  setMapOpen(false);
  setCompassVisible(false);
  clearMapTimers();
  setOverlay('SURFACE REACHED', 'The last door opened.', 'DESCEND AGAIN', 'success');
}

document.addEventListener('keydown', event => {
  keys[event.code] = true;
  if (event.repeat) return;
  if (event.code === 'KeyM' && gameState === 'PLAYING') {
    setMapOpen(!mapOpen);
    return;
  }
  if (event.code === 'KeyF' && gameState === 'PLAYING') {
    if (!flashlightOn && battery <= 5) return;
    flashlightOn = !flashlightOn;
    flashlight.visible = flashlightOn;
    playClick();
  }
  if (event.code === 'Space' && gameState === 'PLAYING' && isGrounded) {
    velocity.y = 7.2;
    isGrounded = false;
  }
});
document.addEventListener('keyup', event => { keys[event.code] = false; });
ui.start.addEventListener('click', startGame);
renderer.domElement.addEventListener('click', () => { if (gameState === 'PLAYING') { startAudio(); controls.lock(); } });
window.addEventListener('blur', clearKeys);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearKeys();
    ambience.pause();
    if (heartbeatTimer) { clearTimeout(heartbeatTimer); heartbeatTimer = null; }
  } else if (gameState === 'PLAYING') {
    startAudio();
  }
});

function updatePlayer(delta) {
  const direction = moveDirection;
  wasGrounded = isGrounded;
  direction.set(0, 0, 0);
  if (keys.KeyW) direction.z -= 1;
  if (keys.KeyS) direction.z += 1;
  if (keys.KeyA) direction.x -= 1;
  if (keys.KeyD) direction.x += 1;
  const sprinting = keys.ShiftLeft || keys.ShiftRight;
  const speed = sprinting ? 8.8 : 5.2;
  if (direction.lengthSq()) {
    direction.normalize();
    const forward = camera.getWorldDirection(forwardDirection);
    forward.y = 0;
    forward.normalize();
    const right = rightDirection.crossVectors(forward, upDirection).normalize();
    velocity.x = (right.x * direction.x + forward.x * -direction.z) * speed;
    velocity.z = (right.z * direction.x + forward.z * -direction.z) * speed;
  } else {
    velocity.x = THREE.MathUtils.damp(velocity.x, 0, 12, delta);
    velocity.z = THREE.MathUtils.damp(velocity.z, 0, 12, delta);
  }
  if (!isGrounded) velocity.y -= 22 * delta;
  const nextX = cameraBasePosition.x + velocity.x * delta;
  const nextZ = cameraBasePosition.z + velocity.z * delta;
  if (canOccupy(nextX, cameraBasePosition.z)) cameraBasePosition.x = nextX; else velocity.x = 0;
  if (canOccupy(cameraBasePosition.x, nextZ)) cameraBasePosition.z = nextZ; else velocity.z = 0;
  cameraBasePosition.y += velocity.y * delta;
  if (cameraBasePosition.y <= PLAYER_HEIGHT) {
    cameraBasePosition.y = PLAYER_HEIGHT;
    const impactSpeed = Math.abs(velocity.y);
    velocity.y = 0;
    isGrounded = true;
    if (!wasGrounded) landingKick = Math.min(0.16, impactSpeed * 0.012 + 0.045);
  }
}

// Keeps the view from ever pitching past vertical and flipping over.
const MAX_LOOK_PITCH = Math.PI / 2 - 0.04;

function clampCameraPitch() {
  const pitch = camera.rotation.x;
  if (pitch > MAX_LOOK_PITCH) camera.rotation.x = MAX_LOOK_PITCH;
  else if (pitch < -MAX_LOOK_PITCH) camera.rotation.x = -MAX_LOOK_PITCH;
}

function updateCameraMotion(delta) {
  clampCameraPitch();
  const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
  const moving = isGrounded && horizontalSpeed > 0.35;
  const sprinting = keys.ShiftLeft || keys.ShiftRight;
  const bobFrequency = sprinting ? 11 : 8.6;
  const bobAmount = sprinting ? 0.05 : 0.032;

  if (moving) bobTime += delta * bobFrequency;
  else bobTime = THREE.MathUtils.damp(bobTime, Math.round(bobTime / (Math.PI * 2)) * (Math.PI * 2), 12, delta);
  landingKick = THREE.MathUtils.damp(landingKick, 0, 9, delta);

  const bobFade = moving ? Math.min(1, horizontalSpeed / (sprinting ? 8.8 : 5.2)) : 0;
  // Position-only head-bob: PointerLockControls exclusively owns camera orientation.
  const bobY = Math.sin(bobTime) * bobAmount * bobFade - landingKick;
  const bobX = Math.cos(bobTime) * bobAmount * 0.4 * bobFade;
  camera.position.x = cameraBasePosition.x + bobX;
  camera.position.y = cameraBasePosition.y + bobY;
  camera.position.z = cameraBasePosition.z;
}

function updateFlashlight(delta) {
  const cameraDirection = camera.getWorldDirection(cameraDirectionVector);
  flashDir.lerp(cameraDirection, Math.min(1, 8 * delta)).normalize();
  flashlight.position.copy(camera.position).addScaledVector(cameraDirection, 0.25);
  flashlight.position.y -= 0.08;
  flashlight.target.position.copy(flashlight.position).addScaledVector(flashDir, 26);
  flashlight.target.updateMatrixWorld();
  playerGlow.position.copy(camera.position);
  if (flashlightOn) {
    battery = Math.max(0, battery - 0.92 * delta);
    if (battery === 0) { flashlightOn = false; flashlight.visible = false; playClick(); }
  } else battery = Math.min(100, battery + 0.72 * delta);
  setBatteryUI();
}

function updateEnemy(delta) {
  const pX = worldToCell(camera.position.x);
  const pZ = worldToCell(camera.position.z);
  const eX = worldToCell(enemy.position.x);
  const eZ = worldToCell(enemy.position.z);
  const distance = camera.position.distanceTo(enemy.position);
  if (!enemyActive && distance < 44) enemyActive = true;
  const enemyDirection = enemyDirectionVector.subVectors(enemy.position, flashlight.position);
  const beamDistance = enemyDirection.length();
  const beamDot = beamDistance > 0 ? enemyDirection.normalize().dot(flashDir) : -1;
  const inFlashlightBeam = flashlightOn && beamDistance < 27 && beamDot > 0.93;
  if (inFlashlightBeam) enemyStunTimer = Math.max(enemyStunTimer, 0.18);
  enemyStunTimer = Math.max(0, enemyStunTimer - delta);
  if (enemyActive && enemyStunTimer <= 0) {
    pathTimer -= delta;
    if (pathTimer <= 0) {
      pathTimer = distance < 18 ? 0.42 : 0.85;
      enemyPath = bfsPath(eX, eZ, pX, pZ);
    }
    const speed = distance < 12 ? 6.5 : distance < 26 ? 4.4 : 3.25;
    if (enemyPath.length) {
      enemyWaypoint.set(enemyPath[0].x * CELL_SIZE + 1, 0, enemyPath[0].z * CELL_SIZE + 1);
      const toWaypoint = enemyDirectionVector.set(enemyWaypoint.x - enemy.position.x, 0, enemyWaypoint.z - enemy.position.z);
      if (toWaypoint.length() < 0.22) enemyPath.shift();
      else {
        toWaypoint.normalize();
        enemy.position.addScaledVector(toWaypoint, speed * delta);
        enemy.rotation.y = Math.atan2(toWaypoint.x, toWaypoint.z);
      }
    }
  }
  enemyAnimT += delta;
  const chaseBob = Math.sin(enemyAnimT * (distance < 14 ? 8 : 4)) * (distance < 14 ? 0.1 : 0.045);
  enemy.position.y = chaseBob;
  if (enemy.userData.mixer) enemy.userData.mixer.update(delta);
  const parts = enemy.userData.parts;
  if (parts) {
    parts.torso.rotation.z = Math.sin(enemyAnimT * 1.6) * 0.06;
    parts.leftArm.rotation.x = Math.sin(enemyAnimT * 4) * 0.45;
    parts.rightArm.rotation.x = -Math.sin(enemyAnimT * 4) * 0.45;
  }
  updateThreatUI(distance);
  if (distance < 1.22) playerDied();
  return distance;
}

function updateWorld(now, delta) {
  exit.ring.rotation.z += delta * 1.05;
  exit.plane.material.opacity = 0.1 + Math.sin(now * 0.003) * 0.045;
  exit.light.intensity = 6 + Math.sin(now * 0.0025) * 1.5;
  const dx = camera.position.x - exit.position.x;
  const dz = camera.position.z - exit.position.z;
  if (Math.hypot(dx, dz) < 1.7) playerWon();
  hudRefreshTimer -= delta;
  if (hudRefreshTimer > 0) return;
  hudRefreshTimer = 0.12;
  const lookDirection = camera.getWorldDirection(worldLookDirection);
  const heading = Math.round((THREE.MathUtils.radToDeg(Math.atan2(lookDirection.x, -lookDirection.z)) + 360) % 360);
  const headingText = heading.toString().padStart(3, '0');
  ui.heading.textContent = `HEADING ${headingText}`;
  ui.compassValue.textContent = `${headingText}°`;
  ui.compass.style.setProperty('--compass-rotation', `${-heading}deg`);
  if (gameState === 'PLAYING' && ui.compass.style.display !== 'block') setCompassVisible(true);
  const progress = Math.min(99, Math.round(camera.position.distanceTo(exit.position) / (MAP_SIZE * CELL_SIZE) * 100));
  ui.depth.textContent = `EXIT DIST ${progress}%`;
}

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  elapsed += delta;
  grainPass.uniforms.time.value = elapsed;
  if (gameState === 'PLAYING') {
    updateMapPickup(elapsed * 1000);
    if (!mapOpen) {
      updatePlayer(delta);
      updateCameraMotion(delta);
      updateFlashlight(delta);
      updateEnemy(delta);
      updateWorld(elapsed * 1000, delta);
    } else {
      drawMap();
    }
  }
  renderFrame();
}
animate();
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  try {
    composer.setSize(window.innerWidth, window.innerHeight);
    if (aoPass) {
      const { width, height } = getAoSize();
      aoPass.setSize(width, height);
    }
  } catch (error) {
    if (aoPass) {
      disableAmbientOcclusion('after a resize failure', error);
      composer.setSize(window.innerWidth, window.innerHeight);
    } else {
      console.warn('Post-processing resize failed:', error);
    }
  }
});
