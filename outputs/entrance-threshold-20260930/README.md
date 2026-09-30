# Umbral de puerta en pendiente — 30-09-2026

La puerta procedural mantiene marco y hoja rectangulares. El umbral de piedra se ajusta a las alturas del terreno en ambos extremos y se nivela con la muestra más alta para evitar que se entierre. Medida artística de colocación, sin alterar terreno, huellas OSM ni accesibilidad física del juego.

## Evidencia comparable

`before/facade-ground.png` y `after/facade-ground.png` usan la misma cámara (3103, 75.2, 3948). La segunda muestra la puerta a nivel y el remate de piedra en la base.

- Draw calls: 32 → 32.
- Triángulos: 795363 → 795341.
- Vértices: 1901139 → 1901095.
- Mallas activas: 32 → 32.
- SwiftShader: tiempo/FPS no mide el dispositivo objetivo.

## Comprobaciones

TypeScript, materiales (5/5), kits de fachada, aleros (7/7) y build correctos.

Archivo modificado: `src/environment/village.ts`.
