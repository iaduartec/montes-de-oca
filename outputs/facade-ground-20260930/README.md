# Zócalos junto al terreno — 30-09-2026

Se conserva la base enterrada de las fachadas procedurales. El borde superior del zócalo pasa de la cota mínima de la casa a una muestra local del terreno cada 2 m como máximo, con 55 cm de banda visible nominal y un límite de 20 cm bajo el alero. La piedra reutiliza material, textura y lote existentes. No se modifican terreno, huellas OSM, GLB piloto ni colisiones.

La banda es una interpretación artística del zócalo existente, no una fachada real medida. Su seguimiento de pendiente está basado en el terreno del juego.

## Comparación

`before/facade-ground.png` y `after/facade-ground.png` comparten exactamente la cámara. En la fachada de ladrillo se observa una banda de piedra continua antes oculta en la pendiente.

- Draw calls: 32 → 32.
- Triángulos de la escena: 791183 → 795363 (+4180, 0.53%).
- Vértices: 1892779 → 1901139 (+8360).
- Mallas activas: 32 → 32.
- Sin texturas nuevas. SwiftShader; FPS no representan la GPU objetivo.

## Comprobaciones

Tipos, kits de fachada, separación de aleros (7/7) y build: correctos.

## Archivos

`src/environment/village.ts`; `scripts/environment/capture_focal_sites.mjs` añade la cámara reproducible `facade-ground`.

## Límites

El terreno oculta parte de la entrada de esta casa. Esta pasada conserva sus cotas y no aplana el relieve ni inventa escalones. Las casas GLB del piloto conservan sus zócalos actuales.
