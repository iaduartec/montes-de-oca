# Auditoría W1 — Runtime, boot y streaming

> Repo auditado (READ-ONLY): `/home/kiri_/projects/montes-de-oca`
> Todas las anclas `archivo:línea` refieren a ese repo salvo indicación contraria.
> Stack base: Babylon.js 8 + TypeScript + Vite (`package.json:19-21`, `package.json:7-17`).
> Pregunta central: qué es motor genérico vs contenido específico de Shenzhen.

## 1. Secuencia de boot (de `index.html` al primer frame)

1. `index.html:12` monta `<canvas id="game">` + `<div id="ui">`; `index.html:14` carga `/src/main.ts` como módulo.
2. `src/main.ts:22` monta el loader (`createCityLoading(document.body)`, overlay fuera de `#ui` para sobrevivir al `initUI` que reemplaza `#ui.innerHTML` — ver `src/city-loading.ts:31`).
3. `src/main.ts:23` resuelve el canvas `#game`.
4. `src/main.ts:201` (`boot()`): `world = new DrivingWorld(canvas)` — el constructor (`src/city-world.ts:143-221`) crea `Engine`, `Scene`, cámara, luces, `ShadowGenerator`, `DefaultRenderingPipeline`, SSAO, espejos, sky, y **arranca el render loop inmediatamente** (`src/city-world.ts:218`), pero con guarda `if (document.hidden || !this.ready) return` — no hay frames de simulación hasta `ready=true`.
5. `await world.init(s => loading.update(s))` (`src/main.ts:201` → `src/city-world.ts:249-294`). Etapas internas (cada `progress()` mapea a un stage del loader por label, `src/city-loading.ts:95-106`):
   - `fetch('/city/city.json')` → `this.data` (`src/city-world.ts:250`); `loadRoadDisplayNames`; `loadLandmarkDetails` (define `groundHeight` base); `loadLandmarkCandidates`.
   - Cadena de `groundHeight` por decoración sucesiva: montañas (`src/city-world.ts:250`), relief de parques (`src/city-world.ts:250`), infraestructura costera (`src/city-world.ts:250`), layout del café (`src/city-world.ts:261`).
   - `CityCollision`, `CityWalk`, `state = {...data.spawn}` (`src/city-world.ts:250`).
   - Carga de GLBs base en orden: `terrain`, `roads`, `coastal-bridges`, `coastal-shoreline`, `opposite-shore` (`src/city-world.ts:251`); `buildings` + `CityFacadeStream.init` (`src/city-world.ts:252`); `landmarks`, reemplazo por `landmark-detail` y `landmark-candidates` (`src/city-world.ts:254-256`); señalética, café bambú, carteles, `traffic-car`, `vehicle-manifest.json`, `car` (`src/city-world.ts:257-264`); paisaje/canopy/rooftops, mobiliario, semáforos, ebikes (`src/city-world.ts:266-267`); corredor bambú, reflexiones, peatones, `lamps.json`, `park-floodlight`, iluminación pública (`src/city-world.ts:268-277`); look cinematográfico, materiales del coche, charcos/lluvia, luces locales (`src/city-world.ts:278-286`); agua, `CityFlight`, `CityTank` (`src/city-world.ts:290-291`).
   - `ready=true`, posiciona coche/cámara en `spawn`, `applyGraphicsQuality()` (`src/city-world.ts:292-293`).
6. `loading.update('navigation')` + `fetch('/city/navigation.json')` → `RoadGraph` → `world.startTraffic(graph)` (`src/main.ts:201`, `src/city-world.ts:295`).
7. `fetch('/city/life-sites.json')` → se agregan landmarks `life:*` a `world.data.landmarks` (`src/main.ts:201`).
8. `initUI()` + `initLife()` (`src/main.ts:201` → `src/main.ts:134`, `src/main.ts:82`); `await cityMap?.ready`.
9. `createCareerExperience` + `await career.ready` + `mountCityStory()` (`src/main.ts:201`, `src/main.ts:48`).
10. Se expone `window.__SHENCHENGJI_CITY__` (ready/world/telemetry/state/performance/stats) y `void boot()` (`src/main.ts:201-202`). UNKNOWN: no se verificó dónde se llama a `loading.finish()/reveal()` (la línea 201 está truncada a 2000 chars en lectura; el loader exige `finish()` antes de `reveal()`, `src/city-loading.ts:113-121`).

Nota: `src/world.ts` (`World`, calle/habitación con `street.glb`, `room.glb`) es un prototipo anterior ajeno al boot real — el juego bootea `DrivingWorld` de `src/city-world.ts`. `src/state.ts` + `src/save.ts` (IndexedDB) pertenecen a ese prototipo y **no** los usa el boot (`main.ts` usa `city-life.ts` + localStorage).

## 2. Scene / render loop / calidad

- Engine: `new Engine(canvas, true, {stencil:true, powerPreference:'high-performance'}, false)` + `resize()` con `cityGraphicsRenderRatio` (`src/city-world.ts:144`, `src/city-world.ts:222`, `src/city-graphics-quality.ts:22-26`).
- Loop único: `engine.runRenderLoop(...)` con `dt = min(raw/1000, .05)`, guarda de `document.hidden`/`ready`, `update(dt)` + `scene.render()`, métricas `updateMs`/`renderMs`, buffer de `samples` hasta 36000 (`src/city-world.ts:218`).
- Perfiles: `low | medium | high` (`src/city-graphics-quality.ts:1-8`): `maxPixels`, `shadowSize` (1024/2048/2048), `ao` on/off + `aoSamples`, `mirrorSize` 256/384/512, tasas de refresco de espejos en movimiento/reposo, `vehicleProbe`, `msaa` 1/2/4, `bloomScale`, `lensEffects` (solo high + no-día), presupuestos de vegetación (`nearTrees/farTrees/aerialTrees`, `treeRadius`, `canopy*`, `meadowClumps`) y `detailScale`.
- Aplicación: `applyGraphicsQuality()` (`src/city-world.ts:100-108`) — resize, tamaño de shadowmap + `applyShadowBias()` (`src/city-world.ts:402`), `refreshRate` de sombras (12 en aéreo), resize de espejos, `syncGraphicsPostEffects()` (`src/city-world.ts:88-99`: MSAA/FXAA/grain/cromaticismo/bloom según perfil + attach/detach de SSAO), propaga a `landscape`/`canopy`/`vehicleReflections`, y si `ready`: `vegetation()` + `cull()`.
- Selección/persistencia: query `?quality=` > localStorage `shenchengji-graphics-quality-v1` > `medium` (`src/city-graphics-quality.ts:10-21`); lectura en campo `graphicsQuality` (`src/city-world.ts:81`); cambio en caliente vía panel (`src/main.ts:145`).
- Sombras dual-frustum: caja 260 m (calle) vs 1050 m (aéreo/observador alto), `shadowMaxZ` 1200→3200, `refreshRate` 1→12, `normalBias` escalado por texel (`src/city-world.ts:75`, `src/city-world.ts:402-403`). El umbral aéreo se decide por altura sobre el terreno en `update()` (`src/city-world.ts:521-526`).
- Contact-shading SSAO: render-list acotada a alcance `maxZ 130 m + margen 100 m` (`src/city-world.ts:59-69`, `src/city-world.ts:447`); se desactiva en aéreo o en `low` (`src/city-world.ts:447`).

## 3. Streaming: esquema, distancias, presupuestos, LOD

No hay quadtree ni LOD morfado. El esquema es **carga total de base + streaming de un solo sistema (fachadas) + culling por distancia con `setEnabled`**:

| Capa | Estrategia | Distancias / presupuesto |
|---|---|---|
| Base (`terrain`, `roads`, `buildings`, `landmarks`, costa) | `ImportMeshAsync` completo una vez en `init`, `freezeWorldMatrix` por mesh (`src/city-world.ts:246-248`, `src/city-world.ts:251-254`) | Sin streaming; siempre en memoria. Tiles lógicos de 640 m solo para culling (`(Number(m[1])+.5)*640`, `src/city-world.ts:253-254`) |
| Fachadas finas (`CityFacadeStream`, 150 tiles, `public/city/facade-tiles.json`) | Único stream real: `init` carga tiles < 700 m; `pump()` de a 1 tile < 1050 m; `dispose` de geometría > 1500 m; visibilidad `setEnabled` < 700 m (`src/city-facade-stream.ts:9-12`, `src/city-facade-stream.ts:18-34`) | Radios 700 / 1050 / 1500 m; en aéreo `loadDelay 250 ms` y las fachadas se ocultan (`src/city-world.ts:431`) |
| `landmark-detail.glb` / `landmark-candidates.glb` | Reemplazo por prefijo: se eliminan meshes base y se cargan los de detalle (`src/city-world.ts:254-256`, `src/landmark-details.ts:57-63`) | Carga única, no streameada |
| Sombras | `renderList` reconstruida en `cull()`: bloques no-viales < 520 m (1650 m en aéreo), landmarks < 700 m (1650 m), relief < 650 m (1450 m), fachadas < 520 m (`src/city-world.ts:435-437`) | Ventanas 520–700 m calle / 1450–1650 m aéreo |
| Dibujado | `blocks[].mesh.setEnabled`: detalle < 700 m, viales < 2500 m, base < 3300 m (en aéreo se conservan no-detalle + `*_asphalt`) (`src/city-world.ts:435`) | 700 / 2500 / 3300 m |
| Reflejos (`MirrorTexture` vía/agua) | `renderList` filtrada por frustum custom (`src/city-world.ts:186-190`), `refreshRate` adaptativo movimiento/reposo por perfil (`src/city-world.ts:557-559`) | `mirrorMovingRate` 1–3, `roadIdleRate` 2–5, `waterIdleRate` 3–6 (`src/city-graphics-quality.ts:5-7`) |
| Vegetación/pueblo | `landscape/canopy/rooftops.update(focus, aéreo)` con presupuestos por calidad; `streetFurniture`/`bambooCorridor`/`rainPuddles` en throttle (`src/city-world.ts:467-473`, `src/city-world.ts:545-552`) | Re-cull si foco se mueve > 100 m; re-vegetación si > 22 m; throttle 0.25 s (`src/city-world.ts:545-550`) |
| G-buffer SSAO | Solo meshes cuyo bounding-sphere alcance 230 m del foco (`src/city-world.ts:447`) | 130 + 100 m |

Mitigación de stalls: extensión glTF `SHENCHENGJI_preserve_scene_lights` congela la promoción global de `maxSimultaneousLights` durante cargas y solo ensucia materiales con cambio neto (`src/city-gltf-streaming.ts:7-62`). Meshopt decoder en `/city/meshopt_decoder.js` (`src/city-world.ts:7`).

**¿Genérico o con forma de ciudad densa?** El mecanismo (`ImportMeshAsync` + `setEnabled` por distancia + `renderList` de sombras/reflejos + throttle por foco) es genérico. Pero los números (700/2500/3300 m, tiles de 640 m, fachadas como única capa streameada, proxies lejanos = las propias mallas base) presuponen **ciudad densa y plana vista a < 3 km**: no hay LOD geométrico, ni impostores, ni streaming de terreno.

## 4. Formato de manifiesto: `city.json` vs `landmark-detail.json` + merge

- `public/city/city.json` (base, ~12 k vías / 16 k edificios / 10 landmarks): claves `meta, land, coast, roads, buildings, green, water, landmarks, spawn` (`src/city-types.ts:4`; verificado contra el JSON real). `meta` trae `counts`, `extent: [-6788.1, -2604.89, 6788.1, 2604.89]`, `horizontalScale: 0.6`, bbox/origen WGS84 de Shenzhen. `Road`: `{id, name, kind, width, oneway, points, grade}` (`src/city-types.ts:2`). `Landmark`: `{id, name, x, z, height, area, excludeRadius, arrival, yaw, photo*}` (`src/city-types.ts:3`). `spawn: {x:-2664.2, z:-862.2, yaw, road:'滨海大道'}`.
- `public/city/landmark-detail.json` (incremento opcional, `schemaVersion: 1`): `{asset: '/city/landmark-detail.glb', replacedMeshPrefixes, baseBuildingIds, landmarks[6], collisionFootprints[19], terrain: {url: '/city/terrain-detail.json'}}` con validación estricta de esquema (`src/landmark-details.ts:23-27`, `src/landmark-details.ts:50-56`).
- Merge en runtime (`src/landmark-details.ts:57-65`): filtra edificios base por `baseBuildingIds`, añade `collisionFootprints` como edificios `style:'landmark-detail'`, fusiona/añade landmarks por `id` (los existentes conservan colocación y solo toman campos de detalle en el caso de candidatos, `src/landmark-details.ts:85-89`), actualiza `meta.counts.landmarks`. El `heightAt` del detalle (grid E/N con diagonal SW→NE, `src/landmark-details.ts:33-42`) **reemplaza** la función base y luego es decorado por montañas/relief/costa/café.
- `landmark-candidates.json` es un segundo incremento opcional con la misma forma + `sources[]` (`src/landmark-details.ts:68-98`); archivo ausente (404/HTML) = capa omitida (`src/landmark-details.ts:48`, `src/landmark-details.ts:80`).
- Otros manifiestos leídos en boot: `navigation.json` (grafo para `RoadGraph`, `src/main.ts:201`), `life-sites.json` (landmarks `life:*`, `src/main.ts:201`), `vehicle-manifest.json` (`wheelRadius`, anclas de faros, centros de rueda, `src/city-world.ts:264`), `lamps.json` (`src/city-world.ts:277`), `facade-tiles.json` (`{tiles:[{id,x,z,bytes,...}]}`, 150 tiles, `src/city-facade-stream.ts:9`).

## 5. Save / state

Dos sistemas paralelos (el prototipo y el juego real):

- Prototipo no usado por el boot: `GameState` validado + IndexedDB `shenchengji-v1` (`src/state.ts:27-43`, `src/save.ts:2-24`).
- Juego real (localStorage, tolerante a fallo con try/catch):
  - `shenchengji-city-life-v1`: `{version:1, cash, completed[]}` + `ActiveRide` en memoria (`src/city-life.ts:1-10`, `src/main.ts:31`, `src/main.ts:102`).
  - `shenchengji-city-career-v2` (`src/city-career.ts:18`, persistido en `src/city-career-experience.ts:21-35`, con migración del legacy `city-life-v1`).
  - `shenchengji-graphics-quality-v1` (`src/city-graphics-quality.ts:2`).
  - `shenchengji-observer-places-v1` (favoritos del dron, `src/city-observer-beacon-state.ts:3`).
  - `shenchengji-city-story-v1` (`src/city-story.ts:7`), prefs de audio (`src/city-audio.ts:27`, clave exacta UNKNOWN — no leída la constante).
- Qué se persiste: efectivo, misiones legado completadas, progreso de carrera/historia, calidad gráfica, favoritos, prefs de audio. **No** se persiste posición del coche, hora, clima ni estado de tráfico (todo `UNKNOWN` verificado como ausente en los tipos de save leídos).

## 6. Tooling de performance presente

- Panel de calidad en juego: `createCityGraphicsPanel` con 3 niveles (低/中/高), montado en `#ui` (`src/city-graphics-panel.ts:1-18`, `src/main.ts:145`), con `update({hidden})` por estado de menú (`src/main.ts:182`).
- Hooks de benchmark/telemetría: `window.__SHENCHENGJI_CITY__` expone `telemetry/state/performance/stats` (`src/main.ts:201`); `DrivingWorld.diagnostics()` (luces, materiales, compiles de shaders, draws, espejos, fachadas, precisión de profundidad) y `performance()` (p50/p95/p99 excluyendo 120 primeros frames, `over50ms`, meshes/triángulos) (`src/city-world.ts:566-567`); `SceneInstrumentation` + `EngineInstrumentation` (GPU/shader time) (`src/city-world.ts:147`); `world.samples` hasta 36000 (`src/city-world.ts:218`).
- HUD FPS oculto tras `KeyP` (`src/main.ts:197`); panel de toggles `?profile` (fachadas/sombras/reflejos/SSAO/simulación, `src/city-world.ts:220`, `src/city-world.ts:565`).
- Scripts: `benchmark:city` (Playwright, 3 ventanas de conducción con teclado real, rutas del `RoadGraph`, `scripts/city-benchmark.mjs:1-24`), `test:city` (`scripts/city-tour.mjs`), `test:city-life`, más `vite preview` (`package.json:7-17`).
- `vite.config.ts` no aporta tooling de perf: solo endurece el dev-server (HMR off, ignores de GLB/HDR para no matar el watcher, `vite.config.ts:3-11`).

## 7. Veredicto de reutilización por subsistema

| Subsistema | Veredicto | Justificación + ancla |
|---|---|---|
| Boot + loader por etapas | REUSE-WITH-PARAMS | El mecanismo (`update/finish/reveal`, progreso por etapas, film de fondo) es genérico (`src/city-loading.ts:95-121`); los 17 stages y textos están hardcodeados a Shenzhen (`src/city-loading.ts:5-23`) |
| Render loop + instrumentación | REUSE-AS-IS | `dt` clampado, guardas `hidden/ready`, `Scene/EngineInstrumentation` y `diagnostics()/performance()` no tocan contenido (`src/city-world.ts:218`, `src/city-world.ts:566-567`) |
| Perfiles de calidad + panel | REUSE-WITH-PARAMS | Selección por query/storage y aplicación (sombras/espejos/MSAA/bloom/vegetación) genérica (`src/city-graphics-quality.ts:10-26`, `src/city-world.ts:100-108`); los números (radios de árboles, `maxPixels`) hay que recalibrarlos a rural |
| Mitigación de stalls glTF (`preserve_scene_lights`) + Meshopt | REUSE-AS-IS | Extensión de loader sin contenido urbano; vale para cualquier stream de GLB (`src/city-gltf-streaming.ts:56-62`, `src/city-world.ts:7`) |
| `CityFacadeStream` (único stream) | REWRITE | Radios 700/1050/1500 m y tiles de 640 m con forma de manzana urbana (`src/city-facade-stream.ts:18-34`); en rural se necesita stream de heightfield/vegetación, no de fachadas |
| Culling por distancia + `renderList` sombras/reflejos | REUSE-WITH-PARAMS | El patrón (`setEnabled` + listas explícitas + throttle por foco) sirve (`src/city-world.ts:431-451`, `src/city-world.ts:545-550`); los umbrales (700/2500/3300 m, re-cull 100 m) son de ciudad densa |
| Cadena `groundHeight` decorada | REUSE-WITH-PARAMS | El patrón de componer samplers (`landmark-details → mountains → relief → coastal → café`, `src/city-world.ts:250-261`) es reutilizable; las capas concretas son costeras/urbanas |
| Terreno base + relieve + montañas | SHENZHEN-ONLY | Plano de ciudad + parches aditivos (relief de parques, relieve montañoso con presupuestos 260 k tris/180 tiles, `src/city-mountains.ts:21-27`) atados a la geografía de Shenzhen |
| Manifiestos `city.json` + incrementos | REUSE-WITH-PARAMS | Esquema (`CityData`, `schemaVersion`, merge por `id`, 404 = capa opcional) genérico (`src/city-types.ts:1-4`, `src/landmark-details.ts:44-66`); el contenido (OSM Shenzhen, escala 0.6, landmarks) es SHENZHEN-ONLY |
| Save/state | REUSE-WITH-PARAMS | Patrón localStorage versionado con migración legacy (`src/city-career-experience.ts:21-35`, `src/city-life.ts:5`); claves y economía (`city-life-v1`, `city-career-v2`) hay que renombrarlas |
| Telemetría/benchmarks (`__SHENCHENGJI_CITY__`, `city-benchmark.mjs`) | REUSE-AS-IS | Harness agnóstico al contenido: rutas del `RoadGraph` + entrada por teclado (`scripts/city-benchmark.mjs:1-24`, `src/main.ts:201`) |

## 8. Acoplamientos hardcodeados a Shenzhen (en los archivos auditados)

- `src/city-loading.ts:5-23`: labels de stages (`正在展开深圳地图`, `南山、福田、罗湖建筑`, `深圳地标`, `深圳山脊`, `海岸线`); `src/city-loading.ts:28-29`: media `/city/loading/bamboo-clay-loop.mp4`; `src/city-loading.ts:39-40`: `SHENZHEN / OPEN ROADS`, `深城纪`, distritos `南山/福田/罗湖`.
- `src/city-world.ts:250-252`: `progress('正在展开深圳地图' / '深圳山脊' / '南山、福田、罗湖建筑')`; `src/city-world.ts:254`: `装配深圳地标`; `src/city-world.ts:379`: fallback `m.id==='civic'?380`; `src/city-world.ts:495`: fallback `landmarks.find(m=>m.id==='baypark')`; `src/city-world.ts:142`: `roadName='滨海大道'`; `src/city-world.ts:420`: carteles solo < 650/700 m de `data.spawn`; `src/city-world.ts:258`: café `春笋旁`; meshes `opposite-shore`, `coastal-*` (`src/city-world.ts:251`).
- `src/main.ts:31`, `src/main.ts:102`: clave `shenchengji-city-life-v1`; `src/main.ts:59-60`: landmark `story:bay-last-delivery`, área `城市故事`; `src/main.ts:85-87`: rides `coast-shift/office-evening/day-pay` con `place('civic'/'xiangmi'/'tencent')`; `src/main.ts:107`: `waterHeight ?? -.25`; `src/main.ts:110`: regex de superficies `terrain_|ground_relief_|bay-horizon-water`; `src/main.ts:135-136`: UI `深城纪/南山·后海/南山→福田→罗湖/海湾 GT/滨海大道`; `src/main.ts:180-181`: radios de reveal 520/650 m.
- `src/city-graphics-quality.ts:2`, `src/city-career.ts:18`, `src/city-observer-beacon-state.ts:3`, `src/city-story.ts:7`, `src/save.ts:2`: claves `shenchengji-*`.
- `index.html:2,7-8,12`: `lang="zh-CN"`, descripción de Shenzhen, `aria-label` chino.
- `public/city/city.json`: `bboxWGS84 [113.915,22.497,114.135,22.575]`, `originWGS84 [114.025,22.536]`, `horizontalScale 0.6`, `extent` ±6788×2604 m, `spawn` en 滨海大道; `landmark-detail.json`: prefijos `landmark_tencent_|lianhua_|civic_`, terreno `莲花山`.
- `src/world.ts` / `src/state.ts` (prototipo, no boot): rescalados de calle `±5.55/1.5–98` (`src/world.ts:144`), clamps de save `x ±5.4 / z 2–98` (`src/state.ts:41`), economía y textos chinos (`src/state.ts:9-26`).

## 9. Gaps para un rural 6×6 km + red viaria

1. **Sin heightfield base con streaming**: el suelo es `terrain.glb` monolítico + parches aditivos locales (grid de莲花山, `src/landmark-details.ts:33-42`; relieve de parques con `preservedBounds`, `src/city-ground-relief.ts:18-46`; montañas como `delta` aditivo con tope 260 k tris, `src/city-mountains.ts:21-27`). Un 6×6 km rural exige malla de terreno por chunks con LOD/morphing y `groundHeight` paginado — hoy `groundHeight` es una closure síncrona en memoria, sin paging ni LOD.
2. **Sin LOD geométrico ni impostores**: el "LOD" es binario `setEnabled` a 700/2500/3300 m (`src/city-world.ts:435`) y los proxies lejanos son las propias mallas base. En campo abierto a 3–6 km de vista esto revienta draws o deja el horizonte vacío (el mar usa `opposite-shore` + `coastalHorizon`, truco costero no reutilizable en secano).
3. **Física/superficies solo-asfalto**: `stepCar` + `CityCollision` contra footprints de edificios (`src/city-world.ts:507-509`); el flag `offroad` existe (`src/city-world.ts:502`) pero solo alimenta audio/cockpit, sin modelo de tierra/barro/pendiente ni daño. Camino rural = UNKNOWN (no auditado `driving.ts`).
4. **Red viaria urbana**: `RoadGraph` sobre `navigation.json` OSM con `kind` (`trunk/primary/...`), `oneway`, anchos 6 m (`src/main.ts:201`, `src/city-world.ts:295-296`); `setupSigns` filtra `primary/trunk` (`src/city-world.ts:420`). Pistas de tierra, cancelas, vados y pendientes no aparecen en el esquema (`grade:"0"` en la muestra).
5. **Vegetación de parque urbano, no de monte**: presupuestos por calidad (`nearTrees/farTrees/aerialTrees`, `src/city-graphics-quality.ts:5-7`) y `CityLandscape/CityCanopy` con `reserved()` del café (`src/city-world.ts:266`) — pins/encinas a densidad dehesa + streaming por chunks de 6×6 km no existen.
6. **Límites de mundo costeros**: `observer.step(..., data.meta.extent)` acota al extent de Shenzhen (`src/city-world.ts:381`, `src/city-world.ts:523`); mundo rural necesita borde propio (valla/fade) y `spawn` + `arrival` rurales.
7. **Contenido a reemplazar de punta a punta**: `city.json` (12 k vías/16 k edificios de Shenzhen), 150 tiles de fachadas, `landmark-detail/candidates`, `lamps.json`, `life-sites.json`, carteles este/oeste (`src/city-world.ts:424`), film del loader. Solo el **esquema** se hereda.

## Confianza

- **Verificado leyendo** (código + JSON real): secuencia de boot y orden de capas de `init`; engine/loop/perfiles y su aplicación; radios de facade-stream (700/1050/1500) y de culling (700/2500/3300, sombras 520/700, re-cull 100 m / re-veg 22 m / throttle 0.25 s); esquema y merge de manifiestos; conteos reales de `city.json`/`facade-tiles.json`/`landmark-detail.json`; claves de save del juego real; panel/benchmarks/telemetría; lista de hardcodes citada.
- **Inferido** (no verificado con ejecución): que `loading.finish()/reveal()` se llama tras `mountCityStory` (línea 201 truncada en lectura); valores de `tileSize` de fachadas y de `extent` en runtime (leídos del JSON, no del objeto en memoria); que `navigation.json`/`driving.ts` no modelan tierra (ese archivo quedó fuera del packet); tamaños reales de GLB (los del checkout miden ~130 bytes — parecen stubs/LFS, no se pudo validar peso real de assets).
- Build exitoso NO se usó como validación (no se compiló nada; repo de referencia intacto).
