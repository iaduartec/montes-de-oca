# TERRAIN FASE 2 — DEM real de Villafranca → tiles jugables

TASK PACKET T1. El juego carga el terreno real de **Villafranca Montes de Oca**
(Burgos) desde el **MDT05 del IGN** (5 m, PNOA-LiDAR) y se puede recorrer a pie de
cámara. Al final hay capturas del terreno real (`output/terrain_*.png`).

## 1. Convención de coordenadas (fija — no se reinterpreta)

Todo en **metros**, `worldScale = 1` (una unidad de mundo = un metro).

- **Proyección:** EPSG:25830 (ETRS89 / UTM 30N). Es la nativa del DEM: no se
  reproyecta, sólo se resta el origen.
- **Ventana de mundo:** `E = [471500, 477500]` · `N = [4689000, 4695000]` →
  6000 × 6000 m, alineada a la grilla de tiles (sin tiles parciales). Contiene el
  pueblo, que cae en `E=474597.3 / N=4692945.0`.
- **Origen del mundo** = esquina SW: `E0 = 471500`, `N0 = 4689000`:
  - `worldX = E − 471500` (crece al este)
  - `worldZ = N − 4689000` (crece al norte)
  - `worldY = elevación − verticalDatum` (Y arriba)
  - El pueblo queda en `worldX = 3097`, `worldZ = 3945`.
- **`verticalDatum` = floor(min(elevación)/10)·10 = 870 m** (min del DEM = 870,
  max = 1194). Se resta al construir la malla y al devolver `heightAt`, para que Y
  arranque cerca de 0 sin perder precisión de float. **Los `heights` del grid
  quedan en metros ABSOLUTOS** (sin restar el datum), tal como pide el packet.
- **Tiles:** 1000 × 1000 m → **36 (6×6)**. Muestreo 5 m (nativo del MDT05) → 200
  celdas por lado → **201×201 = 40.401 vértices** y **80.000 triángulos** por tile.
  Índices `u16` (40.401 < 65.535).

## 2. Descarga del DEM (`scripts/terrain/fetch_dem_mdt05.py`)

WCS 2.0.0 del IGN: `https://servicios.idee.es/wcs-inspire/mdt`, coverage
`Elevacion25830_5`, `format=image/tiff`, con `User-Agent` explícito. **No pide
registro ni credenciales** (verificado, HTTP 200).

### Hallazgo no obvio: el WCS devuelve `[min, max)`

`subset=x(min,max)` a resolución nativa devuelve `(max−min)/res` **muestras**
(intervalo semiabierto), no `+1` nodos. Pedir 6000 m devuelve 1200 muestras; los
201 nodos por tile exigen **1201 nodos inclusivos**. Por eso la descarga pide una
celda extra al este y al sur:

- Ventana de mundo: `x(471500, 477500)` · `y(4689000, 4695000)`
- Ventana WCS pedida: `x(471500, 477505)` · `y(4688995, 4695000)` → **1201×1201**

El raster resultante tiene origen en el nodo (convención "corner registration",
`AREA_OR_POINT=Area`) y `values[row, col]` = nodo
`(471500 + col·5, 4695000 − row·5)`. Esto se verificó empíricamente contra el
MDT05 de FASE 1 (`data/geo/raw/mdt05_bbox_5m.tif`): **1.294.944 px de solape,
diferencia máxima 0 m** (misma fuente).

> Nota: ese TIFF de FASE 1 tenía su borde norte en N=4694740, **por debajo** de la
> ventana pedida (N hasta 4695000). Por eso esta fase descarga su propio DEM en
> `data/terrain/raw/`; no reutiliza `data/geo/raw/`.

Resultado: `data/terrain/raw/mdt05_villafranca_6000m_5m.tif` int16, EPSG:25830,
1201×1201, **SHA256** `d6c64e64…a6fd02`, `fetch_manifest.json` con URL/SHA/ventana.

## 3. Tiles y `config.json` (`scripts/terrain/build_terrain_tiles.py`)

Parametrizable (`--sampling`, `--tile-size`, `--dem`). Lee el raster, exige CRS
EPSG:25830, verifica la alineación exacta del origen (si no calza, **aborta**: no
rellena con ceros ni vecino más cercano), recorta 36 bloques invirtiendo el orden
de filas (el raster crece al sur, el heightfield al norte) y escribe el esquema
verificado `{schemaVersion:1, id, grid}` con `heights` fila-mayor.

- Tiles: `public/terrain/tiles/tile_<ix>_<iz>.json` (36), esquema idéntico al motor
  de referencia. `x0`/`z0` = esquina SW en coords de mundo; interpolación SW→NE
  intacta.
- `config.json`: origen real en WGS84 (esquina SW), factores grados→metros
  calculados con `pyproj.Geod` a la latitud del centro, `worldScale:1`,
  `verticalDatum:870`, `viewRadius:900`, `crs`, `bounds`, `spawn` (pueblo en
  WGS84) y la lista de los 36 tiles.

## 4. Presupuesto real (`public/terrain/budget.json`)

Medido sobre los archivos escritos y verificado con la app (no estimado):

| Métrica | Por tile | Total |
|---|---|---|
| Vértices | 40.401 | 1.454.436 |
| Triángulos | 80.000 | 2.880.000 |
| JSON en disco | ~188 KiB (prom.) | 6,61 MiB |
| Malla runtime (pos+norm+color+uv f32 + índices u16) | ~2,3 MiB | ~83,1 MiB |

### Radio de vista: 900 m

- Cuenta continua del packet: `π·R²/25·2` a **R=900 → 203.575 tris** (< 250.000).
- **Conteo real** (AABB exacto vs frustum de Babylon portado a Python y
  **verificado contra la app**): vista por defecto (al frente) **3 tiles =
  240.000 tris ≤ 250.000**.
- Peor caso simultáneo (cámara en una esquina de 4 tiles, inevitable con tiles de
  1000 m: el pueblo está a ~95 m de una esquina) = 4 tiles = **320.000 tris**. Se
  documenta abajo en "qué NO quedó".

Medido en la app (Chrome headless + CDP, HUD de Babylon) en `budget.medido_en_app`:

| Vista | Cámara (x,y,z) | Triángulos en vista |
|---|---|---|
| `terrain_default` (spawn pueblo, mirando al norte) | 3083, 175, 3919 | **240.000** |
| `terrain_montes` (pueblo → norte) | 3097, 190, 3450 | 240.000 |
| `terrain_sierra` (sierra alta, aérea) | 1150, 600, 1150 | 240.000 |
| `terrain_pueblo` (pueblo desde el SO) | 2750, 210, 3350 | 320.000 |

## 5. Chequeo cruzado DEM ↔ `heightAt()` (sub-métrico)

5 puntos: el pueblo, 2 cumbres y 2 puntos bajos. Se compara el DEM original
(interpolación SW→NE sobre la grilla de nodos del raster) contra el `heightAt()`
**real** del juego: `src/heightfield.ts` se transpila con el `typescript` del
proyecto y se ejecuta en Node (`scripts/terrain/crosscheck_heights.mjs`), sin
dependencias nuevas. Salida completa en `docs/terrain/crosscheck.json`.

| Punto | E | N | Tile | DEM (m) | Juego (m) | Δ (m) |
|---|---|---|---|---|---|---|
| pueblo_villafranca | 474597.3 | 4692945.0 | tile_3_3 | 944.548 | 944.548 | **0.000000** |
| cumbre_max | 471665.0 | 4689000.0 | tile_0_0 | 1194.000 | 1194.000 | **0.000000** |
| cumbre_secundaria | 473170.0 | 4692840.0 | tile_1_3 | 1126.000 | 1126.000 | **0.000000** |
| punto_bajo_min | 477490.0 | 4695000.0 | tile_5_5 | 870.000 | 870.000 | **0.000000** |
| punto_bajo_secundario | 474820.0 | 4693495.0 | tile_3_4 | 927.000 | 927.000 | **0.000000** |

Diferencia máxima absoluta: **0 m** (el criterio es submétrico). Además,
`budget.cruces_dem_tiles_diff_max_m = 0` valida DEM vs tile publicado.

## 6. Runtime (`src/terrain.ts`, `src/config.ts`, `src/main.ts`)

- `config.ts` parsea `verticalDatum`, `viewRadius` y `spawn` (opcionales; el motor
  sigue sin números de Villafranca: todo entra por JSON).
- `terrain.ts` carga los 36 tiles, construye las mallas con un **material
  compartido**, colores normalizados al rango **global** (sin costuras entre
  tiles) e índices `u16`. `heightAt`/`normalAt` resuelven el sampler del tile (o el
  más cercano fuera de cobertura).
- **Culling** por frame (`cull(camera)`): cada tile se activa/desactiva con
  `setEnabled` si su **AABB** está a ≤ `viewRadius` y pasa el **frustum** (test
  AABB-vs-planos, más fino que la esfera envolvente de Babylon).
- `main.ts`: cámara inicial en el `spawn` (pueblo) mirando al norte; acepta
  `?px&py&pz&tx&ty&tz` para capturas reproducibles; el HUD muestra triángulos y
  "en vista".

## 7. Cómo reproducir

```bash
.venv/bin/python scripts/terrain/fetch_dem_mdt05.py          # descarga + SHA256 + manifest
.venv/bin/python scripts/terrain/build_terrain_tiles.py      # 36 tiles + config + budget + attribution
node scripts/terrain/crosscheck_heights.mjs                  # chequeo DEM vs heightAt real
npm run typecheck && npm run build
npm run preview &                                            # sirve dist
node scripts/terrain/capture_terrain.mjs                     # capturas + medición real (CDP)
```

`public/terrain/ATTRIBUTION.md` contiene el aviso **CC BY 4.0 del IGN/CNIG**
(atribución obligatoria).

## 8. Qué NO quedó hecho

1. **Presupuesto exacto ≤ 250.000 en el peor caso.** Se cumple en la vista por
   defecto (240.000) y en cualquier vista de 3 tiles, pero en una esquina de 4
   tiles el frustum incluye 4 tiles = 320.000. Con tiles de 1000 m y 5 m sin LOD
   es imposible bajarlo: incluso 1 solo tile son 80.000 y la geometría de esquina
   hace coinvisibles 4. **Fix propuesto** (fuera del alcance de este packet):
   subdividir cada tile en 4 sub-mallas de 500 m (mismo dato y muestreo, sólo
   granularidad de culling) o un LOD de malla (5 m cerca / 20 m lejos) manteniendo
   el heightfield de 5 m para la física.
2. **Streaming / carga diferida.** Los 36 tiles se cargan en memoria al arrancar
   (~83 MiB de malla). No hay carga/descarga dinámica por cercanía; sólo culling
   de visibilidad. Es el siguiente paso natural.
3. **LOD geométrico / impostores.** No hay (se usa la malla full-res en todo el
   radio de vista).
4. **Texturas y materiales de terreno.** Sólo color por vértice; no hay texturas
   satélite/ortofoto ni blending por pendiente.
5. **Física / vehículo 4x4.** Fuera del alcance; `sampleHeight` queda listo para
   física. La cámara es libre (vuela con WASD/mouse).
6. **Árboles, edificios, pistas OSM.** No incluidos en este packet (solo DEM).
7. **Datum geodésico vs hipsométrico.** El `verticalDatum` es una resta de
   precisión de float (`floor(min/10)*10`), **no** una compensación de geoide
   EGM2008→ETRS89. Las alturas son las del MDT05 tal cual.

## 9. Confianza

- **Verificado con ejecución:** descarga WCS (HTTP 200, 1201×1201), SHA256,
  solape 0 contra el MDT05 de FASE 1; `build` y `typecheck` OK; chequeo cruzado
  `heightAt()` real con Δ=0; screenshots reales.
- **Verificado por contraste:** el conteo de tiles en vista del `budget.json`
  (port del frustum) coincide con el HUD real de la app (240.000/320.000).
- **Limitación conocida:** el presupuesto ≤250k sólo se garantiza en vistas de 3
  tiles; el peor caso de esquina (320k) está documentado y cuantificado.
