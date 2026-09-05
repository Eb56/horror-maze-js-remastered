# The Maze // Signal Null

A remastered first-person horror maze built with Three.js and Vite.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. The game must be served over HTTP so module imports and the GLB/audio assets load correctly.

## Controls

- `WASD` Move
- `Mouse` Look after pointer lock
- `F` Toggle flashlight
- `Shift` Sprint
- `Space` Jump

Click **Enter the Maze** to begin. That first click also unlocks ambient audio in browsers that enforce autoplay restrictions.

## Remaster systems

- Procedurally generated 81x81 maze with connected navigation and landmark lights
- Instanced wall geometry for the larger map
- Dynamic soft shadow lighting with a stencil-capable WebGL renderer
- GLB monster loading with a procedural fallback if the model asset is unavailable
- Grid-based pathfinding with distance-based acceleration and flashlight stun behavior
- Flashlight battery drain and recharge with working click audio
- Looping ambient MP3 playback with user-gesture startup and visibility recovery
- Proximity heartbeat synthesized through Web Audio
- Animated grain, vignette, danger color separation, and death flash post-processing
- Responsive telemetry HUD with exit distance, heading, threat, battery, and objective readouts
- Main menu, death state, and escape state overlays

## Assets

- `models/monster.glb` - optional loaded enemy model
- `sounds/amb.mp3` - looping ambience
- `sounds/flash.wav` - flashlight toggle sound
- `textures/wall.jfif` - wall surface texture
