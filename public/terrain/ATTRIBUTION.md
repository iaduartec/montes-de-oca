# Atribución — Terreno (IGN MDT05)

El terreno de este proyecto (`public/terrain/tiles/*.json`) se deriva del
**Modelo Digital del Terreno de paso de malla 5 m (MDT05)** del Instituto
Geográfico Nacional (IGN) / Centro Nacional de Información Geográfica (CNIG),
obtenido vía el WCS INSPIRE `https://servicios.idee.es/wcs-inspire/mdt`
(coverage `Elevacion25830_5`).

- **Titular:** © Instituto Geográfico Nacional (IGN) / CNIG.
- **Licencia:** CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
- **Origen de los datos:** vuelo LiDAR PNOA (PNOA-LiDAR).
- **Sistema de referencia:** EPSG:25830 (ETRS89 / UTM zona 30N).
- **Ventana:** E [471500, 477500] · N [4689000, 4695000] (6000 × 6000 m).

La atribución es **obligatoria** al distribuir el juego o cualquier captura o
asset derivado. Texto sugerido:

> Modelo Digital del Terreno © Instituto Geográfico Nacional (IGN-CNIG),
> CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Datos PNOA-LiDAR.

El detalle de la descarga (URL exacta, SHA256 y dimensiones) está en
`data/terrain/raw/fetch_manifest.json`.

## Ortofoto PNOA Máxima Actualidad

La textura `orthophoto.webp` es una obra derivada de la ortofoto PNOA Máxima
Actualidad del mosaico de septiembre de 2023 (resolución oficial: 0,25 m),
recortada a EPSG:25830, remuestreada a 0,9765625 m/píxel y codificada como
WebP. La fórmula abreviada de atribución es:

> Obra derivada de PNOA 2023-09 CC-BY 4.0 scne.es.

- **Productores:** Instituto Geográfico Nacional (IGN) y Centro Nacional de
  Información Geográfica (CNIG).
- **Servicio/capa:** [WMS PNOA Máxima Actualidad](https://www.ign.es/wms-inspire/pnoa-ma),
  `OI.OrthoimageCoverage`; metadatos de fecha y resolución de `OI.MosaicElement`.
- **Licencia:** CC BY 4.0, compatible con la licencia de uso del IGN/CNIG:
  https://creativecommons.org/licenses/by/4.0/.
- **Procedencia, fechas por tesela y hashes:**
  `data/terrain/raw/pnoa_orthophoto/source_manifest.json` y
  `public/terrain/orthophoto.json`.

El reconocimiento abreviado sigue la fórmula indicada por la
[licencia de productos y servicios geográficos del IGN/CNIG](https://www.ign.es/resources/licencia/Condiciones_licenciaUso_IGN.pdf).

## Teselas 3D locales (3D Tiles 1.0)

El directorio `public/terrain/3d-tiles/` contiene un tileset generado de forma
determinista y offline por `scripts/terrain/build_3d_tiles.py` desde los 36
heightfields MDT05 ya publicados (`tiles/tile_*.json`):

- Jerarquía LOD `REPLACE` de dos niveles: la raíz lleva un resumen real de
  6 km muestreado a 40 m (`tiles/overview.glb`, 151 × 151 vértices desde los
  MDT05 existentes, sin relieve inventado ni datos de terceros) y los 36
  hijos son las hojas de 1 km a plena resolución (`tiles/tile_<ix>_<iz>.glb`,
  201 × 201 vértices). El `geometricError` de la raíz es la desviación
  vertical máxima medida de la superficie triangular del resumen contra cada
  muestra MDT05 de 5 m (ver `manifest.json`, campos `lod` y
  `overviewErrorM`); las hojas tienen `geometricError` 0.
- Las normales de bordes compartidos se calculan con diferencias centradas
  sobre el heightfield global cosido (ambos vecinos), de modo que los
  vértices de borde con igual altura tienen normales iguales; solo el borde
  exterior del mundo usa diferencias unilaterales.
- Cargas binarias GLB 2.0 autocontenidas (chunk JSON + chunk BIN, índices
  uint16, enlaces PBR de textura/material preservados). La ortofoto PNOA se
  referencia como imagen JPEG EXTERNA (`tiles/orthophoto.jpg`), derivada de las
  mismas cuadrantes fijadas que el atlas WebP y compatible con glTF básico;
  ningún GLB incorpora píxeles PNOA.
- La geometría de edificios OSM **no** está horneada en las teselas: sigue
  como capa separada del runtime con sus huellas/alturas existentes.
- Atribución aplicable a este derivado: MDT © IGN-CNIG CC BY 4.0 y obra
  derivada de PNOA 2023-09 CC-BY 4.0 scne.es, como se detalla arriba.
