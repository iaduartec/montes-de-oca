# Piloto de casas: Villafranca de Montes de Oca

## Alcance y fuente

El piloto modela ocho casas de la calle visible desde el spawn. Conserva las huellas OSM y la ubicación; los muros se apoyan en `terrain.heightAt` y sus alturas usan el grid LiDAR ya versionado. `public/village/pilot-houses.json` registra medidas, muestra LiDAR, hash/tamaño del GLB y procedencia.

| Way OSM | Etiqueta disponible | Plantas OSM | Huella | Altura muro LiDAR | Muestras LiDAR | Perfil visual |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| [474364247](https://www.openstreetmap.org/way/474364247) | `house` | 2 | 124,2 m² | 5,00 m | 20 | piedra, teja, chimenea |
| [474364248](https://www.openstreetmap.org/way/474364248) | `residential` | 2 | 124,3 m² | 5,00 m | 19 | teja, chimenea |
| [818885678](https://www.openstreetmap.org/way/818885678) | `residential` | 2 | 24,4 m² | 6,29 m | 4 | volumen estrecho, teja |
| [1509797545](https://www.openstreetmap.org/way/1509797545) | `residential` | 2 | 204,2 m² | 4,00 m | 33 | volumen ancho, revoco/teja |
| [1509797544](https://www.openstreetmap.org/way/1509797544) | `residential` | 2 | 108,1 m² | 4,24 m | 17 | revoco/teja |
| [305647007](https://www.openstreetmap.org/way/305647007) | `house`, Calle Mayor | 2 | 97,7 m² | 7,10 m | 18 | piedra, teja, chimenea |
| [310458426](https://www.openstreetmap.org/way/310458426) | `residential`, Calle Mayor 51 | 3 | 108,9 m² | 5,73 m | 16 | volumen de tres plantas, piedra/teja |
| [433198559](https://www.openstreetmap.org/way/433198559) | `residential` | 3 | 81,6 m² | 6,09 m | 15 | volumen de tres plantas, teja |

Las etiquetas de fachada, cubierta, colores y material son decisiones de arte/procedimiento; OSM no proporciona material de fachada para estas casas. Las alturas mostradas son las lecturas P95 del MDSnE menos la subida low-poly de cubierta. La casa pequeña de 818885678 justo alcanza el mínimo configurado de cuatro muestras. El asset declara sus fachadas como **reconstrucción estilizada aproximada**: no se encontraron fotos reutilizables de fachadas individuales.

## Corrección desde ortofoto PNOA 2023

La ortofoto oficial PNOA 2023 (PNOA MA 2023, vuelo de 2023 para Castilla y León, GSD 35 cm, IGN/CNIG CC BY 4.0) se usó como evidencia de planta y cubierta. El registro por objetivo, con URL, fecha, licencia, huella WGS84 y la discrepancia observada, está en [`assets/environment/real-structures/evidence.json`](../../assets/environment/real-structures/evidence.json) y lo valida `node scripts/environment/validate_real_structure_evidence.mjs --phase=source`.

- **Corregidas (2):** 474364247 y 474364248. Ambas son casas casi cuadradas (half_u/half_v ≈ 1,06–1,07) que caían en la rama hip compacta (pirámide de un solo ápice); la ortofoto muestra un faldón **a dos aguas** con cumbrera larga sobre el eje de la huella. `build_village_pilot.py` las fuerza con `PNOA_GABLE_IDS` y el manifiesto publica `roofShape` y `ridgeAzimuthDeg`.
- **Blockers (6):** 818885678, 1509797545, 1509797544, 305647007, 310458426, 433198559. La cubierta a dos aguas actual ya coincide en planta y eje con la ortofoto a 0,35 m/px; no se demuestra una discrepancia atribuible al asset, así que **no se reclama edición** y quedan registradas como release blockers.

Las vistas antes/después reproducibles se generan fuera del repositorio bajo `output/real_structures/model/` (render cenital del GLB alineado al mismo bbox que la ortofoto).

## Arte y runtime

- Fuente editable: `assets/environment/village-pilot/village-pilot.blend`; ocho objetos independientes nombrados por Way OSM.
- Export: `public/village/pilot-houses.glb`, una malla combinada con color por vértice, 1.945 triángulos y 195.892 bytes (antes de la corrección de cubiertas: 1.867 triángulos y 182.384 bytes).
- El loader de `@babylonjs/loaders` comparte la versión 8.56.2 con `@babylonjs/core`. El pueblo mantiene sus grupos procedurales para las otras 322 casas; si una candidata se descarta por el radio de despeje o el GLB falla, las ocho vuelven a la ruta procedural.
- El asset no altera terreno, caminos, vehículo, misión, controles, UI ni colisiones. No se genera una malla por detalle; el GLB completo cuenta como una malla/draw call.
- Regeneración: `/usr/bin/blender --background --factory-startup --python scripts/environment/build_village_pilot.py`; validación: `npm run test:village-pilot`.

Para ampliar el pueblo, mantener modelos singulares solo para hitos visibles; representar las otras casas con kits compartidos de tejado, huecos, contraventanas y chimeneas, agrupados por material como ahora. Asociar la variante a cada ID OSM y conservar las huellas y alturas de runtime.

## Referencias, atribución y límites

- Huellas y etiquetas: snapshot OSM del 2026-09-25, derivados de OpenStreetMap, ODbL 1.0; atribución y consulta en `data/gameplay/raw/osm_buildings_villafranca_manifest.json`.
- Alturas: IGN/CNIG PNOA-LiDAR MDSnE primera cobertura, 2,5 m, CC BY 4.0; metadatos y hashes en `data/gameplay/raw/ign_mdsn_e025_villafranca_manifest.json`.
- Para contraste de cubierta, huella y contexto, usar manualmente el [comparador oficial de ortofotos PNOA](https://pnoa.ign.es/pnoa-lidar/visualizadores-y-servicios-web). No se incorporaron sus capturas, tiles ni geometría al juego.
- La foto [Villafranca-Montes de Oca](https://commons.wikimedia.org/wiki/File:Villafranca-Montes_de_Oca.jpg), de Thomas Holbach, está publicada bajo CC BY-SA 4.0 y solo sirve como referencia panorámica de contexto; no documenta las fachadas piloto y no se empaquetó en el juego.
- Google Maps/Earth no se usó como fuente de geometría ni se extrajo material suyo.

## Capturas

Las comparativas reproducibles se guardan fuera del repositorio, bajo `output/pilot-before/` y `output/pilot-after/`: spawn/calle, vista aérea y fachada cercana. `village_captures.json` incluye el coste medido y auditoría. Chrome headless/SwiftShader sirve para comparar draw calls y triángulos, no para afirmar FPS de hardware móvil.

En la vista de calle, antes: 14 draw calls y 16.271 triángulos del pueblo; después: 15 draw calls y 17.003 triángulos (+1 llamada, +732 triángulos). El asset suma 182.384 bytes descargados una vez. El pueblo completo pasa de 10 a 11 mallas y de 16.344 a 17.076 triángulos. No se midió un dispositivo móvil físico; FPS/frame time de SwiftShader no representan escritorio ni móvil.
