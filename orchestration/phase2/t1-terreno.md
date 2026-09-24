# TASK PACKET T1 — FASE 2: DEM real de Villafranca → tiles de terreno jugables

## Estándares del proyecto (auto-resueltos)
- `/home/kiri_/projects/montes-de-oca` (motor GTA_SZ) es **READ-ONLY**.
- Proyecto propio: `/home/kiri_/projects/montes-de-oca-offroad`. Ahí va todo tu output.
- Documentación en **español** técnico.
- **No hagas commits git.** Nunca agregues `Co-Authored-By` ni atribución de IA.
- Si descubrís algo no obvio, guardalo en engram con `mem_save` y `project: "montes-de-oca"`.

## Contexto
Juego: **"Montes de Oca: Offroad Stories"**, mundo abierto rural en navegador (Vite + TypeScript +
Babylon.js) ambientado en **Villafranca Montes de Oca** (Burgos, España). Objetivo del MVP: cargar el
entorno real, aparecer cerca del pueblo, tener un 4x4 y conducirlo camino a los Montes de Oca.

Ya existe y **NO tenés que rehacer**:
- Esqueleto ejecutable en `src/`: `main.ts`, `terrain.ts`, `heightfield.ts`, `diagnostics.ts`, `config.ts`.
  Compila, renderiza y ya está validado. Leé `src/heightfield.ts` y `src/terrain.ts` **antes de tocar nada**.
- El esquema del heightfield ya es **idéntico** al del motor de referencia y está verificado:
  `{schemaVersion, id, grid:{x0,z0,dx,dz,columns,rows,heights[]}}`, `heights` en **metros**, orden
  fila-mayor (`heights[r*columns + c]`), y la interpolación con **split SW→NE** de cada celda.
  **NO cambies ese esquema ni esa interpolación**: hay datos y código de referencia que dependen de ella.
- Datos DEM ya descargados en `data/geo/raw/` (**sólo lectura para vos**):
  `mdt05_bbox_5m.tif` (1208×1196 @ 5 m, EPSG:25830), `mdt02_bbox_2m.tif` (3015×2981 @ 2 m),
  `dem_comparison.json`. **IGN MDT05 gana**: contra MDT02 el RMSE es 0,835 m; contra Copernicus
  GLO-30 es 6,8 m. Los `data/geo/raw/` los escribe OTRO worker: **no los modifiques**.

## GOAL
Que el juego cargue el **terreno real de Villafranca** desde el DEM del IGN y se pueda recorrer a pie de
cámara. Al terminar tiene que haber una captura de pantalla del terreno real del pueblo en pantalla.

## CONVENCIÓN DE COORDENADAS (fija, la decido yo — NO la reinterpretes)
Todo en **metros**. `worldScale = 1`: una unidad de mundo = un metro.

- **Proyección**: `EPSG:25830` (UTM 30N). Es la nativa del DEM: no reproyectes, sólo restá el origen.
- **Ventana a descargar**: `E=[471500, 477500]`, `N=[4689000, 4695000]` → exactamente **6000 × 6000 m**.
  Alineada a la grilla de tiles, así no hay tiles parciales. Contiene el pueblo (E=474597,3 / N=4692945,0).
- **Origen del mundo** = esquina SUDOESTE: `E0=471500`, `N0=4689000`.
  `worldX = E − 471500` · `worldZ = N − 4689000` · `worldY = elevación − verticalDatum`
  (X crece al **este**, Z crece al **norte**, Y arriba — Y-up, coincide con el esquema `heights`).
  El pueblo queda en `worldX=3097`, `worldZ=3945`.
- **`verticalDatum`**: `floor(min(elevación)/10)*10` del DEM descargado, calculado por vos y **documentado**.
  (Con lo ya medido ronda 890 m.) Restalo para que Y arranque cerca de 0 y no perdamos precisión de float.
- **Tiles**: `1000 × 1000 m` → **36 tiles** (6×6). Muestreo **5 m** = el nativo del MDT05 → **200 celdas**
  por lado, **201×201 = 40.401 vértices** por tile, **80.000 triángulos** por tile. Índices `u16`
  alcanzan (40.401 < 65.535): usalos.
  `x0`/`z0` de cada tile = esquina SW del tile en coordenadas de mundo; `heights` en metros **absolutos**
  (sin restar el datum dentro del grid — el datum se resta al construir la malla, y decilo en el doc).
- **NO usar el factor `102850`**: es de Shenzhen (lat 22,5°). Si necesitás lon/lat para el config,
  calculá los factores reales para lat 42,39° o dejá que el pipeline los derive. Ya hay placeholders
  marcados en `public/terrain/config.json`.

## Deliverables
| Archivo | Qué es |
|---|---|
| `scripts/terrain/fetch_dem_mdt05.py` | descarga el WCS del IGN con la ventana de arriba; guarda `data/terrain/raw/` + SHA256 + URL. Reproducible |
| `scripts/terrain/build_terrain_tiles.py` | GeoTIFF → 36 tiles JSON. Parametrizable (`--sampling`, `--tile-size`). Emite reporte de presupuesto |
| `data/terrain/raw/*.tif` | el DEM descargado (no reusar el de `data/geo/raw/`) |
| `public/terrain/tiles/**/*.json` | los 36 tiles con el esquema verificado |
| `public/terrain/config.json` | origen REAL, factores, datum, `worldScale:1`, lista de los 36 tiles |
| `public/terrain/ATTRIBUTION.md` | aviso **CC-BY 4.0 del IGN** (atribución obligatoria) |
| `public/terrain/budget.json` | medición: triángulos/vértices/MiB por tile y totales, y triángulos en vista por radio |
| `src/terrain.ts` | multi-tile + culling por distancia/frustum (ver abajo) |
| `docs/terrain/TERRAIN_FASE2.md` | qué hiciste, la convención, el presupuesto, y **qué NO quedó** |

## MÉTODO
1. Leé `src/heightfield.ts`, `src/terrain.ts`, `src/config.ts`, `public/terrain/config.json` y
   `data/geo/raw/dem_comparison.json`.
2. `fetch_dem_mdt05.py`: `GetCoverage` del WCS `https://servicios.idee.es/wcs-inspire/mdt` con la ventana
   exacta. Usá un `User-Agent` explícito. **El WCS del IGN ya está verificado sin registro ni auth**;
   si te pide credenciales, pará y reportalo (no inventes).
3. `build_terrain_tiles.py`: ventana con `rasterio`, verificación de CRS == EPSG:25830, conversión a
   tiles de 1000 m, escritura con el esquema exacto, y export del `budget.json`.
   **No interpoles ni remuestrees**: el muestreo es 5 m y el DEM es 5 m, tienen que coincidir 1:1.
   Si la grilla no calza exacta, reportalo — no rellenes con ceros ni con vecino más cercano en silencio.
4. Actualizá `src/terrain.ts` para cargar los 36 tiles desde el config y **cullar por distancia**
   (frustum + radio). El radio por defecto tiene que dejar **≤ 250.000 triángulos en vista**; verificá el
   número con el `budget.json` y documentá el radio elegido. A 5 m: πR²/25×2 triángulos ⇒ R≈1000 m da
   ~251 k. Elegí el radio y **mostrá la cuenta**.
5. `npm run typecheck` y `npm run build` tienen que pasar.
6. Levantá la app y **sacá screenshot** del terreno real. Si tenés Playwright, desde 2-3 posiciones
   distintas (incluida una mirando hacia los Montes de Oca). Si no está disponible, decilo.

## CONSTRAINTS
- **PROPIEDAD DE ARCHIVOS — es un proyecto con varios workers en paralelo.** Podés escribir **sólo** en:
  `scripts/terrain/**`, `data/terrain/**`, `public/terrain/**`, `src/**`, `docs/terrain/**`.
  **PROHIBIDO tocar**: `scripts/geo/**`, `data/geo/**`, `docs/geo/**`, `docs/audit/**`, `orchestration/**`.
- No toques el repo de referencia.
- Sólo estas deps: `@babylonjs/core`, `vite`, `typescript` (+ Python: `rasterio`, `numpy`, `pyproj` —
  usá el `.venv` del repo, ya los tiene). **No agregues dependencias nuevas.**
- No hagas commit.
- **No inventes resultados de validación.** Si el build falla, si no podés descargar, si la grilla no
  calza: decilo explícitamente.

## VALIDATION (es lo que decide si acepto el trabajo)
1. `npm run typecheck` + `npm run build` con salida real.
2. **Chequeo cruzado obligatorio**: elegí 5 puntos conocidos (el pueblo, 2 cumbres, 2 puntos bajos),
   y mostrá una tabla comparando la altura del DEM original contra `heightAt()` del juego en esas
   coordenadas. La diferencia debe ser **sub-métrica**. Si no lo es, hay un error de índice, de orden
   de filas o de datum: **encontralo antes de entregar**.
3. `budget.json` real, no estimado.
4. Screenshot(s) del terreno real, **o** declaración explícita de que no pudiste.

## RESPUESTA FINAL
Archivos creados · comandos exactos + salida · la tabla de los 5 puntos cruzados · el contenido del
`config.json` final · el presupuesto de triángulos · el radio de vista elegido con su cuenta ·
y **qué NO quedó hecho**.
