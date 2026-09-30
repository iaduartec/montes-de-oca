# Pavimento de la plaza — 30-09-2026

Se redujo el contraste entre las cuatro variaciones de color de las losas procedurales de 1 m. La distribución, la huella OSM, el relieve, el encuentro con la calzada y la geometría permanecen iguales. Es una paleta estilizada, no una lectura de color medida de la plaza real.

## Comparación

`before/plaza.png` y `after/plaza.png` comparten cámara, terreno y carga normal de viales.

- Draw calls: 33 → 33.
- Triángulos: 794910 → 794910.
- Vértices: 1901807 → 1901807.
- Mallas: 33 → 33.
- Bytes GLB plaza: sin cambio (147352).

## Verificación

El generador focal reproduce GLB y manifest; el validador de hitos, TypeScript y build pasan. Chrome usa SwiftShader, así que los FPS no indican rendimiento de GPU objetivo.

## Observación pendiente

La franja clara entre asfalto y plaza sigue visible en la captura y no cambió con esta paleta. Su origen requiere una comprobación geométrica distinta; no la atribuyo a la textura de las losas.
