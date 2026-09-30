# Borde plaza-calzada — 30-09-2026

El generador ya recorta el pavimento contra el perfil exterior variable publicado para el OSM way 741760074. La vía mide 5 m de ancho; su perfil tiene 3.1 m en un lado y llega a 2.829 m en el otro junto a edificios. La plaza termina 2 cm dentro del faldón visual de la carretera, con una elevación de pavimento 1 cm por encima de ese faldón para tapar juntas de rasterización. El asfalto de rodadura y las colisiones siguen siendo propiedad de la capa vial.

La banda clara todavía se ve en la captura. El contexto de ortofoto PNOA del terreno (`orthophoto-context.png`, cobertura licenciada CC BY 4.0 según `public/terrain/orthophoto.json`) también muestra un borde claro junto a esa calzada. Por ello se conserva visible; no se afirma que sea un hueco geométrico. La ortofoto justifica la lectura en planta, no detalles verticales.

## Comparación

`before/plaza.png` y `after/plaza.png` comparten cámara y paleta de losas. Draw calls: 33 → 33; triángulos de escena: 794910 → 794930 (+20); vértices: 1901807 → 1901843 (+36); mallas: 33 → 33.

El GLB pasa de 147352 B / 2410 triángulos a 148624 B / 2430 triángulos. La geometría agregada corresponde al perfil recortado en celdas de 1 m.

## Verificación

Validador de hitos, reproducibilidad Blender, TypeScript y build correctos. La captura usa Chrome/SwiftShader; no representa FPS de la GPU objetivo.

## Archivos

`scripts/environment/build_focal_sites.py`, `src/environment/village-landmarks.ts`, `public/village/focal-sites/plaza.glb` y `public/village/focal-sites/manifest.json`.
