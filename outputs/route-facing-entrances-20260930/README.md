# Entradas hacia el vial — 30-09-2026

En las casas procedurales cercanas a la ruta, la entrada se coloca sobre la fachada que mira al punto de ruta más próximo. Su centro se proyecta sobre el frente y busca la posición más cercana que mantenga altura libre bajo el alero. Las casas fuera del radio de ruta conservan como referencia el punto de aparición. El zócalo/umbral acompaña la cota del terreno. No se añadieron caminos de acceso ni se alteró el relieve.

## Capturas

`before/facade-ground.png` y `after/facade-ground.png` comparten cámara. En la vista, el portón se desplaza hacia el lado de su fachada más próximo al vial, conserva el ancho y queda bajo el alero.

- Draw calls: 32 → 32.
- Triángulos: 795341 → 795697.
- Vértices: 1901095 → 1901807.
- Mallas activas: 32 → 32.

## Comprobaciones

TypeScript, kits de fachada, aleros (7/7) y build correctos. Captura principal con Chrome/SwiftShader; sus FPS no se presentan como rendimiento de GPU objetivo.

## Alcance

Solo cambia la colocación de los detalles procedurales de puerta/portón y la prioridad de punto de referencia para edificios próximos a la ruta. Las entradas concretas no están contrastadas con fotografías de fachada y siguen siendo una reconstrucción artística.
