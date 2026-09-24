# 05 — Acoplamiento a Shenzhen: mapa motor vs contenido

Repo referencia: `/home/kiri_/projects/montes-de-oca` (READ-ONLY, no modificado).
Estrategia: extraer núcleo de motor reutilizable para "Montes de Oca: Offroad Stories"
(Villafranca Montes de Oca, rural) y descartar la capa Shenzhen.
Convención crítica: la investigación temprana usó **EPSG:32649** y el juego embarcado usa un
**origen local WGS84 [114.025, 22.536] + escala 0.60** — nunca mezclarlos
(`AGENTS.md:14`, `skills/landmark-reconstruction/SKILL.md:53`,
`docs/landmarks/agent-workflow.md:91`).

## 1. Acoplamiento de coordenadas / proyección

### 1.1 Única ocurrencia en runtime (`src/`)

| Archivo:línea | Código |
|---|---|
| `src/city-map-geometry.ts:19` | `wgs84ToMap`: `[(lon - 114.025) * 102850 * .6, (lat - 22.536) * 111320 * .6]` |

Verificación de completitud: `grep -rn "114\.025\|102850\|111320" src/` → **1 archivo, 1 línea**.
`grep -rc` por archivo confirma: sólo `src/city-map-geometry.ts:1`, resto `:0`.
`grep -rn "EPSG" src/` → **0 resultados**: ningún módulo de runtime nombra un CRS.

### 1.2 Origen/escala horneados en datos generados (no son código, pero el motor los lee)

| Archivo:línea / clave | Contenido |
|---|---|
| `public/city/city.json` meta | `originWGS84: [114.025, 22.536]`, `horizontalScale: 0.6`, `verticalScale: 0.6`, `bboxWGS84: [113.915, 22.497, 114.135, 22.575]`, `coordinateSystem: 'local east/north; equirectangular at Shenzhen latitude, metres scaled 0.60'` |
| `public/city/city.json` spawn | `{x: -2664.20, z: -862.23, yaw: -1.72, road: '滨海大道'}` — spawn atado a calle de Shenzhen |
| `data/map-places.json:5` | `coordinateSystem: 'WGS84 lon/lat converted to current game east/north coordinates; origin [114.025,22.536], scales [102850,111320]*0.60'` |
| `data/landmarks/shenzhen-top50.json` (`coordinatePolicy`) | `canonical: EPSG:4326`, `projectOrigin: [114.025, 22.536]`, `horizontalScale: 0.6`, `verticalScale: 0.6` + ~30 campos `crs: EPSG:4326` por lugar |
| `data/landmarks/priority-models.json:6-11` | origen `[114.025, 22.536]` y escalas `[102850, 111320]` |
| `data/landmarks/tencent.json:255,440,886-887` | `note: 'OSM轮廓按项目统一102850/111320 m per degree投影转换'`, `east_metres_per_degree: 102850`, `north_metres_per_degree: 111320` |
| `data/landmarks/qijie-gongguan.json:41` | `plan_basis` con fórmula `east=(lon-…)*102850, north=(lat-…)*111320` sobre otro ancla local |
| `data/locations/bamboo-cafe.json:7` | `geography: 'existing east/north city coordinates, WGS84 origin [114.025,22.536], geographic scale 0.60'` |
| `data/materials/landmark-signage.json` (`coordinateConvention`) | `physicalUnits: unscaled metres, gameScale: 0.6, applyScaleOnce: true` |
| `config/regions.json:2` + bbox | `crs: EPSG:4326`; 7 regiones de estudio (shenzhen_study, shenzhen_bay, tech_park, futian, xiangmihu, longhua, longgang) con bbox WGS84 del área de Shenzhen |
| `public/city/*.json` (city, navigation, building-signs, terrain-detail, rain/puddles-layout) | contienen token `32649` en metadatos/procedencia (verificado con `grep -l`; JSON minificado de 1 línea, nº de línea exacto UNKNOWN) — residuo de investigación, no del runtime |

### 1.3 Fórmula duplicada en `scripts/` (tooling, ~12 definiciones independientes)

| Script:línea | Variante |
|---|---|
| `scripts/prepare_driving_city.py:12,14` | `ORIGIN=[114.025,22.536]; SCALE=.60; project=((x-OX)*102850*S,(y-OY)*111320*S)` |
| `scripts/refine_city_layout.py:8` | `project=lambda x,y:((x-114.025)*102850*scale,(y-22.536)*111320*scale)` |
| `scripts/build_landmark_details.py:15,83,96-97` | `project` + inversa `origin[0]+x/(102850*scale)` |
| `scripts/prepare_landmark_terrain.py:84-85` | `project` + `inverse` (misma forma) |
| `scripts/landmarks/priority.py:136-137` | `x=(lon-114.025)*102850*scale`, `z=(lat-22.536)*111320*scale` |
| `scripts/landmark_candidate.py:533-534` | `x=(lon-origin[0])*102850*scale`, `z=(lat-origin[1])*111320*scale` |
| `scripts/build_ebikes.py:32` | `project(lon,lat)` idem |
| `scripts/prepare_civic_center.py:22,24` | `((p[0]-center[0])*102850*sx, …*111320*sy)` |
| `scripts/prepare_landmark_signage.py:131-132,147-148,179-180` | variantes sin `*0.6` (metros sin escalar → `origin_e/n`, con `gameScale: 0.6` aplicado después) |
| `scripts/prepare_city_mountains.py:37` | forma pre-multiplicada `61710 (=102850×0.6)`, `66792 (=111320×0.6)` + `+114.025 / +22.536` (inversa) |
| `scripts/prepare_coastal_infrastructure.py:73,86` | idem pre-multiplicada; `originWGS84: [114.025,22.536]`, `verticalScale: .6` |
| `scripts/landmark_tasks.py:89,137,139` | documenta la política: `x=(lon-114.025)*102850*0.60`, `north=(lat-22.536)*111320*0.60`; `sourceCRS: EPSG:4326` |

### 1.4 EPSG:32649 — sólo investigación temprana, jamás runtime

`scripts/select_pilot_route.py:14-15`, `scripts/extract_city.py:21`, `scripts/preview_data.py:22,115`
(`Transformer.from_crs(4326, 32649)`); `docs/城市制作路线.md:63` (workspace UTM 49N);
`docs/landmarks/agent-workflow.md:91`, `AGENTS.md:14`, `skills/landmark-reconstruction/SKILL.md:53`
(advertencias explícitas de no mezclar). Ningún `src/*.ts` lo referencia.

### Veredicto §1
**Parcialmente centralizado, efectivamente disperso.** El runtime expone un único helper
(`wgs84ToMap`, `src/city-map-geometry.ts:19`), pero: (a) ~12 scripts reimplementan la fórmula
con variantes (con/sin `*0.6`, pre-multiplicada 61710/66792); (b) origen y escalas están
horneados en docenas de JSON generados; (c) el spawn y el extent están congelados a Shenzhen.
Para el data-pack: **un solo `geo-config` `{originWGS84, metresPerDegree, scale, verticalScale, bbox, extent, spawn}`**
inyectado al motor; prohibir literales de coordenadas en código y en scripts (leer del config).

## 2. Contenido con nombre (por categoría, con conteos y ejemplos)

| Categoría | Conteo | Ejemplos | Dónde vive |
|---|---|---|---|
| Hitos / landmarks | 51 ficheros en `data/landmarks/`; `shenzhen-top50.json`: 50 places; `city.json` meta: 10 landmarks embarcados | 平安金融中心 (`data/landmarks/pingan.json:11`), COCO Park (`coco-park.json:12`), 腾讯滨海大厦 (`tencent.json`), 莲花山 (`landmark-details.ts`, error `'莲花山高程加载失败'`) | `data/landmarks/`, `public/city/landmark-detail.json`, `landmark-candidates.json`, `src/landmark-details.ts` |
| Distritos / barrios | `data/map-places.json`: 293 places = **244 district**, 25 park, 16 transport, 8 place | 南山区 / 福田区 / 罗湖区 (`kind: city`); 上林社区 (`quarter`), 上梅林新村 (`neighbourhood`); caption `'南山 · 福田 · 罗湖'` (`src/city-map.ts:79`) | `data/map-places.json`, `src/city-map.ts:79,150,565` |
| Calles (nombres OSM) | `city.json`: **12202 roads** (service 4253, residential 1664, primary 1424, tertiary 1192, primary_link 1069…); fallback `'深圳街区 · 支路'` | 嘉宾路, 滨海大道 (spawn), 滨河皇岗立交; fallback `roadDisplayName` (`src/city-road-names.ts:8`); sufijos `附近`, `连接匝道/内部道路/街巷/支路`, `城市东西南北侧` (mismo archivo) | `public/city/city.json`, `street-surfaces.json` (35M), `src/city-road-names.ts` |
| Topónimos UI | docenas de literales | `'深圳 · 地图选点'`, `'选定位置'` (`src/city-map-geometry.ts`, `mapPointDestination`); `'深圳 · 道路'`, `'深圳 · 道路方位参考'` (`src/city-map.ts:150`); `'深圳湾 · 自由驾驶'` (`src/city-hud.ts:152`); district por defecto `'深圳湾'` (`src/city-hud.ts:178`); modos `'海湾飞行'`, `'无人机观景'` (`src/city-hud.ts:180`) | `src/city-map-geometry.ts`, `src/city-map.ts`, `src/city-hud.ts` |
| Historia / diálogo | `city-story-content.ts`: 129 líneas, id `bay-last-delivery` (`最后一单`), 8 steps, 4 personas, reward 180 | steps `hub-pickup → office-meet → …`; lugares 科苑下班驿站 / 滨海路边交接点 / 公园城市养护站 / 海湾生活驿站 | `src/city-story-content.ts` (contenido), `src/city-story-contract.ts` (contrato genérico — ver §6), `src/city-story.ts`, `src/city-story-experience.ts` |
| Cartelería | `public/city/building-signs.json` 1.9M; `data/materials/landmark-signage.json` 45KB; `public/city/landmark-signage.json` 7.3K | `src/city-building-signs.ts`, `src/landmark-signage.ts`; política `textMethod: manual_vector_or_manually_authored_alpha_texture` | datos + 2 módulos runtime |
| Personajes | 3 personas fijas: 阿辉 (驿站日结), 阿琳 (科苑职场人), 老陈 (城市工人) (`city-story-content.ts`, `city-career.ts:20-22,54-59`) | `public/characters/kuki.glb`, `yelan.glb` (miHoYo/MMD — ver licencias); `public/city/bamboo-cafe/`, `rider/`, `ebikes/`; `src/city-cafe-characters.ts`, `city-local-characters.ts`, `city-cafe-layout.ts` | código + assets |
| Carrera / vida | 3 mecánicas: `delivery` (准时配送), `comfort` (平稳接送), `service` (多站巡检) (`city-career.ts:6`, `city-career-experience.ts:14`); contratos `hot-meal`, `two-stop-relay`, `quiet-ten-minutes`, `weekend-boundary`, `after-rain-round`, `night-repair` (`city-career.ts:80-85`) | `public/city/delivery-manifest.json` 524K, `life-sites.json`, `life-hub.json`; `src/city-career.ts`, `city-career-experience.ts`, `city-life.ts`, `city-life-hub.ts` | lógica genérica + contenido Shenzhen |
| Audio | `city-audio.ts:69`: `海湾晚风 — original 16-bar, 72 BPM`; panel `声音与音乐` (`city-audio.ts:128`) | UNKNOWN catálogo completo (no inventariado) | `src/city-audio.ts`, `city-audio.css` |
| Marca / onboarding | wordmark `深城纪 OPEN ROADS`, intro `南山 → 福田 → 罗湖` (`src/main.ts:135-136`); loader `深城纪`, `正在展开深圳地图`, `正在载入南山、福田、罗湖建筑` (`src/city-loading.ts:6-17,37,40`) | — | `src/main.ts`, `src/city-loading.ts` |

## 3. Acoplamiento de idioma chino

- **Alcance**: 49 ficheros `src/*.ts` contienen caracteres Han (`grep -rlP "\p{Han}"`); 23 ficheros
  mencionan `shenzhen|深圳|深城纪|guangdong` (`grep -rli`). 0 ficheros mencionan `china` en `src/`
  (token en inglés ausente; el acoplo es en chino, no en inglés).
- **Hard-codeado en código** (strings UI/errores/fallbacks, sin framework i18n observado en los
  archivos inspeccionados): `src/city-loading.ts:6-17,37,40`; `src/city-hud.ts:52,152,178,180`;
  `src/main.ts:135-139`; `src/city-map.ts:78-79,150`; `src/city-map-geometry.ts`
  (`mapPointDestination`); `src/city-road-names.ts:8` + genéricos de kind; `src/landmark-details.ts`
  (3 errores `…加载失败/格式不受支持/高程…无效`); `src/city-story-content.ts` íntegro;
  `src/city-career.ts:20-22,54-59,80-85`; `src/city-audio.ts:69,128`.
- **Data-driven** (nombres/contenido en JSON): `data/map-places.json` (293 nombres),
  `public/city/city.json` (nombres de 12202 calles), `building-signs.json`,
  `data/materials/landmark-signage.json`, `data/landmarks/*.json`.
- **Modelo mixto**: el volumen vive en datos, pero los *fallbacks y la cáscara UI están soldados en
  TS*. Sin capa de localización: para el data-pack, todo string visible debe salir de código a
  `locale/*.json` o al propio pack (`strings` + `fallbackStrings`), con el motor 100% libre de Han.

## 4. Inventario de archivos de datos

Tamaños vía `ls -lah`. Productor = script con nombre/forma correspondiente; `?` = inferido, no verificado.

### 4.1 `public/city/` raíz (embarcado por el motor vía `fetch('/city/…')`)

| Archivo | Tamaño | Productor | Veredicto |
|---|---|---|---|
| `city.json` | 8.0M | `scripts/prepare_driving_city.py` ? (+ `refine_city_layout.py` ?) | **Específico de Shenzhen** (geometría OSM Guangdong + origen/escala horneados) |
| `street-surfaces.json` | 35M | `scripts/build_driving_assets.py` ? | **Específico de Shenzhen** (superficie vial de las 12202 calles) |
| `ground-surfaces.json` | 2.2M | `scripts/build_city_ground.py` ? | **Específico de Shenzhen** (material de suelo por huella) |
| `surfaces.json` | 1.5M | `scripts/build_game_assets.py` ? | **Específico de Shenzhen** ? |
| `navigation.json` | 1.3M | `scripts/prepare_driving_city.py` ? | **Esquema genérico** (grafo vial), contenido Shenzhen |
| `pedestrian-paths.json` | 1.3M | UNKNOWN (`build_*` peatonal ?) | **Esquema genérico**, contenido Shenzhen |
| `building-signs.json` | 1.9M | `scripts/prepare_landmark_signage.py` ? | **Específico de Shenzhen** (cartelería china) |
| `lamps.json` | 684K | UNKNOWN | **Esquema genérico**, contenido Shenzhen |
| `delivery-manifest.json` | 524K | UNKNOWN (career/life ?) | **Específico de Shenzhen** (puntos de reparto del relato) |
| `terrain-detail.json` | 373K | `scripts/build_landmark_details.py` | **Específico de Shenzhen** (grid 莲花山) |
| `trees.json` | 271K | `scripts/build_canopy_trees.py` ? | **Esquema genérico**, contenido Shenzhen |
| `landmark-candidates.json` (+ `.glb`) | 52K | `scripts/integrate_landmark_candidates.mjs` (citado en `landmark-details.ts`) | **Específico de Shenzhen** |
| `landmark-detail.json` (+ `.glb`) | 33K | `scripts/build_landmark_details.py` | **Específico de Shenzhen** |
| `facade-tiles.json` (+ `facade-tiles/`) | 20K | `scripts/build_city_facades.py` ? | **Esquema genérico**, contenido Shenzhen |
| `asset-manifest.json` | 11K | UNKNOWN | **Tooling genérico** ? |
| `vehicle-manifest.json` | 9.4K | `scripts/build_vehicle_candidate.py` ? | **Esquema genérico** ? |
| `landmark-signage.json` | 7.3K | `scripts/prepare_landmark_signage.py` ? | **Específico de Shenzhen** |
| `floatplane-manifest.json` (+ `.glb`) | 3.0K | `scripts/build_floatplane.py` | **Esquema genérico** ? (vehículo, no ciudad) |
| `life-sites.json` / `life-hub.json` | 2.2K / 569 | `scripts/build_city_life_hub.py` | **Específico de Shenzhen** (驿站/养护站 del relato) |
| `metadata.json` | 792 | UNKNOWN | **Tooling genérico** ? |
| `building-exclusions.json` | 611 | UNKNOWN | **Específico de Shenzhen** ? (exclusiones por huella OSM) |
| `detail-manifest.json` / `facade-manifest.json` / `street-validation.json` | 522 / 237 / 301 | UNKNOWN | **Tooling genérico** ? |
| `*.glb` raíz (`buildings`, `roads`, `facades`, `car`, `landmarks`, `floatplane`…) | ~130 c/u (stubs) | pipeline glTF | **Esquema genérico** (contenedores), contenido Shenzhen |
| `LANDMARK_ATTRIBUTION.md` | 1.8K | manual | **Específico de Shenzhen** (licencias OSM/Overture/Copernicus) |

### 4.2 `public/city/` subdirectorios (sólo nombres + tamaño dir)

`coastal/` 1.4M (`prepare_coastal_infrastructure.py` → `build_coastal_infrastructure.py` ?, Shenzhen: bahía/puentes);
`rooftops/` 3.3M (Shenzhen: props de azotea densa); `landscape/` 4.1M (mixto: vegetación genérica + plantado Shenzhen ?);
`grassland-v2/` 14M (genérico ?); `loading/` 6.6M (`bamboo-clay-loop.mp4`, Shenzhen-bambú);
`environment/` 20K (HDRI Poly Haven, genéricos); `facade-tiles/` 604K, `signals/` 176K, `street/` 28K,
`ebikes/` 720K, `life-hub/` 16K, `bamboo-cafe/` 52K, `rider/` 12K, `tank/` 12K, `ambient/` 12K,
`ground-relief/` 28K, `mountain-relief/` 32K, `open-vegetation/` 52K, `rain/` 4.2M (`puddles-layout.json`),
`textures/` 148K. Veredicto por defecto: **contenido Shenzhen salvo `environment/`, `grassland-v2/`,
`open-vegetation/` (genéricos ?)**. `public/characters/` (`kuki.glb`, `yelan.glb`, `manifest.json`,
`CREDITS.txt`) y `public/assets/` → **específicos de Shenzhen** (reparto/personas del relato;
ver §licencias).

### 4.3 `data/` + `config/`

| Archivo | Tamaño | Veredicto |
|---|---|---|
| `data/map-places.json` (293 places) | 148K | **Específico de Shenzhen** (catálogo de distritos/parques/transporte) |
| `data/landmarks/` 51 JSON (`shenzhen-top50.json` 67K, `priority-places.json` 21K, `priority-models.json` 41K, `civic.json` 509K, `tencent.json` 23K, 46 fichas 0.5–5K) | ~700K | **Específico de Shenzhen** (evidencia/fichas por hito) |
| `data/locations/bamboo-cafe.json` | 1.7K | **Específico de Shenzhen** |
| `data/materials/landmark-signage.json` | 45K | **Específico de Shenzhen** |
| `data/materials/shenzhen-palette.json` | 38K | **Específico de Shenzhen** (paleta; el *loader* de paletas sería motor) |
| `data/materials/cinematic-environment.json` 12K, `daylight-environment.json` 2.7K, `road-cinematic.json` 3.4K, `architecture-textures.json` 3K, `architecture-windows.json` 2K, `tencent-logo-source.json` 1K | — | **Esquema genérico** ?, contenido Shenzhen ( Tencent logo: específico ) |
| `data/ATTRIBUTION.md` | 4.5K | **Específico de Shenzhen** (ODbL Guangdong/Geofabrik, Overture, catálogo SZ PNR 2026-04-28, GLO-30) |
| `data/references/` (catálogo geodatos SZ + xlsx) | 14K | **Específico de Shenzhen** |
| `config/regions.json` | 907 | **Específico de Shenzhen** (7 bbox de estudio) |

### 4.4 Licencias / asset split (README)
`README.md:196-205`: código MIT (`src/`, `scripts/`, `tests/`, `cloudflare/`, `ue5/…`);
calles/huellas © OSM contributors ODbL (`data/ATTRIBUTION.md`); coche-héroe Khronos CarConcept CC BY 4.0;
cielos/árboles/asientos Poly Haven/OpenGameArt; terreno/hitos en `public/licenses/coastal-terrain.md` y
`public/city/LANDMARK_ATTRIBUTION.md` (Copernicus WorldDEM-30 © DLR/Airbus, UE/ESA);
**Kuki/Yelan: modelos de miHoYo, adaptación MMD de 观海 — página de distribución en bilibili, NO
redistribución abierta automática** (`README.md:204-205`). No hay sección "asset split" con ese nombre;
el split efectivo es: código MIT reutilizable vs datos derivados ODbL + assets con licencias propias
**no trasladables a un mapa rural español sin re-derivar desde fuentes locales**.

## 5. Split propuesto NÚCLEO DE MOTOR vs CONTENIDO SHENZHEN

Granularidad archivo individual para lo inspeccionado. `?` = ambiguo (requiere segunda pasada).
**Cobertura**: `src/` tiene 111 `.ts` (+ CSS, total 127 entradas). Inspeccionados a fondo: 8
(`city-types`, `landmark-details`, `city-story-content`, `city-story-contract`, `city-map-geometry`,
`city-road-names`, `city-map` skim, `config/regions.json`). Skim por grep: ~20 más.
**NO inspeccionados individualmente: ~85–90 archivos `src/`** (física de vuelo/tanque, clima, iluminación,
cámaras, combate, trailer, pedestres/tráfico, ebikes, etc. — ver lista §5.3).

### 5.1 NÚCLEO DE MOTOR (reutilizar, parametrizar)

| Módulo | Acción para ruralizar |
|---|---|
| `src/city-types.ts` | **Núcleo tal cual**: `V2/Road/Landmark/CityData/spawn` ya es genérico (0 topónimos en el tipo). Añadir `geoConfig` + `strings` |
| `src/city-map-geometry.ts` (`wgs84ToMap`, `MapRoadIndex`, `placeMapLabels`, `mapPointDestination`) | Núcleo; `wgs84ToMap` → leer `geoConfig` (origen/escala como parámetros); `mapPointDestination` → quitar `'深圳 · 地图选点'`/`'选定位置'` a `strings` |
| `src/city-road-names.ts` (index espacial, `assignRoadDisplayNames`) | Núcleo algorítmico; TODO el fallback chino (`深圳街区 · 支路`, kinds, `附近`, cuadrantes) → `strings` del pack |
| `src/landmark-details.ts` (`terrainHeight`, loaders con `schemaVersion`) | Núcleo (trigulación + validación de manifiestos versionados); mensajes de error → `strings` |
| `src/city-story-contract.ts` | **Núcleo tal cual**: `StoryPlace/StoryStep/StoryHooks` ya es contrato data-driven |
| `src/city-map.ts` (catálogo, routing UI, minimapa) ? | Núcleo probable; quitar caption/áreas `'深圳 · …'` y aria-label a `strings` |
| `src/navigation.ts`, `src/driving.ts`, `src/traffic.ts`, `src/pedestrians.ts` ? | Núcleo probable (grafo, conducción, walkers) — densidades a parámetros (ver §7) |
| `src/world.ts`, `src/state.ts`, `src/save.ts` ? | Núcleo probable (bootstrap, estado, guardado) |
| `src/city-gltf-streaming.ts`, `src/dynamic-instances.ts` ? | Núcleo probable (streaming/instanciado) |
| Render/atmósfera (daylight/sunset/night-sky/rain/weather/puddles/ground-relief/mountains/landscape/canopy/meadow/grass-material/street-furniture/public-lighting/facades/rooftops/road-surface…) ? | Núcleo probable; paletas/presets a datos (`daylight-environment.json` como ejemplo) |
| Vehículos/cámaras (cockpit/flight/tank/rider/ebikes/vehicle-*) ? | Núcleo probable (son jugabilidad, no ciudad) |
| `scripts/` build/check genéricos (facades, ground, vegetation, signals…) ? | Núcleo de pipeline; los `prepare_*` con origen hard-codeado → leer `geo-config` |
| `public/city/environment/`, `grassland-v2/`, `open-vegetation/` ? | Candidatos a núcleo (assets climáticos/vegetación genérica, verificar licencia Poly Haven/OpenGameArt) |

### 5.2 CONTENIDO SHENZHEN (descartar / no migrar; re-derivar desde fuentes de Burgos)

`src/city-story-content.ts` (relato 最后一单); `src/city-career.ts` + `city-career-experience.ts`
(contratos/personas 日结); `src/city-life.ts` + `src/city-life-hub.ts` + `life-sites.json` +
`life-hub.json` + `delivery-manifest.json`; `src/city-building-signs.ts` + `src/landmark-signage.ts` +
`building-signs.json` + `landmark-signage.json` + `data/materials/landmark-signage.json`;
`src/city-cafe-characters.ts` + `city-local-characters.ts` + `city-cafe-layout.ts` (+ CSS) +
`public/characters/*` + `bamboo-cafe/` + `rider/` + `ebikes/` (personas/vehículos del relato);
`src/city-audio.ts` (pista 海湾晚风) + `city-bamboo-corridor/look/cafe` + `city-baypark-look` +
`city-bay-water` + `city-coastal-*` (bahía/manglar/parques); `src/city-hud.ts` + `city-loading.ts` +
`city-quicktips.ts` + `main.ts` (cáscara con literales Shenzhen — reescribir con `strings`);
`src/landmark-details.ts` **parcial**: el loader es núcleo, los *datos* (`landmark-detail.json`,
`landmark-candidates.json`, `terrain-detail.json`, grid 莲花山) son contenido;
`public/city/city.json`, `street-surfaces.json`, `ground-surfaces.json`, `surfaces.json`,
`navigation.json`, `pedestrian-paths.json`, `lamps.json`, `trees.json`, `coastal/`, `rooftops/`,
`signals/traffic-signals.json`, `street/`, `rain/puddles-layout.json`, `loading/bamboo-clay-*`;
`data/` íntegro (`map-places.json`, `landmarks/`, `locations/`, `materials/shenzhen-palette.json`,
`ATTRIBUTION.md`, `references/`); `config/regions.json`; `public/city/LANDMARK_ATTRIBUTION.md`
+ `public/licenses/coastal-terrain.md` (procedencia OSM Guangdong/Overture/Copernicus N22E113/E114);
skins cinemáticas `aerial-film-shots/trailer-shots/readme-reel-shots` (encuadres de la ciudad densa).

### 5.3 Archivos `src/` NO inspeccionados (~85–90, lista de verificación pendiente)
`aerial-film-hud`, `aerial-film-shots`, `city-ambient-bake`, `city-ambient-occlusion`,
`city-architecture-materials`, `city-autopilot`, `city-bamboo-cafe/cafe-layout/cafe-staff-motion`,
`city-bamboo-corridor/look`, `city-bay-water`, `city-baypark-look`, `city-canopy`, `city-cockpit`,
`city-career` (parcial), `city-character-hud`, `city-cinematic`, `city-coastal-horizon/infrastructure`,
`city-daylight-environment/daylight`, `city-distant-city/geometry`, `city-ebikes`, `city-experience`,
`city-facade-diversity/stream`, `city-flight*` (7), `city-graphics-panel/quality`, `city-grass-material`,
`city-ground-relief`, `city-hud` (parcial), `city-landscape-lighting/lighting/landscape`, `city-life*`,
`city-loading` (parcial), `city-meadow`, `city-mountains`, `city-night-sky`, `city-objective-marker`,
`city-observer*` (6), `city-public-lighting`, `city-rain-puddles/weather`, `city-rider`, `city-road-surface`,
`city-roadside-planting`, `city-roof-surface`, `city-rooftop-plan/rooftops`, `city-sky-reflection`,
`city-sport-details`, `city-story/experience`, `city-street-furniture`, `city-sunset-environment`,
`city-tail-lights`, `city-tank/simulation`, `city-traffic-signals`, `city-vehicle-*` (5), `city-walk`,
`city-world`, `combat-core/lab`, `driving`, `dynamic-instances`, `main` (parcial), `navigation`,
`pedestrian-impact`, `pedestrians`, `save`, `state`, `traffic`, `trailer-capture/shots`, `world`
+ todos los `*.css`. Regla de clasificación para la 2ª pasada: ¿nombra Shenzhen/personas/Han?
→ contenido; ¿opera sólo sobre `CityData`/primitivas? → núcleo.

## 6. Contrato de datos mínimo (data-pack intercambiable)

Derivado de lo que el motor **realmente lee**: `CityData` (`src/city-types.ts:4`) + los 16
endpoints `fetch('/city/…')` observados en `src/` + `fetch(data/map-places.json)` para nombres.

```jsonc
// pack.json — todo origen/escala/nombre vive aquí; el motor no hard-codea ninguno
{
  "schemaVersion": 1,
  "id": "villafranca-montes-de-oca",
  "geo": {
    "crs": "EPSG:4326",
    "originWGS84": [lon0, lat0],          // p. ej. Villafranca ~[-3.30, 42.37] (verificar fuente)
    "metresPerDegree": [mPerDegLon, 111320],
    "horizontalScale": 1.0, "verticalScale": 1.0,  // 0.60 era compresión de megaciudad
    "bboxWGS84": [w, s, e, n], "extent": [xmin, zmin, xmax, zmax]
  },
  "spawn": {"x": 0, "z": 0, "yaw": 0, "road": "<id-calle-local>"},
  "layers": {
    "city": "city.json",            // CityData: meta{counts,extent,horizontalScale} + land/coast/roads/buildings/green/water/landmarks/spawn
    "navigation": "navigation.json",
    "pedestrianPaths": "pedestrian-paths.json",
    "lamps": "lamps.json", "trees": "trees.json", "facadeTiles": "facade-tiles.json",
    "signage": "signage.json", "sites": "life-sites.json",
    "landmarkDetail": "landmark-detail.json", "landmarkCandidates": "landmark-candidates.json",
    "places": "map-places.json"     // distritos/parroquias/pueblos con lon/lat + x/z precalculados
  },
  "strings": { "appTitle": "…", "areaFallback": "…", "unnamedRoad": "…", "mapPointArea": "…",
    "loader": {"map": "…", "buildings": "…"}, "errors": {"mapLoad": "…", "detailManifest": "…"} },
  "story": { "content": "story.json", "places": {"hub": [x, z], "…": [0, 0]} },  // StoryPlace genérico
  "assets": { "environment": "environment/", "vegetation": "open-vegetation/", "characters": "characters/" },
  "licenses": "ATTRIBUTION.md"      // ODbL/fuentes LOCALES (p. ej. OSM Castilla y León, IGN) — no reutilizar la de Guangdong
}
```

Tipos TS mínimos (ya existen, sólo hay que des-shenzhenizarlos): `V2`, `Road{id,name,displayName?,kind,width,oneway,points,grade}`,
`Landmark{id,name,x,z,height,area,excludeRadius,arrival,yaw,…}`, `CityData{meta,land,coast,roads,buildings,green,water,landmarks,spawn}`,
`SourcedMapPlace{id,name,nameEn?,category(district|park|place|transport|road),kind?,x,z,lon,lat,address?,source{provider,id?,url?,file?,coordinateMethod?}}`,
`StoryPlace/StoryStep/StoryHooks` (`city-story-contract.ts`, ya genérico).
Regla de validación del motor: rechazar packs con `schemaVersion` desconocida, `originWGS84` fuera de
`bboxWGS84`, o literales Han/CJK fuera de `strings` (el runtime queda 100% libre de chino).

## 7. Trampas silenciosas: supuestos de ciudad densa que rompen en rural

1. **Volumetría horneada**: `city.json` meta `counts: {roads: 12202, buildings: 16076, green: 1703, water: 312}` y
   `heightStatus {osm_height: 508, osm_levels_estimated: 5445, typology_estimate: 9603}` — el pipeline
   *asume* OSM urbano rico (fuente: `raw/guangdong.osm.pbf`, `data/ATTRIBUTION.md`). En Villafranca
   (~250 hab., casi sin edificios) esos contadores tenderán a 0 y cualquier umbral/división por
   densidad puede dividir por cero o degradar LODs.
2. **`MapRoadIndex.cellSize = 512`** (`src/city-map-geometry.ts`) y celdas de 160 en
   `assignRoadDisplayNames` (`src/city-road-names.ts`) — calibrados para malla urbana densa; con
   N-120/A-12 + pistas rurales dispersas, celdas gigantes vacías y radios de búsqueda (`near(...,150)`,
   contextos 400/900 m) quedan mal escalados.
3. **Spawn sobre arteria urbana**: `spawn.road = '滨海大道'` + `main.ts:83` (`nearest` a carretera).
   Sin snap rural (camino de tierra/pista), el arranque cae fuera de vía o en talud.
4. **Fachadas/azoteas/neones de torre**: `facade-tiles.json` + `facade-stream`, `rooftop-plan`,
   `building-signs.json` (1.9M), `lamps.json` (684K), `public-lighting`, `tail-lights` — subsistemas
   enteros sin objeto en un pueblo (coste de carga/parseo para 0 uso; peor: fallbacks que inventan
   "street" donde hay campo).
5. **Grafo vial Navegable-denso**: `navigation.json` 1.3M + `RoadGraph` + `startTraffic`
   (`src/main.ts:201`, `city-world.ts`) y `city-world.ts:420` (filtro `kind ∈ {primary,trunk}` sin `辅`) —
   asumen redundancia de red; en rural, un corte de pista = isla inaccesible y el autopilot/observer
   (`extent` paso a `observer.step`, `city-world.ts:381,523`) patrulla un vacío.
6. **Peatones/vida urbana fija**: `pedestrians.ts:33` (`count = min(56, …)`), `city-ebikes.ts:100-102`,
   `life-sites.json`, `delivery-manifest.json` — 56 walkers + flota de e-bikes + riders de delivery
   presuponen multitud y economía gig (reparto a domicilio); en rural son fauna/peregrinos/tractores,
   no commuters.
7. **Agua costera como plano**: `bay-water`, `coastal/infrastructure+far-shore`, `distant-city`,
   `opposite-shore` — el "mar" es un plano al nivel del delta del Pearl River; tierra adentro hay que
   sustituir por hidrología de arroyo/balsa o el terreno flotará sobre agua fantasma.
8. **Compresión 0.60 y extent [-6788, ±2605]**: la escala y el bbox (`city.json` meta) comprimen una
   megalópolis caminable; aplicada a sierras/campos, aplasta relieve (Camino de Santiago a 0.6 =
   pendientes falsas) y recorta fincas. Rural pide escala 1.0 + extent por paraje, no por bounding-box
   de Traverse-Mercator urbano.
9. **Fallbacks que mienten en español**: `城市东西南北侧 · 支路`, `深圳街区 · 支路`, `附近`
   (`city-road-names.ts`) — traducir no basta: hay que re-diseñar la taxonomía (`pista`, `camino`,
   `carretera N-120`, `paraje`, `monte`) o el mapa etiquetará "Calle sin nombre · ramal" en mitad
   de un robledal.
10. **Contenido come-motor**: `city-career`/`city-life`/beacons/aerial-shots asumen turnos de fábrica,
    oficinas (科苑), malls y miradores de skyline — mecánicas enteras (delivery/comfort/service,
    observer-beacons, film-shots) sin ancla rural; migrarlas tal cual produce objetivos imposibles
    (p. ej. "lleva el táper a la oficina" sin oficinas).
11. **Licencias no portables**: ODbL-Guangdong/Geofabrik, Overture-shenzhen-bay, Copernicus N22E113/E114,
    MMD-miHoYo (no redistribuible) — nada de esto cubre Burgos; re-derivar terreno (IGN/Copernicus
    celda local), calles (OSM CyL) y reparto propio antes de embarcar un byte.

## Confianza

- **Alta**: §1 (1 ocurrencia runtime verificada con `grep -c`; dispersión en scripts enumerada
  archivo por archivo), §2 conteos (12202/16076/293/244/50/51/8 steps medidos con `python3 -c` sobre
  los JSON), §3 (49 ficheros Han / 23 Shenzhen contados con `grep -rl`), §4 tamaños (`ls -lah`),
  licencias (citas `README.md:196-205` + `ATTRIBUTION.md` + `LANDMARK_ATTRIBUTION.md`).
- **Media**: mapeo script→producto en §4.1 (`?` donde el nombre sugiere pero no se ejecutó el pipeline);
  clasificación núcleo/contenido de módulos no abiertos (§5.3, ~85–90 `src/` sin inspección individual —
  la tabla sólo compromete lo inspeccionado); catálogo de audio/personajes (no inventariado exhaustivo).
- **Riesgo principal**: §5.1/§7 dependen de una 2ª pasada sobre los ~85–90 `src/` no inspeccionados;
  cualquier `fetch('/city/…')` adicional o literal Han oculto moverá filas de la tabla, no el
  diagnóstico (el contrato §6 ya cubre los 16 endpoints observados).
- **Núcleo propuesto**: ~25–35 ficheros `src/` (tipos + geometría + nombres + loaders versionados +
  contrato + mapa/navegación/conducción/tráfico/streaming/render/vehículos) + pipeline `scripts/build_*`
  genérico; contenido Shenzhen a descartar: ~70–85 `src/` con lógica de relato/vida/cartelería/UI +
  la totalidad de `data/`, `config/regions.json`, `public/city/` embarcado (≈60M, dominado por
  `street-surfaces.json` 35M + `city.json` 8M) y `public/characters|assets`.
