# 02 — Pipeline de datos y terreno (OSM → ciudad → terreno → runtime)

Repo referencia: `/home/kiri_/projects/montes-de-oca` (READ-ONLY, no modificado). Juego separado: Montes de Oca Offroad (Villafranca Montes de Oca, Burgos).
Todas las citas son `archivo:línea` del repo referencia. Lo no verificado se marca `UNKNOWN`.

## 1. Cadena completa (etapa → entrada → salida → script)

| # | Etapa | Entrada | Salida | Script |
|---|-------|---------|--------|--------|
| 1 | Descarga snapshot Geofabrik + manifiesto | `https://download.geofabrik.de/asia/china/guangdong-latest.osm.pbf` (`download_osm.py:11`) | `data/raw/guangdong.osm.pbf` + `guangdong.manifest.json` + `.md5` (`download_osm.py:12,59-60`) | `scripts/download_osm.py:11-60` |
| 2 | Extracción a GeoJSON por capas | `data/raw/guangdong.osm.pbf`, `config/regions.json` (`extract_city.py:108,19`) | `data/processed/<region>/{roads,buildings,green,water,coastline,railways,pois}.geojson` + `coverage_report.json` + `landmarks.json` (`extract_city.py:154-169`) | `scripts/extract_city.py:107-170` |
| 3 | Validación | `coverage_report.json`, GeoJSON, `guangdong.manifest.json` (`validate_data.py:8,12,22`) | `artifacts/data_validation.json` (`validate_data.py:28`) | `scripts/validate_data.py:1-30` |
| 4 | Ciudad jugable comprimida (WGS84→XZ, filtrado vial, anchos) | `data/processed/shenzhen_study/*.geojson` (`prepare_driving_city.py:15`) | `public/city/city.json` + `public/city/metadata.json` (`prepare_driving_city.py:110-111`) | `scripts/prepare_driving_city.py:11-112` |
| 5 | Superficies de suelo (triangulación plana) | `public/city/city.json` (`prepare_city_ground.py:6`) | `public/city/ground-surfaces.json` (`prepare_city_ground.py:16`) | `scripts/prepare_city_ground.py:6-16` |
| 6 | Superficies viales + mobiliario | `public/city/city.json` (`prepare_city_streets.py:9`) | `public/city/street-surfaces.json`, `lamps.json`, `pedestrian-paths.json`, `street-validation.json`; reescribe `spawn` en `city.json` (`prepare_city_streets.py:64-72`) | `scripts/prepare_city_streets.py:9-73` |
| 7 | Grafo de navegación | `public/city/city.json` (`node_city_roads.py:4`) | `public/city/navigation.json` (`node_city_roads.py:15`) | `scripts/node_city_roads.py:4-15` |
| 8 | Terreno DEM real, parche Lianhuashan | Copernicus DSM `Copernicus_DSM_COG_10_N22_00_E114_00_DEM.tif` (`prepare_landmark_terrain.py:25-26`) + `city.json` + `green.geojson` (`prepare_landmark_terrain.py:79-88`) | `public/city/terrain-detail.json` + `data/landmarks/lianhua.json` (`prepare_landmark_terrain.py:212-213`) | `scripts/prepare_landmark_terrain.py:41-214` |
| 9 | Relieve montañoso regional (DSM filtrado) | `city.json`, `landmark-detail.json`, `terrain-detail.json`, 2 tiles Copernicus (`prepare_city_mountains.py:18,38-39`) | `public/city/mountain-relief/{heights.bin,near-heights.bin,manifest.json,near-manifest.json}` (`prepare_city_mountains.py:72,94`) | `scripts/prepare_city_mountains.py:21-94` |
| 10 | Relieve autoral de césped (CANDIDATO, no survey) | `city.json`, `terrain-detail.json`, `landmark-detail.json`, `ground-surfaces.json`, `street-surfaces.json` (`prepare_city_ground_relief.py:36`) | `artifacts/city/grassland-v2-candidate/{relief-mesh.bin,ground-cover.png,meadow.json,manifest.json,visual-cases.json}` (`prepare_city_ground_relief.py:217,235,274,301,304`) — copiar a `/city/ground-relief/` al integrar (`city-ground-relief.ts:69`) | `scripts/prepare_city_ground_relief.py:1-310` |
| 11 | Malla terreno base (Blender) | `ground-surfaces.json` + `city.json` (`build_city_ground.py:5`) | Malla `terrain` vía `city_mesh.export` + `terrain-manifest.json` + `coast-and-ground.blend` (`build_city_ground.py:18`) | `scripts/build_city_ground.py:5-18` |
| 12 | Consumo runtime (apilado de alturas) | `/city/city.json`, `landmark-detail.json`→`terrain-detail`, `mountain-relief/`, `ground-relief/` | `groundHeight = base(0) + landmark + mountains + relief + coastal` (`city-world.ts:250`) | `src/city-world.ts:250`, `src/landmark-details.ts:33-65`, `src/city-mountains.ts:16-63`, `src/city-ground-relief.ts:14-35,71-82` |

Notas:

- Descarga con presupuesto 250 MiB, verificación MD5/SHA256 y manifiesto con licencia ODbL (`download_osm.py:13,25-59`).
- Extracción usa `osmium` + `KeyFilter('highway','building','building:part','natural','landuse','leisure','waterway','railway','amenity','tourism','name')` (`extract_city.py:115-117`); ensambla multipolígonos con `WKBFactory` (`extract_city.py:28,87,102`); nunca inventa altura (`extract_city.py:1,43-47,123`).
- `study` usa clip completo, regiones recortan (`extract_city.py:139-143`); carreteras recortadas son referencia geométrica, no grafo navegable (`extract_city.py:124`).

## 2. Esquema runtime (`src/city-types.ts:1-4`)

```ts
Road = { id, name, displayName?, kind, width, oneway, points: V2[], grade }
buildings[] = { rings: V2[][], height, style }            // + heightSource/seed/id/name en el JSON real (prepare_driving_city.py:93), no tipados en city-types.ts:3
green[]/water[] = { rings: V2[][], name }
land: V2[][][]; coast: V2[][]; landmarks[] = { id,name,x,z,height,area,excludeRadius,arrival,yaw,... }
meta = { counts, extent, horizontalScale }               // + bboxWGS84, originWGS84, verticalScale, coordinateSystem en metadata.json (prepare_driving_city.py:108)
```

Unidades (`prepare_driving_city.py:12,108`; `prepare_landmark_terrain.py:83-84`):

- Plano XZ en **unidades de juego = metros reales × 0.60** (`SCALE=.60`).
- Alturas de edificios y relieve también en unidades de juego (`height*SCALE`, `prepare_driving_city.py:65,80-84`; `prepare_landmark_terrain.py:147`).
- Puntos redondeados a 2 decimales (`prepare_driving_city.py:21`); alturas de grid a 3 decimales (`prepare_landmark_terrain.py:148`).
- Base ciudad plana = 0 fuera de parches (`landmark-details.ts:33-36,65`; `prepare_city_ground_relief.py:303` declara `real metres * 0.60; additive to established base height`).
- Procedencia: cotas OSM `height`/`building:levels` marcadas `tagged_unverified`/`levels_only_unverified`/`unknown`, resto `typology_estimate` aleatorio por semilla (`extract_city.py:43-47`; `prepare_driving_city.py:79-84`). **Nunca tratar como medido.**

## 3. Coordenadas

- Conversión juego: `project(x,y) = ((x-ORIGIN[0])*102850*SCALE, (y-ORIGIN[1])*111320*SCALE)` (`prepare_driving_city.py:14`), con `ORIGIN=[114.025,22.536]` y `BBOX=[113.915,22.497,114.135,22.575]` hard-codeados (`prepare_driving_city.py:12`). Idéntica lambda en `refine_city_layout.py:8` y `prepare_landmark_terrain.py:84` (con `assert scale==verticalScale==.6`, `prepare_landmark_terrain.py:83`); montañas usa divisores equivalentes `61710/66792 = 102850*0.6 / 111320*0.6` (`prepare_city_mountains.py:37`).
- Modelo: **equirectangular aproximado a latitud de Shenzhen**, declarado en metadatos (`prepare_driving_city.py:108`: `'local east/north; equirectangular at Shenzhen latitude, metres scaled 0.60'`).
- **Sin pyproj/EPSG en la ruta a `city.json`.** `pyproj.Transformer(4326→32649)` sólo se usa para estadística de km de `cycleway` (`extract_city.py:21,164-165`). `rasterio.reproject` + `warp` sólo aparecen en montañas para remuestrear el DSM al grid local (`prepare_city_mountains.py:38-42`).
- Inversa para muestreo DSM: `inverse(x,z) = (x/(102850*scale)+origin[0], ...)` (`prepare_landmark_terrain.py:85`).
- Consecuencia rural: origen, BBOX, factores 102850/111320 (válidos ~22.5°N) y `SCALE` están **hard-codeados por script**; hay que parametrizarlos (a 42.38°N los metros/grado cambian) o pasar a proyección métrica real (UTM 30N / EPSG:25830).

## 4. Clasificación vial (crítico off-road)

Whitelist de mundo conducible (`prepare_driving_city.py:31`):

```
allowed = { trunk, primary, secondary, tertiary, residential, unclassified,
            service, trunk_link, primary_link, secondary_link, tertiary_link }
```

- Filtros: fuera de `allowed` se descarta; `access in {private,no}` o `motor_vehicle==no` se descarta (`prepare_driving_city.py:35`).
- Anchos: `lanes*3.0` clamp `[5.8,16]`; `service=4.5` (`prepare_driving_city.py:39-42`). `kind` = valor `highway` original, `grade` = tag `layer` (`prepare_driving_city.py:46`). Nombres por defecto `'支路'` (`prepare_driving_city.py:46`).
- Marcas/luces/aceras sólo para `trunk/primary/secondary/tertiary` (`prepare_city_streets.py:18,30-34,36`); resto sin señalización.
- **`track`, `path`, `footway`, `cycleway`, `steps`, `pedestrian`: NO entran a `city.json`.** `track` ni siquiera aparece en la whitelist (`prepare_driving_city.py:31`); montañas los excluye explícitamente de la reserva de firmes (`prepare_city_mountains.py:28`: `r['kind'] not in ['footway','cycleway','path','steps','pedestrian','track']`).
- Excepción local: dentro del parque Lianhuashan, `highway in (path,footway,steps)` del GeoJSON se convierte en senderos drapeados `width=1.6*scale`, sobreelevados `+.12` (`prepare_landmark_terrain.py:171-185`), y `service` que cruce el parque se drapea sobre el heightfield (`prepare_landmark_terrain.py:160-169`).
- **`tracktype`, `surface`, `smoothness`, `access` (más allá del filtro), `width`, `lanes` (más allá del conteo), `trail_visibility`, `sac_scale`, `mtb:scale`: sin soporte.** Grep en `scripts/` no muestra lecturas de `tracktype|surface|smoothness` para lógica vial; `surface` sólo aparece en sentido material/render, y `track` sólo en exclusiones y nombres (`prepare_city_mountains.py:28`; `prepare_landmark_terrain.py:173`). Estado: **no soportado → REWRITE parcial obligatorio.**

## 5. Terreno: ¿DEM real o autoral?

Hay **tres capas distintas**, no un único heightfield:

| Capa | Naturaleza | Resolución / método | Consumo |
|------|-----------|---------------------|---------|
| Base ciudad | Plano **0** (prototipo aplanado a propósito: `"Roads are deliberately flattened"`, `prepare_driving_city.py:1-3`) | N/A | `terrainHeight` retorna 0 fuera del parche (`landmark-details.ts:33-36`) |
| `terrain-detail.json` (Lianhuashan) | **DSM real filtrado**: Copernicus GLO-30 30 m (`prepare_landmark_terrain.py:1-6,25-29,73`), interpolación bilineal a malla de **15 m reales = 9 unidades juego** (`prepare_landmark_terrain.py:91-92`), resta de datum = percentil 25 del borde (`prepare_landmark_terrain.py:124-126`), blends 55 m borde / 30 m viales / 20 m lago (`prepare_landmark_terrain.py:204`), sin exageración vertical (`prepare_landmark_terrain.py:205`) | Grid `{x0,z0,dx,dz,columns,rows,heights}` (`prepare_landmark_terrain.py:148`); stats con `sourceRangeMeters`, `realReliefMeters` (`prepare_landmark_terrain.py:187-191`) | `terrainHeight()` interpola baricéntrica con split SW→NE (`landmark-details.ts:33-42`); `loadLandmarkDetails` valida schema y dimensiones (`landmark-details.ts:55-56`) |
| `mountain-relief/` | **DSM real + césped autoral mezclado**: remuestreo `reproject` bilineal de 2 tiles (`prepare_city_mountains.py:38-42`), `grey_opening(3,3)+gaussian(.8)` (`prepare_city_mountains.py:44`), `relief=max(0,h-20)*.60` (`prepare_city_mountains.py:47`), blend 90/180 m (`prepare_city_mountains.py:48`), más `lawn` senoidal autoral (`prepare_city_mountains.py:51-53`) | `step=12` (near) / `36` (far) unidades juego = **20 m / 60 m reales** (`prepare_city_mountains.py:22,90`); techo 260k tris (`prepare_city_mountains.py:80`) | `loadMountainRegion` apila `base+delta+offset` (`city-mountains.ts:36,57-63`) |
| `ground-relief` (grassland v2) | **100% autoral/placeholder**: `"these slopes are authored landscape, not survey data"` (`prepare_city_ground_relief.py:4-5`); montículos gaussianos `peak ≤2.15` + relajación de pendiente (`prepare_city_ground_relief.py:108-109,195-200`) | Malla teselada `step 4/6/8`, chunks 1280, `lookupCellSize 32` (`prepare_city_ground_relief.py:123-145`); macro `ground-cover.png 2048×1024` (`prepare_city_ground_relief.py:223`) | `createReliefHeightSampler` suma `base+delta`, respeta `preservedBounds` (`city-ground-relief.ts:14-35`); `surfaceOffset .012` (`prepare_city_ground_relief.py:303`) |

- **¿Acepta DEM arbitrario?** El patrón de `prepare_landmark_terrain.py` + `prepare_city_mountains.py` es reutilizable (ventana rasterio, bilineal, datum, blends, preservación), pero está **atado a Shenzhen**: tile IDs Copernicus N22/E113-114 (`prepare_landmark_terrain.py:25`; `fetch_coastal_dsm.py:6`), SHA fijos (`fetch_coastal_dsm.py:6-9`), `green way/41281446` como boundary (`prepare_landmark_terrain.py:87-88`), datum 20 m (`prepare_city_mountains.py:47`), extent fijo (`prepare_city_mountains.py:22`). Para IGN hay que parametrizar CRS (UTM 30N), tile, datum y máscara. Veredicto parcial en §8.
- Resolución útil rural: el precedente máximo es 15 m reales (Lianhua); montañas near llega a 20 m reales. Un 6×6 km a 5 m IGN es un salto de densidad (~1.44M nodos vs ~decenas de miles) no probado en presupuestos actuales (200k/260k tris).

## 6. Reconciliación terreno-vía

- Regla general: **vías aplanadas a 0; el terreno se aplana hacia las vías**, no al revés. Montañas reserva corredores `width/2 + step*1.5` y mezcla a 0 en bordes (`prepare_city_mountains.py:28-31,48-49`); Lianhua aplana calles perimetrales no-`service` con `road_weight=smoothstep(dist/(30*scale))` y preserva datum (`prepare_landmark_terrain.py:127-147`); grassland excluye `width/2+2.8` alrededor de vías (`prepare_city_ground_relief.py:41,50`).
- Excepciones drapeadas: `service` dentro del parque y `path/footway/steps` se muestrean sobre el heightfield (`height_at` + densificación cada `8*scale`, `prepare_landmark_terrain.py:160-185`).
- Runtime apila alturas (`city-world.ts:250`) y añade offsets anti-solape (`surfaceOffset .012/.04`, `city-ground-relief.ts:100`; `prepare_city_mountains.py:90`). No hay carving booleano de calzada ni snap de nodos a DEM fuera de esos dos casos.
- Para off-road: el modelo actual **impide pistas onduladas** (todo lo motor es plano). Hay que invertir la prioridad: drapear `track/path` sobre DEM IGN y reservar sólo ensanches puntuales.

## 7. Licencia / atribución

- OSM → **ODbL 1.0**, atribución `© OpenStreetMap contributors` en manifiesto (`download_osm.py:54-55`), capas (`extract_city.py:41,155-156`), `city.json/metadata.json` (`prepare_driving_city.py:108-109`) y `ATTRIBUTION.md:3-14`. Toda `city.json` derivada es base de datos derivada ODbL: hay que mantener aviso, fuente (Geofabrik + snapshot `osmosis_replication_timestamp`, `extract_city.py:110`) y ofrecer share-alike de la DB derivada al distribuir.
- Geofabrik Guangdong incluye Hong Kong/Macao; el bbox de estudio incluye jurisdicciones vecinas (`extract_city.py:120`) — mención obligatoria al recortar España (usar extracto `castilla-y-leon` o `spain` de Geofabrik, no Guangdong).
- Copernicus GLO-30: aviso literal exigido (`prepare_landmark_terrain.py:27-29`; `ATTRIBUTION.md:46-50`): `produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved`. DSM ≠ DTM, con arbolado/edificios (`prepare_landmark_terrain.py:3-5,205`; `ATTRIBUTION.md:44`).
- Overture Buildings también ODbL (`ATTRIBUTION.md:16-24`) — irrelevante si hay cero edificios, pero no sumar conteos OSM+Overture (`ATTRIBUTION.md:23`).
- **Cambio a España/IGN:** OSM sigue ODbL igual; el DEM IGN (p. ej. MDT05/MDT25, CC-BY 4.0) **añade** obligación de atribución `© IGN-CNIG` + enlace a licencia, sin quitar ODbL ni Copernicus donde se usen. No mezclar en un único aviso: tres líneas separadas (OSM/ODbL, IGN/CC-BY, Copernicus si se reutiliza). Alturas estimadas de fotos y tags OSM no son medidas: mantener `height_status`/`confidence` (`extract_city.py:43-47`; `prepare_landmark_terrain.py:206`).

## 8. Veredicto de reutilización por script

| Script / módulo | Veredicto | Justificación |
|-----------------|-----------|---------------|
| `scripts/download_osm.py` | **REUSE-WITH-PARAMS** | Lógica de presupuesto/checksum/manifiesto genérica (`download_osm.py:13-60`); sólo cambiar `URL`/`TARGET`/`LIMIT` a extracto España (p. ej. `spain/castilla-y-leon-latest.osm.pbf`). |
| `scripts/extract_city.py` | **REUSE-WITH-PARAMS** | Capas/roads/buildings/green/water genéricas (`extract_city.py:22,69-105`); parametrizar `config/regions.json` (hoy sólo Shenzhen, `regions.json:6-12`), `LANDMARK` regex chino (`extract_city.py:23`), `PROJECT 32649` (`extract_city.py:21`, UTM 49N válido sólo en Guangdong → 30N en Burgos). |
| `scripts/validate_data.py` | **REUSE-WITH-PARAMS** | Chequeos genéricos (`validate_data.py:9-26`); parametrizar nombres `guangdong.*` (`validate_data.py:22-23`). |
| `scripts/prepare_driving_city.py` | **REWRITE** (núcleo vial) | Whitelist urbana sin `track/path` (`prepare_driving_city.py:31`), anchos por carriles (`prepare_driving_city.py:39-42`), aplanado total (`prepare_driving_city.py:1-3`), origen/BBOX Shenzhen (`prepare_driving_city.py:12-14`), filtro Hong Kong (`prepare_driving_city.py:28-29`). Reescribir whitelist, anchos por `tracktype/surface`, proyección y drapeado DEM. Reutilizar sólo esqueleto `project→simplify→clip→metadata`. |
| `scripts/prepare_city_streets.py` | **SHENZHEN-ONLY** | Asfalto/aceras/farolas/marcas urbanas (`prepare_city_streets.py:11-34`); sin superficie de tierra/grava. Para rural casi todo se descarta; quizá reutilizar `clear()`/triangulación como util. |
| `scripts/prepare_city_ground.py` | **REUSE-WITH-PARAMS** | Unión land/water/green + `constrained_delaunay` genérica (`prepare_city_ground.py:8-16`); quitar `backdrop` norte 9000 (`prepare_city_ground.py:10`) y adaptar a extent 6×6 km. |
| `scripts/build_city_ground.py` | **REUSE-WITH-PARAMS** | Export Blender genérico (`build_city_ground.py:5-18`); revisar materiales `water/sea` y pasarela costera (`build_city_ground.py:9-17`, SHENZHEN-ONLY esa parte). |
| `scripts/prepare_landmark_terrain.py` | **REUSE-WITH-PARAMS** (plantilla DEM) | Mejor plantilla de ingesta DEM (ventana, bilineal, datum percentil, blends, drapeado, `terrain-detail.json`, `prepare_landmark_terrain.py:102-185,212`); parametrizar tile/URL, boundary OSM (`way/41281446`, `prepare_landmark_terrain.py:87-88`), `peak_world` Lianhuashan (`prepare_landmark_terrain.py:186`), checks EGM2008 (`prepare_landmark_terrain.py:70-76`). |
| `scripts/prepare_city_mountains.py` | **REUSE-WITH-PARAMS** | Patrón regional DSM→grid reutilizable (`prepare_city_mountains.py:36-72`); atado a tiles N22/E113-114 + SHA (`prepare_city_mountains.py:38-39`; `fetch_coastal_dsm.py:6`), datum 20 m (`prepare_city_mountains.py:47`), extent fijo (`prepare_city_mountains.py:22`), nombres de crestas (`prepare_city_mountains.py:88-89`). |
| `scripts/fetch_coastal_dsm.py` | **SHENZHEN-ONLY** | Tiles y SHA de la costa china (`fetch_coastal_dsm.py:6-9`). Reemplazar por descarga IGN (nuevos URL/checksum). |
| `scripts/prepare_city_ground_relief.py` | **SHENZHEN-ONLY** | Césped autoral urbano declarado no-survey (`prepare_city_ground_relief.py:1-6`); incompatible con DEM rural real. No reutilizar salvo utilidades `noise/hash2`. |
| `src/city-types.ts` | **REUSE-WITH-PARAMS** | `Road/Building/green/water/land` mínimos y suficientes (`city-types.ts:1-4`); extender `Road` con `surface/tracktype/smoothness/width:real/gradeDEM` y tipar `heightSource`. |
| `src/city-ground-relief.ts` | **REUSE-AS-IS** (infra) | Sampler `base+delta` + celdas + `preservedBounds` genérico (`city-ground-relief.ts:14-35,71-82`). Reutilizar como compositor aunque la fuente de deltas pase a ser DEM. |
| `src/city-road-surface.ts` | **SHENZHEN-ONLY** | Asfalto cinematográfico urbano (PBR/ORM, `city-road-surface.ts:1-10,45-113`); para tierra/grava se necesita material nuevo. |
| `src/landmark-details.ts` (`terrainHeight`) | **REUSE-AS-IS** | Interpolación de grid exacta y validación (`landmark-details.ts:33-42,55-56`); agnóstica al DEM. |
| `requirements.lock.txt` | **REUSE-AS-IS** | `osmium, shapely, pyproj, rasterio, numpy, pillow` (`requirements.lock.txt:17,24,26,9,15,20`) cubren el pipeline rural; añadir `UNKNOWN` (nada que quitar). |

## 9. Huecos para España rural (Montes de Oca)

1. **Mundo vial rural inexistente.** `track`/`path` se filtran (`prepare_driving_city.py:31`) y lo motor se aplana (`prepare_driving_city.py:1-3`); `tracktype/surface/smoothness` sin lectura. Hay que: whitelist `track/path/bridleway`, anchos por `tracktype` (grade1-5) y `surface` (ground/grass/gravel/dirt/asphalt), filtro `access/m motor_vehicle`, preservación de `surface/smoothness` en `Road`, y drapeado sobre DEM en vez de plano. Sin esto no hay off-road.
2. **Heightfield 6×6 km a resolución útil sin precedente.** Máximo probado: 15 m reales (Lianhua, `prepare_landmark_terrain.py:91-92`) y 20 m (near, `prepare_city_mountains.py:22,90`); techos 200k/260k tris (`city-ground-relief.ts:74`; `prepare_city_mountains.py:80`). MDT05 IGN a 5 m = ~1.44M nodos + blends viales; exige nuevo tiling/streaming, LOD y presupuesto, más datum EGM08→ETRS89 y paso a EPSG:25830 (hoy equirectangular Shenzhen, `prepare_driving_city.py:108`).
3. **Ingesta DEM IGN + cero edificios + baja densidad.** Todo el pipeline asume Guangdong/Copernicus/Shenzhen (tiles, SHA, `way/41281446`, landmarks con `excludeRadius`, `prepare_landmark_terrain.py:25,87-88`; `prepare_driving_city.py:48-58,66-93`). Hay que: downloader IGN con checksum/manifiesto (reemplaza `fetch_coastal_dsm.py:6-9`), `config/regions.json` con bbox Villafranca (~42.38°N, 3.31°O), `ORIGIN/BBOX/UTM` nuevos, desactivar edificios (o sólo ermita/núcleo como landmarks puntuales), y recortar `prepare_city_streets.py`/`city-road-surface.ts` (farolas, aceras, asfalto cinematográfico) a pistas de tierra. Atribución triple OSM-ODbL + IGN-CC-BY (+Copernicus sólo si se conserva).

## Confianza

- **Alta** en cadena de etapas, esquema runtime, fórmula de coordenadas y whitelist vial: todo citado con línea exacta y verificado por lectura directa + grep de `tracktype|surface|smoothness`.
- **Media** en presupuestos runtime (200k/260k tris, offsets) y en qué `public/city/*.json` están efectivamente embarcados vs candidatos (`ground-relief` es candidato según `city-ground-relief.ts:69`; el deploy exacto vía `sync-r2.mjs:28` no se auditó a fondo).
- **Baja / UNKNOWN**: grafo `navigation.json` fuera de uso real en runtime (generado en `node_city_roads.py:15`, consumo no rastreado); pipeline Blender `city_mesh.export` (`build_city_ground.py:4,18`) sin leer `city_mesh.py`; coste exacto de MDT05 5 m y datum vertical IGN preciso (requiere inspección de muestra IGN, no disponible en esta auditoría).
