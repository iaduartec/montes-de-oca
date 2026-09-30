# Tejas: comparación del 30-09-2026

Material cerámico procedural original (albedo, normal y rugosidad), aplicado a las cubiertas de teja del pueblo y de Nuestra Señora de Oca. Canales orientados hacia la pendiente, con escala nominal de 20 cm por 40 cm. Es una interpretación artística; no documenta tejas individuales reales.

## Evidencia

- `before/oca.png` y `after/oca.png`: misma cámara y geometría.
- `plaza-after/plaza.png`: control visual en la escena principal del pueblo; sin comparación anterior en este ciclo.
- Oca conserva 33 draw calls, 773726 triángulos, 1892779 vértices y 33 mallas activas.
- Se añaden tres mapas RGBA de 256x256 por caché (pueblo e hitos): aproximadamente 2 MiB con mipmaps en total. Estimación de almacenamiento, no medición GPU.
- Chrome con SwiftShader: tiempos/FPS no representan el dispositivo objetivo.

## Comprobaciones

`npm run typecheck`, `test_building_materials.mjs` (5/5), `validate_focal_sites.mjs` y `npm run build`: correctos.

El visor aislado `village_preview.html` mostró “Failed to fetch” al cargar y no produjo una línea base. Las capturas de Oca y plaza corresponden al juego principal y sí terminaron.

## Archivos

`src/environment/facade-materials.ts`, `src/environment/village.ts`, `src/environment/village-landmarks.ts`. Geometría y GLB sin cambios en este ciclo.
