# PROJECT_AUDIT — Síntesis consolidada de la auditoría FASE 0

> Consolidación de seis fuentes ya escritas (no modificar): `docs/audit/01-runtime-y-streaming.md`,
> `docs/audit/02-pipeline-datos-y-terreno.md`, `docs/audit/03-conduccion-jugador-fisica.md`,
> `docs/audit/04-assets-blender-licencias.md`, `docs/audit/05-acoplamiento-shenzhen.md`,
> `docs/audit/REVIEW-phase0.md`.
> Regla: ninguna afirmación nueva; toda afirmación rastreable a una de esas fuentes. Las anclas
> `archivo:línea` se conservan tal como están en las fuentes, salvo las dos correcciones aplicadas
> por el review (ver nota al pie de la tabla y §7).

## Qué es el motor de referencia

El motor de referencia es **GTA_SZ / 深城纪 (ShenChengJi)**, un mundo abierto urbano 3D en navegador
ambientado en Shenzhen (ciudad densa costera): el repo auditado (READ-ONLY) es
`/home/kiri_/projects/montes-de-oca` (`01-runtime-y-streaming.md:3-6`).
Stack base: **Babylon.js 8 + TypeScript + Vite** (`package.json:19-21`, `package.json:7-17`)
(`01-runtime-y-streaming.md:5`). Herramientas offline: Blender 5.2.0 LTS, Python + `.venv`
(shapely, numpy, rasterio, pillow, pyproj), Node + gltf-transform + meshoptimizer, Playwright +
Chromium, Git LFS, Cloudflare R2 (`04-assets-blender-licencias.md:351-359`).
Escala del código auditado: `src/` tiene 111 `.ts` (+ CSS, 127 entradas); inspeccionados a fondo 8,
skim por grep ~20, **~85–90 archivos `src/` sin inspección individual**
(`05-acoplamiento-shenzhen.md:177-181`, `05-acoplamiento-shenzhen.md:222-238`).
Datos embarcados: `city.json` 8.0M con 12202 vías / 16076 edificios / 10 landmarks;
`street-surfaces.json` 35M; total `public/city/` ≈ 60M dominado por esos dos
(`05-acoplamiento-shenzhen.md:110-116`, `05-acoplamiento-shenzhen.md:338-342`);
`data/map-places.json` 293 places = 244 district / 25 park / 16 transport / 8 place;
`data/landmarks/` 51 ficheros (`05-acoplamiento-shenzhen.md:73-77`,
`REVIEW-phase0.md:56`).

## Resumen ejecutivo

- **Reutilizamos (REUSE-AS-IS):** render loop + instrumentación (`src/city-world.ts:218`,
  `src/city-world.ts:566-567`); mitigación de stalls glTF + Meshopt
  (`src/city-gltf-streaming.ts:56-62`, `src/city-world.ts:7`); telemetría/benchmarks
  (`scripts/city-benchmark.mjs:1-24`, `src/main.ts:201`); `RoadGraph` + Dijkstra
  (`navigation.ts:2-4`); controles + cámaras + cabina (`src/city-world.ts:517-534`,
  `src/city-cockpit.ts:3`); walk/exit/enter + rider (`city-walk.ts:7-56`); `terrainHeight`
  de `landmark-details.ts:33-42,55-56`; infra `city-ground-relief.ts:14-35`;
  `requirements.lock.txt`; validación `finalize_city_assets.mjs` + `rebuild_city_assets.mjs` +
  `check-*`; `.gitattributes` + `.gitignore` (`01-runtime-y-streaming.md:91-100`,
  `REVIEW-phase0.md:74-112`, `04-assets-blender-licencias.md:381-382`).
- **Reutilizamos con parámetros (REUSE-WITH-PARAMS):** boot + loader por etapas
  (`src/city-loading.ts:95-121`, 17 stages chinos en `src/city-loading.ts:5-23`); perfiles de
  calidad + panel (`src/city-graphics-quality.ts:10-26`); culling por distancia + `renderList`
  (umbrales 700/2500/3300 m, `src/city-world.ts:435`); cadena `groundHeight` decorada
  (`src/city-world.ts:250-261`); manifiestos `city.json` + incrementos (esquema genérico,
  contenido SHENZHEN-ONLY); save/state (renombrar claves `shenchengji-*`); `CityCollision`
  (poblar `land` con extent DEM); snap Y + pitch visual (`src/city-world.ts:513`); `CityTraffic`;
  `CityAutopilot`; casi todo `scripts/` salvo núcleo vial y piezas costeras/autorales
  (`01-runtime-y-streaming.md:90-100`, `02-pipeline-datos-y-terreno.md:102-119`,
  `03-conduccion-jugador-fisica.md:100-110`).
- **Reescribimos (REWRITE):** `stepCar` (conservar firma/arquitectura; sin gravedad/pendiente/lateral,
  `src/driving.ts:6-16`); `CityFacadeStream` (radios 700/1050/1500 m urbanos,
  `src/city-facade-stream.ts:18-34` → se necesita stream de heightfield/vegetación);
  `prepare_driving_city.py` núcleo vial (whitelist sin `track/path`,
  `prepare_driving_city.py:31`); estructura de licencias/atribución (contenido)
  (`REVIEW-phase0.md:74-112`).
- **No migramos (SHENZHEN-ONLY):** terreno base + relieve + montañas como datos;
  `prepare_city_streets.py`; `fetch_coastal_dsm.py`; `prepare_city_ground_relief.py` (autoral);
  `city-road-surface.ts` (asfalto); fachadas/streaming de fachadas; relato-vida-cartelería-personajes
  (story/career/life/café/bambú/bahía); la totalidad de `data/`, `config/regions.json` y
  `public/city/` embarcado (`05-acoplamiento-shenzhen.md:202-220`).
- **No existe (bloqueante, verificado por el orquestador):** `data/processed/` no existe →
  `prepare_landmark_terrain.py` **no puede ejecutarse** (`:86-87`, `:134`, `:170-171`); los 219
  `.glb` son punteros Git LFS de ~130 bytes y `git-lfs` no está instalado → cero mallas utilizables,
  ningún presupuesto GPU medible contra la referencia
  (`REVIEW-phase0.md:141-172`).

## Mapa motor-común vs contenido-Shenzhen

Tabla consolidada de `REVIEW-phase0.md` §"Veredicto de reutilización corregido"
(`REVIEW-phase0.md:70-112`), usada tal cual. Las filas marcadas [ADICIONAL] vienen de
`01`, `02`, `04` y `05` y no estaban en esa tabla; respetan el mismo formato con su ancla.

| Componente | Veredicto | Base (ancla verificada) |
|---|---|---|
| `stepCar` (longitudinal + yaw tipo bicicleta) | REWRITE (conservar firma/arquitectura) | `src/driving.ts:6-16`; sin pendiente/gravedad/lateral; `grip` muerto (`:13`) |
| `CityCollision` (índice + `blocked`) | REUSE-WITH-PARAMS | `src/driving.ts:20-36`; poblar `land` con extent DEM o invertir regla |
| Snap Y + pitch/roll visual | REUSE-WITH-PARAMS | `src/city-world.ts:513` |
| `RoadGraph` + Dijkstra | REUSE-AS-IS | `src/navigation.ts:2-18`; agnóstico a topología |
| `CityTraffic` NPC | REUSE-WITH-PARAMS | `src/traffic.ts:14-29`; exige grado ≥2 |
| `CityAutopilot` | REUSE-WITH-PARAMS | `src/city-autopilot.ts:23,194,277,294,355` |
| Controles + cámaras + cabina | REUSE-AS-IS | `src/city-world.ts:204,217,517-534`; `src/city-cockpit.ts:3` |
| Walk/exit/enter + rider | REUSE-AS-IS | `src/city-walk.ts:2-56`; `src/city-world.ts:318-328` |
| Boot + loader por etapas | REUSE-WITH-PARAMS | `src/city-loading.ts:5-12,95-121` (17 stages chinos a parametrizar) |
| Render loop + instrumentación | REUSE-AS-IS | `src/city-world.ts:218,566-567` |
| Perfiles de calidad + panel | REUSE-WITH-PARAMS | `src/city-graphics-quality.ts:1-26` |
| glTF streaming (`preserve_scene_lights`) + Meshopt | REUSE-AS-IS | `src/city-gltf-streaming.ts:7-62`; `src/city-world.ts:7` |
| `CityFacadeStream` | REWRITE | `src/city-facade-stream.ts:5,11,26,30`; único stream, forma urbana |
| Culling por distancia + `renderList` | REUSE-WITH-PARAMS | `src/city-world.ts:435-437,545-550` |
| Cadena `groundHeight` decorada | REUSE-WITH-PARAMS | `src/city-world.ts:250,261` |
| Terreno base + relieve + montañas | SHENZHEN-ONLY | `prepare_landmark_terrain.py`, `prepare_city_mountains.py` |
| Manifiestos `city.json` + incrementos | REUSE-WITH-PARAMS | `src/city-types.ts:1-4`; `src/landmark-details.ts:44-98` |
| Save/state | REUSE-WITH-PARAMS | claves `shenchengji-*` a renombrar |
| Telemetría/benchmarks | REUSE-AS-IS | `src/main.ts:201`; `scripts/city-benchmark.mjs` |
| `scripts/download_osm.py` | REUSE-WITH-PARAMS | `:11-60`; cambiar URL/extracto a CyL/España |
| `scripts/extract_city.py` | REUSE-WITH-PARAMS | `:21` UTM 49N→30N; `:23` regex landmark chino; `:115-117` KeyFilter |
| `scripts/validate_data.py` | REUSE-WITH-PARAMS | `:9-26` |
| `scripts/prepare_driving_city.py` | REWRITE (núcleo vial) | `:1-3` aplanado; `:31` whitelist sin track/path; `:35` filtros; `:39-46` anchos/kind/grade |
| `scripts/prepare_city_streets.py` | SHENZHEN-ONLY | `:11-34`; asfalto/aceras/farolas |
| `scripts/prepare_city_ground.py` | REUSE-WITH-PARAMS | `:8-16` |
| `scripts/build_city_ground.py` | REUSE-WITH-PARAMS | `:5-18`; parte costera SHENZHEN-ONLY |
| `scripts/prepare_landmark_terrain.py` | REUSE-WITH-PARAMS (plantilla DEM) ⚠ | `:102-185,212`; atado a Shenzhen. ⚠ Consume `city.json`/`green.geojson`/`water.geojson` del pipeline urbano → dependencia circular; generalizar cuesta más que «parametrizar» |
| `scripts/prepare_city_mountains.py` | REUSE-WITH-PARAMS | `:22,28,36-53,90`; atado a tiles N22/E113-114 y datum 20 m |
| `scripts/fetch_coastal_dsm.py` | SHENZHEN-ONLY | tiles/SHA de costa china |
| `scripts/prepare_city_ground_relief.py` | SHENZHEN-ONLY | `:4-5` autoral declarado |
| `src/city-types.ts` | REUSE-WITH-PARAMS | `:1-4` |
| `src/city-ground-relief.ts` | REUSE-AS-IS (infra) | `:14-35` |
| `src/city-road-surface.ts` | SHENZHEN-ONLY | asfalto cinematográfico urbano |
| `src/landmark-details.ts` (`terrainHeight`) | REUSE-AS-IS | `:33-42,55-56` |
| `requirements.lock.txt` | REUSE-AS-IS | osmium/shapely/pyproj/rasterio/numpy/pillow |
| `LICENSE` + estructura `data/ATTRIBUTION.md` + `public/licenses/` | REUSE estructura / REWRITE contenido | `LICENSE:1-21`; `README.md:194-207`; `data/ATTRIBUTION.md:3-50` |
| [ADICIONAL] `city_mesh.B` + `face/box/tube/loft/footprint/finish` | REUSE-WITH-PARAMS | Primitivas genéricas sin conocimiento urbano (`scripts/city_mesh.py:32-69`); extraer a `rural_mesh.py` |
| [ADICIONAL] `city_mesh.material()` + paleta + `export()` | SHENZHEN-ONLY | Paleta urbana y rutas `public/city` cableadas (`scripts/city_mesh.py:11,23-31`) |
| [ADICIONAL] `build_canopy_trees.py` (especies + LOD + placement STRtree) | REUSE-WITH-PARAMS | Arquitectura reutilizable; especies subtropicales no sirven (`scripts/build_canopy_trees.py:369`) |
| [ADICIONAL] `build_landscape_assets.py` / `build_open_vegetation.py` / `build_solid_tree_lods.py` | REUSE-WITH-PARAMS | Atlas 1024 + LOD + manifiesto (`scripts/build_landscape_assets.py:268`); contenido urbano a reemplazar |
| [ADICIONAL] `build_vehicle_candidate.py` (pipeline CarConcept→runtime) | REUSE-WITH-PARAMS | Pipeline reutilizable; contenido GT urbano SHENZHEN-ONLY (`scripts/build_vehicle_candidate.py:199-201`) |
| [ADICIONAL] `build_driving_assets.py` (calzadas por teselas 640 m) | REUSE-WITH-PARAMS | Teselado reutilizable; adaptar a tierra (`scripts/build_driving_assets.py:1-3`) |
| [ADICIONAL] `build_traffic_signals.py` (mástiles) | REUSE-WITH-PARAMS | Poste como partida del mástil del repetidor (`:171-182`) |
| [ADICIONAL] `build_city_facades.py` + `split_city_facades.mjs` + streaming | SHENZHEN-ONLY | Fachadas urbanas sin equivalente rural |
| [ADICIONAL] `build_bamboo_cafe.py` / `build_city_life_hub.py` | SHENZHEN-ONLY | Interiores heroicos sin equivalente rural |
| [ADICIONAL] Personajes MMD/miHoYo | SHENZHEN-ONLY (excluir) | Términos NC + no redistribución (`README.md:204`) |
| [ADICIONAL] `src/city-map-geometry.ts` (`wgs84ToMap`, índices) | REUSE-WITH-PARAMS | Núcleo; `wgs84ToMap` → leer `geoConfig` (`src/city-map-geometry.ts:19`) |
| [ADICIONAL] `src/city-road-names.ts` | REUSE-WITH-PARAMS | Núcleo algorítmico; fallbacks chinos → `strings` (`src/city-road-names.ts:8`) |
| [ADICIONAL] `src/city-story-contract.ts` | REUSE-AS-IS | Contrato data-driven ya genérico |
| [ADICIONAL] `src/city-story-content.ts` + career/life + datos relato | SHENZHEN-ONLY | Relato 最后一单, 8 steps (`src/city-story-content.ts`); contratos `city-career.ts:80-85` |

> Nota de correcciones del review (constancia): el review corrigió dos anclas —
> `prepare_landmark_terrain.py:204` → `:205` («No vertical exaggeration» está en `:205`;
> `:204` es blends) y `public/licenses/coastal-terrain.md:19-20` → `:15` (el archivo tiene
> 15 líneas; la nota de generación está en `:15`) (`REVIEW-phase0.md:64-66`,
> `REVIEW-phase0.md:174-178`). Este documento usa las versiones corregidas. Además el orquestador
> degradó `prepare_landmark_terrain.py` de `REUSE-WITH-PARAMS ⚠` a **NO EJECUTABLE / escribir uno
> propio** en este checkout (ver §6); se conserva la fila con su veredicto de review más el matiz
> del orquestador.

## Los hallazgos que cambian el plan

- **Física 2D + pitch visual (no confundir).** `stepCar` ignora por completo la altura:
  no recibe `heightAt`, ni `y`, ni normal, ni pendiente; ninguna de sus 10 líneas menciona altura
  (`driving.ts:6-16`). La Y se pega después, fuera de la física, en `city-world.ts:513`
  (`ground+.115` + micro-bob cosmético), y el "pitch" es puramente visual por diferencias de altura
  a ±1.5 m (`front`/`rear`, `atan2(front-rear,3)`), con roll cosmético `-steer·speed·.0025`
  (`03-conduccion-jugador-fisica.md:34-56`, `REVIEW-phase0.md:23-27`). En cuesta DEM el auto subiría
  igual que en llano (tracción `9·throttle` sin `−g·sinθ`), sin rodar atrás ni deslizar en ladera
  (`03-conduccion-jugador-fisica.md:54`).
- **Núcleo vial: `track`/`path` no existen para el motor.** Whitelist conducible sin
  `track`/`path`/`footway`/`cycleway` (`prepare_driving_city.py:31`); montañas los excluye de firmes
  (`prepare_city_mountains.py:28`); `tracktype`/`smoothness` con 0 lecturas en `scripts/`,
  `surface` sólo material/malla, `access` sólo filtro de descarte (`prepare_driving_city.py:35`)
  (`02-pipeline-datos-y-terreno.md:57-69`, `REVIEW-phase0.md:28-32`). Excepción local drapeada sólo
  dentro del parque Lianhuashan (`prepare_landmark_terrain.py:171-185`), y `grade` = tag `layer`,
  no pendiente (`prepare_driving_city.py:46`) (`02-pipeline-datos-y-terreno.md:64-68`).
- **Terreno: plano 0 + parche DSM real + relleno autoral.** Base ciudad plana a 0 a propósito
  (`"Roads are deliberately flattened"`, `prepare_driving_city.py:1-3`; `terrainHeight` retorna 0
  fuera del parche, `landmark-details.ts:33-36`); `terrain-detail.json` (Lianhuashan) = DSM real
  Copernicus GLO-30 30 m, bilineal a 15 m reales = 9 u. juego, datum percentil 25 del borde
  (`prepare_landmark_terrain.py:91-92`, `:124-126`), sin exageración vertical
  (`prepare_landmark_terrain.py:205` — ancla corregida por el review); `mountain-relief/` = DSM
  real + césped autoral mezclado (`grey_opening(3,3)+gaussian(.8)`,
  `prepare_city_mountains.py:44`; `lawn` senoidal, `:51-53`); `ground-relief` = 100% autoral
  (`"these slopes are authored landscape, not survey data"`,
  `prepare_city_ground_relief.py:4-5`) (`02-pipeline-datos-y-terreno.md:73-83`,
  `REVIEW-phase0.md:33-39`). Regla general: vías aplanadas a 0 y el terreno se aplana hacia las
  vías; sólo `service` en parque y `path/footway/steps` se drapean
  (`prepare_landmark_terrain.py:160-185`) (`02-pipeline-datos-y-terreno.md:85-90`).
- **Template DEM no ejecutable.** `prepare_landmark_terrain.py` exige
  `data/processed/shenzhen_study/{green,water,roads}.geojson` y `data/processed/` **no existe**;
  el script **no puede ejecutarse** (ver §6). Lo reutilizable es la semántica, no el código
  (`REVIEW-phase0.md:141-160`).
- **`grip` muerto y superficie sólo visual.** `grip=1` por defecto y ningún llamador lo pasa
  (`city-world.ts:507`, `city-autopilot.ts:194,277`); sólo escala `vmax` (`53·grip`,
  `driving.ts:13`). `city-road-surface.ts` es 100% sombreado (plugin `AsphaltDryFilm`); `offroad`
  (`city-world.ts:502`) sólo alimenta audio (`city-world.ts:536`), no la dinámica
  (`03-conduccion-jugador-fisica.md:58-63`, `REVIEW-phase0.md:24-25`).
- **`blocked` exige `land` o prohíbe el off-road.** Sin `land` que cubra el DEM, todo fuera de
  calzada = bloqueado (`return !this.data.land.some(...) || this.data.water.some(...)`,
  `src/driving.ts:34`); `nearest` sólo busca en la celda propia (`driving.ts:29`)
  (`03-conduccion-jugador-fisica.md:65-76`, `REVIEW-phase0.md:42`).
- **Streaming = base monolítica + un solo stream urbano.** Sin quadtree ni LOD morfado:
  `ImportMeshAsync` completo + `CityFacadeStream` (700/1050/1500 m,
  `src/city-facade-stream.ts:9-12`, `src/city-facade-stream.ts:18-34`) + culling binario
  `setEnabled` a 700/2500/3300 m (`src/city-world.ts:435`) y sombras 520–700 m calle /
  1450–1650 m aéreo (`src/city-world.ts:435-437`); re-cull 100 m / re-veg 22 m / throttle 0.25 s
  (`src/city-world.ts:545-550`) (`01-runtime-y-streaming.md:40-55`,
  `REVIEW-phase0.md:44-48`). Los números presuponen ciudad densa plana vista a < 3 km: sin LOD
  geométrico, impostores ni streaming de terreno (`01-runtime-y-streaming.md:55`).
- **Coordenadas: centralizado en apariencia, disperso en la práctica.** Ver §5.

## Frontera de reutilización

- **Se copia tal cual:** render loop + instrumentación; stalls glTF + Meshopt; telemetría/benchmarks;
  `RoadGraph` + Dijkstra; controles/cámaras/cabina (re-anclar pose); walk/exit/enter + rider;
  `terrainHeight` (interpolación + validación); infra `city-ground-relief.ts` como compositor;
  `requirements.lock.txt`; `finalize` + `rebuild` + `check-*` (adaptando rutas); `.gitattributes` +
  `.gitignore`; regla de exportación (metros, este/norte/arriba, `export_yup=True` sin cámaras/luces,
  neutralizar raíz + hornear reflexión Z, auditar nodos identidad si hay pivotes)
  (`01-runtime-y-streaming.md:91-100`, `03-conduccion-jugador-fisica.md:100-110`,
  `04-assets-blender-licencias.md:200-203`, `04-assets-blender-licencias.md:381-382`).
- **Se parametriza:** boot/loader (17 stages y textos Shenzhen,
  `src/city-loading.ts:5-23`); perfiles de calidad (recalibrar a rural,
  `src/city-graphics-quality.ts:1-8`); culling + `renderList` (umbrales de ciudad densa);
  cadena `groundHeight` (capas costeras/urbanas → DEM); manifiestos (esquema sí, contenido no);
  save (renombrar claves `shenchengji-*`); `CityCollision` (extent DEM, margen
  `width/2−.65`); snap + pitch (añadir roll lateral + suspensión de 4 ruedas); tráfico
  (densidad/velocidad, `directionAllowed`); autopilot (velocidades, `poseClear`, coste por
  superficie); `Road` con `surface/tracktype/smoothness/gradeDEM`; todo `scripts/` con origen
  hard-codeado → leer de `geo-config`; builders Blender (paleta `public/rural/`, especies
  pino/roble/haya, 4x4 en vez de GT, tierra con roderas en vez de asfalto)
  (`01-runtime-y-streaming.md:90-99`, `02-pipeline-datos-y-terreno.md:102-119`,
  `03-conduccion-jugador-fisica.md:102-110`, `04-assets-blender-licencias.md:370-379`).
- **Se escribe nuevo:** `stepCar` off-road (`−g·sinθ`, lateral, superficies, reducida, vuelco);
  stream de heightfield/vegetación (reemplaza `CityFacadeStream`); núcleo vial rural (whitelist
  `track/path`, anchos por `tracktype`/`surface`, drapeado DEM); downloader IGN; `geo-config`
  único; `locale/strings`; `ATTRIBUTION.md` + `public/licenses/` propios; assets MVP (terreno MDT,
  4x4 CC0/CC-BY, pistas, pinos/robles, cercas/portones, repetidor)
  (`02-pipeline-datos-y-terreno.md:121-125`, `03-conduccion-jugador-fisica.md:112-125`,
  `04-assets-blender-licencias.md:389-404`, `05-acoplamiento-shenzhen.md:63-69`).
- **Origen/escala: una ocurrencia en runtime, doce en scripts.** Runtime: sólo
  `src/city-map-geometry.ts:19` (`wgs84ToMap`: `[(lon - 114.025) * 102850 * .6, ...]`);
  `grep -rn "114\.025\|102850\|111320" src/` → 1 archivo, 1 línea; `grep -rn "EPSG" src/` → 0
  (`05-acoplamiento-shenzhen.md:13-21`, `REVIEW-phase0.md:53-55`). Scripts: 12 archivos con
  definiciones duplicadas y variantes (con/sin `*0.6`, pre-multiplicada 61710/66792)
  (`05-acoplamiento-shenzhen.md:39-54`, `REVIEW-phase0.md:54`). Origen/escala horneados además en
  docenas de JSON (`city.json` meta, `map-places.json:5`, landmarks, `config/regions.json:2`)
  (`05-acoplamiento-shenzhen.md:23-37`). Plan: un solo `geo-config`
  `{originWGS84, metresPerDegree, scale, verticalScale, bbox, extent, spawn}` inyectado al motor;
  prohibir literales (`05-acoplamiento-shenzhen.md:63-69`). Convención crítica: no mezclar EPSG:32649
  (investigación temprana) con origen local + 0.60 (juego embarcado)
  (`05-acoplamiento-shenzhen.md:6-9`).

## Insumos que NO existen en el checkout

Verificado por el orquestador contra el repo real (`REVIEW-phase0.md:136-172`):

- **`data/processed/` no existe.** `prepare_landmark_terrain.py` exige
  `data/processed/shenzhen_study/{green,water,roads}.geojson` (`:86-87`, `:134`, `:170-171`) y
  **no están** (`data/` contiene sólo `ATTRIBUTION.md`, `landmarks/`, `locations/`,
  `map-places.json`, `materials/`, `references/`). `public/city/city.json` (`:79-80`) sí existe
  (8.365.073 bytes). Faltan 3 de 4 insumos: el script **no puede ejecutarse**. No es un template a
  parametrizar; veredicto degradado a **NO EJECUTABLE / escribir uno propio**. Se conserva la
  semántica (ventana rasterio + bilineal, datum percentil del borde, blends, drapeado).
- **219 `.glb` = punteros Git LFS de 129–133 bytes** (primera línea
  `version https://git-lfs.github.com/spec/v1`, `size 177916` en `public/city/facades.glb`);
  **`git-lfs` no instalado**, sin config LFS, único remoto `upstream`. Cero mallas utilizables ⇒
  **ningún** presupuesto de draw calls/triángulos/GPU medible contra la referencia; el objetivo de
  performance se construye sobre la escena propia.
- **Acoplado:** `01` ya advertía que los GLB del checkout miden ~130 bytes (stubs/LFS) sin peso real
  validable (`01-runtime-y-streaming.md:125`); `02` marcaba deploy exacto vía `sync-r2.mjs:28` sin
  auditar a fondo y `ground-relief` como candidato (`02-pipeline-datos-y-terreno.md:130`).

## Contradicciones y alcance no cubierto

- **C1 — `driving.ts` UNKNOWN vs auditado entero.** `01 §9.3` declara camino rural = UNKNOWN (no
  auditado `driving.ts`) (`01-runtime-y-streaming.md:116`), mientras `03` audita `driving.ts:2-16`
  completo con ecuaciones (`03-conduccion-jugador-fisica.md:7-32`). Vale la versión de `03`
  (confirmada por el review: `src/driving.ts:6`, cuerpo 6–16). Severidad: descoordinación, no invalida
  (`REVIEW-phase0.md:15`, `REVIEW-phase0.md:120`).
- **C2 — `navigation.json` sin consumo vs rastreado.** `02 §Confianza` declara grafo
  `navigation.json` con consumo no rastreado (`02-pipeline-datos-y-terreno.md:131`), mientras `01`
  lo rastrea: `fetch('/city/navigation.json')` → `RoadGraph` → `world.startTraffic(graph)`
  (`src/main.ts:201`, `src/city-world.ts:295`) (`01-runtime-y-streaming.md:20`). Vale la versión de
  `01`. Misma clase de descoordinación (`REVIEW-phase0.md:120`).
- **C3 — Dos anclas fuera de rango (corregidas).** `prepare_landmark_terrain.py:204` → `:205`;
  `public/licenses/coastal-terrain.md:19-20` → `:15` (`REVIEW-phase0.md:61-66`). Aplicadas en este
  documento; severidad baja/muy baja.
- **Alcance no cubierto:** ~85–90 `src/` sin inspección individual (física vuelo/tanque, clima,
  iluminación, cámaras, combate, trailer, peatones/tráfico, ebikes…) — lista en
  `05-acoplamiento-shenzhen.md:222-236`; regla de 2ª pasada: ¿nombra Shenzhen/personas/Han? →
  contenido; ¿opera sólo sobre `CityData`/primitivas? → núcleo
  (`05-acoplamiento-shenzhen.md:238`). Catálogo de audio/personajes no inventariado exhaustivo;
  `city_mesh.export` (`build_city_ground.py:4,18`) sin leer `city_mesh.py` en el packet 02;
  coste MDT05 5 m y datum vertical IGN requieren muestra IGN no disponible
  (`02-pipeline-datos-y-terreno.md:127-131`, `05-acoplamiento-shenzhen.md:328-337`). Nada se
  compiló ni ejecutó (lectura estática; sin validación de build ni pipeline punta a punta)
  (`REVIEW-phase0.md:118`).

## Riesgos abiertos

De `REVIEW-phase0.md:115-124` (8 riesgos). Estado tras la verificación del orquestador
(`REVIEW-phase0.md:136-172`):

1. Dependencia circular del "template DEM" — **VERIFICADO y agravado**: NO EJECUTABLE (ver §6).
2. Nada se compiló ni ejecutó — **ABIERTO** (lectura estática; `01` confirma que no se compiló nada,
   `01-runtime-y-streaming.md:126`).
3. GLB stubs / presupuestos GPU no verificables — **VERIFICADO** (219 punteros LFS; ver §6).
4. Contradicciones de alcance entre autores — **VERIFICADO** (C1/C2; ver §7); resuelto por
   consolidación, no por re-auditoría.
5. Datum vertical IGN — **ABIERTO** (MDT05/25 no es EGM2008 directo; error sistemático no auditado).
6. Presupuesto 6×6 km @5 m (~1.44M nodos vs 15–20 m probados, techos 200k/260k tris) — **ABIERTO**
   (sin medición de memoria/streaming).
7. §5.2 de licencias es opinión de ingeniería, no legal — **ABIERTO** (requiere revisión legal real
   para distribución MIT-compatible con data-pack ODbL/CC-BY).
8. Interpretación ODbL de "Produced Works" (GLB no contagia, BD derivada sí) — **ABIERTO** (lectura
   habitual no verificada contra el texto legal).

Riesgo principal transversal de `04`: licencias — replicar desde el primer asset la disciplina de
manifiestos (`data/ATTRIBUTION.md` + `public/licenses/` + `delivery-manifest.json` con hashes);
nada NC en `public/` si la distribución debe ser MIT-compatible
(`04-assets-blender-licencias.md:340-345`, `04-assets-blender-licencias.md:425-428`). Y de `05`:
diez trampas de ciudad densa (volumetría, celdas 512/160, spawn en arteria, fachadas/neones, grafo
denso, 56 walkers + ebikes, mar plano, escala 0.60, fallbacks chinos, contenido come-motor,
licencias no portables) (`05-acoplamiento-shenzhen.md:282-324`).

## Qué falta para la FASE 1/2/3

- **FASE 1 (motor des-shenzhenizado):** `geo-config` único + `strings`/`locale` (motor 100% libre de
  Han; validación: rechazar packs con `schemaVersion` desconocida u origen fuera de bbox,
  `05-acoplamiento-shenzhen.md:279-280`); renombrar claves `shenchengji-*`; 2ª pasada sobre los
  ~85–90 `src/` con la regla Han-vs-primitivas; fijar Blender LTS pinneado + ruta Linux + LFS día 1
  (`04-assets-blender-licencias.md:353-357`).
- **FASE 2 (terreno + datos):** downloader IGN + `config/regions.json` Villafranca (~42.38°N, 3.31°O,
  UTM 30N/EPSG:25830, origen/BBOX nuevos); ingesta DEM propia (semántica rasterio + bilineal +
  datum + blends + drapeado; código nuevo, NO el script actual); desactivar edificios (sólo
  ermita/núcleo como landmarks); `land` = extent DEM; atribución triple OSM-ODbL + IGN-CC-BY
  (+Copernicus sólo si se conserva) (`02-pipeline-datos-y-terreno.md:121-125`).
- **FASE 3 (vial + física off-road):** REWRITE núcleo vial (whitelist `track/path/bridleway`, anchos
  por `tracktype`/`surface`, preservar `surface/smoothness` en `Road`, drapear sobre DEM);
  física en orden MVP: pendiente → superficies → reducida → suspensión visual → obstáculos →
  lateral/vuelco → polvo → AI rural (`03-conduccion-jugador-fisica.md:125`); stream de
  heightfield/vegetación + LOD (reemplaza fachadas); assets MVP con builders de partida
  identificados en `04 §8` (terreno, 4x4, pistas, pinos/robles, cercas/portones, repetidor).

---

*Validación: tabla con 50 filas (36 del review + 14 adicionales de 01/02/04/05); anclas verificadas
por grep sobre las 6 fuentes (conteo reportado en la respuesta final).*
