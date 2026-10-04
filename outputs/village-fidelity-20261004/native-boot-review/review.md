# Native cold-boot review

**Finding: no native boot/render-loop exception reproduced.** Fresh isolated Chrome processes loaded both the live Vite development server (`127.0.0.1:5174`) and a production build served by the isolated Vite preview (`127.0.0.1:4199`). Each ran for 30 seconds from a new profile with no manual input or `manualStep` calls. CDP recorded zero `Runtime.exceptionThrown`, zero console errors, and zero page `error`/`unhandledrejection` events in both runs.

The cold screenshot at 0.5 seconds shows the app's expected `cargando terreno…` screen. By 30 seconds both screenshots show the playable world, including the player, 4x4, buildings, roads, and NPC. The game API appeared between 5 and 10 seconds on dev and by 5 seconds on preview. At the settled sample both had 196 draw calls, 1,933,730 triangles, 1,314,179 vertices, and 101 active meshes; terrain reported 16 resident GPU meshes and 1,337,340 resident triangles. Full samples, exception payloads and environment details are in [cold-native-boot.json](cold-native-boot.json); the HEAD and exact source/data hashes are saved in [head.txt](head.txt), [live-src-manifest.sha256](live-src-manifest.sha256), [live-public-manifest.sha256](live-public-manifest.sha256), and [build-config-hashes.sha256](build-config-hashes.sha256). The app source copies and clean build are under [isolated](isolated/).

This disproves a persistent native-loop failure on these two cold starts. In `src/main.ts`, the `manualStep` guard at lines 1412–1417 only skips simulation advancement; execution continues to `scene.render()` later in the same loop (line 1472). It cannot explain a blank canvas by disabling rendering.

The catalogue's prior black screenshots and `0` resource baseline are explained by its own false-ready condition in `scripts/vehicle/drive_catalog.mjs` lines 109–123: after a fixed 3-second delay it considered five unchanged `0/0/0` draw/triangle/vertex samples stable. The actual page can expose `window.__game.vehicle` while terrain loading is still visible and before any positive rendered-resource sample. This is a harness readiness bug, not a reproduced application exception. The prior `exceptionThrown: Uncaught` did not reproduce in the cold dev or production preview; its original event lacks a stack in the saved catalogue report, so its separate source remains undetermined.

The captured Chromium backend is SwiftShader. The scene appeared at 0.63–0.68 FPS with approximately 1.5–1.7 second engine frame times during these captures. This confirms render-loop progress in a software-rendered test only; it is not target-GPU performance evidence.

## Captures

| Target | 0.5-second cold state | 30-second native scene |
|---|---|---|
| Dev 5174 | [PNG](captures/dev5174-cold-0.5s.png) | [PNG](captures/dev5174-cold-30s.png) |
| Built preview 4199 | [PNG](captures/preview4199-cold-0.5s.png) | [PNG](captures/preview4199-cold-30s.png) |
