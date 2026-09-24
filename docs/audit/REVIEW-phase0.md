# REVIEW FASE 0 — Review adversarial cruzado de `docs/audit/01..05`

- Revisor: modelo distinto a los cinco autores originales (rol: adversario).
- Repo de referencia auditado: `/home/kiri_/projects/montes-de-oca` (READ-ONLY, no modificado).
- Alcance: verificación de las afirmaciones que **cambian decisiones** (A–H del packet) + barrido
  sistemático de TODAS las anclas `archivo:línea` de los cinco docs.
- Método: `sed -n 'N,Mp'`, `grep -n`, `grep -rc`, `wc -l` y parseo programático de anclas contra el repo real.

## Resumen ejecutivo

1. El audit es **confiable**: las 8 afirmaciones prioritarias (A–H) se **CONFIRMAN** contra el código real, con una única imprecisión menor de ancla (off-by-one) en C.
2. El barrido **sistemático de 610 anclas** `archivo:línea` arrojó **609 en rango** y **1 sola ancla fuera de rango** (documento inexistente/rango inválido): `public/licenses/coastal-terrain.md:19-20` (el archivo tiene 15 líneas).
3. Todas las citas de física, licencias, esquema de datos y veredictos de reutilización que se revisaron a mano (`stepCar`, `CityCollision.blocked`, whitelist vial, `terrain-detail.json`, streaming, `LICENSE`/`ATTRIBUTION.md`, conteos) son **literales o fieles**.
4. No hay **ni una sola ancla inventada que apunte a contenido distinto** al afirmado: los cinco autores citaron bien. El riesgo principal del packet (anclas falsas) **NO se materializó**.
5. Principal debilidad detectada: **descoordinación entre docs** (contradicciones de alcance, p. ej. `driving.ts` declarado `UNKNOWN` en 01 pero auditado entero en 03) y **subestimación del acoplamiento** de `prepare_landmark_terrain.py` (depende de `city.json`/`green.geojson` del pipeline que se va a reescribir).

## Verificación por afirmación

Conteo: **30 sub-afirmaciones verificadas por lectura directa; 29 CONFIRMADO, 1 IMPRECISO (off-by-one), 0 REFUTADO**. Además, **610 anclas** chequeadas programáticamente (rango), **1 fuera de rango**.

| # | Afirmación (doc) | Veredicto | Evidencia `archivo:línea` (leída) |
|---|---|---|---|
| A1 | `stepCar` no recibe altura/pendiente/gravedad; auto 2D (03 §2) | CONFIRMADO | `src/driving.ts:6` firma sin `heightAt`; cuerpo 6–16 sólo `x,z,yaw,speed,steer,distance` |
| A2 | `grip` sólo es tope de velocidad (`53*grip`) (03 §3) | CONFIRMADO | `src/driving.ts:13` `s.speed=clamp(v+force*dt,-10,53*grip);` |
| A3 | `grip` no lo pasa ningún llamador (03 §3) | CONFIRMADO | `src/city-world.ts:507` `stepCar(this.state,this.drivingInput,dt)`; `src/city-autopilot.ts:194,277` sin `grip` |
| A4 | Pitch visual `atan2(front-rear,3)` muestreando a ±1,5 m (03 §2/§5) | CONFIRMADO | `src/city-world.ts:513` `front=this.groundHeight(s.x+Math.sin(s.yaw)*1.5,...), rear=...; this.car.rotation.set(-Math.atan2(front-rear,3),...)` |
| A5 | El doc **distingue** física (sin pendiente) de render (con pitch) | CONFIRMADO | 03 §2 separa «ignora por completo la altura» / «efecto visual»; snippet de pitch citado aparte. No los confunde |
| B1 | `tracktype`/`smoothness` no se leen en `scripts/` | CONFIRMADO | `grep -rn "tracktype\|smoothness" scripts/` → 0 resultados |
| B2 | `surface` no se lee como lógica vial | CONFIRMADO | `grep -rn "get('surface')" scripts/` → 0; sólo aparecen `street-surfaces.json`/`ground-surfaces.json` (mallas) y `surface_render_method` (Blender) |
| B3 | `access` sólo se usa como filtro de descarte | CONFIRMADO | `scripts/prepare_driving_city.py:35` `... or t.get('access') in ['private','no'] or t.get('motor_vehicle')=='no':continue` |
| B4 | `track`/`path` fuera de la whitelist vial | CONFIRMADO | `scripts/prepare_driving_city.py:31` `allowed={'trunk','primary','secondary','tertiary','residential','unclassified','service',...links}`; sin `track`/`path` |
| B5 | Montañas excluye `track` explícitamente de firmes | CONFIRMADO | `scripts/prepare_city_mountains.py:28` `... if r['kind'] not in ['footway','cycleway','path','steps','pedestrian','track']` |
| C1 | `terrain-detail.json` = DSM **real** Copernicus GLO-30 30 m (Lianhuashan) | CONFIRMADO | `public/city/terrain-detail.json`: `nativeResolutionMeters:30`, `meshSpacingMeters:15`, `derivativeNotice:'produced using Copernicus WorldDEM-30…'`; `scripts/prepare_landmark_terrain.py:25-29,73` |
| C2 | Script productor = `prepare_landmark_terrain.py` | CONFIRMADO | `scripts/prepare_landmark_terrain.py:212` `(OUT/'terrain-detail.json').write_text(...)` |
| C3 | Grid bilineal 15 m reales = 9 u. juego; datum = percentil 25 del borde | CONFIRMADO | `scripts/prepare_landmark_terrain.py:91-92` (`step=15*scale`), `:126` (`np.percentile(edge,25)`); JSON `dx:9.0` |
| C4 | Base ciudad plana 0 a propósito | CONFIRMADO | `scripts/prepare_driving_city.py:2` «Roads are deliberately flattened»; `src/landmark-details.ts:33-36` retorna 0 fuera del parche |
| C5 | `mountain-relief` = DSM real + césped **autoral** | CONFIRMADO | `scripts/prepare_city_mountains.py:41-42` `reproject(...,Resampling.bilinear)`; `:51-53` `lawn=(.65+.55*np.sin(...))` |
| C6 | `ground-relief` (grassland v2) = 100% autoral | CONFIRMADO | `scripts/prepare_city_ground_relief.py:4-5` («authored landscape, not survey data»); manifest `origin:'Art-directed grassland slopes, not surveyed elevation'` |
| C7 | Cita «sin exageración vertical» a `:204` | **IMPRECISO** | El texto «No vertical exaggeration…» está en `prepare_landmark_terrain.py:205`; `:204` es la línea de blends. Off-by-one, no cambia decisiones |
| D1 | `prepare_landmark_terrain.py` está atado a Shenzhen | CONFIRMADO | `:25` `TILE='Copernicus_DSM_COG_10_N22_00_E114_00_DEM'`; `:26` URL fija; `:87` boundary `way/41281446`; `:186` `peak_world=project(114.0543242,22.5561333)`; `:84-85` factores 102850/111320 |
| D2 | Pero el **patrón** (ventana rasterio, bilineal, datum, blends, drape) es reutilizable | CONFIRMADO | `:102-118` ventana + bilineal genérica; `:126,143-146` datum/blends; `:160-185` drapeado. Doc 02 §5/§8 lo declara atado a Shenzhen (honesto) |
| E1 | `blocked` es no-op con `buildings`/`landmarks` vacíos | CONFIRMADO | `src/driving.ts:30-35`; `bCells` y `data.landmarks` vacíos → bucles no iteran |
| E2 | Sin `land` que cubra el DEM, todo fuera de calzada = bloqueado | CONFIRMADO | `src/driving.ts:34` `return !this.data.land.some(...) \|\| this.data.water.some(...)` → sin `land`, `!false=true` |
| F1 | Radios `CityFacadeStream` 700/1050/1500 m | CONFIRMADO | `src/city-facade-stream.ts:11` `near(700)`; `:30` `near(1050)`; `:26` `distance>1500` dispose; `:26` `setEnabled(...<700)` |
| F2 | Tiles lógicos de 640 m | CONFIRMADO | `src/city-facade-stream.ts:5` comentario; `src/city-world.ts:253-254` `(Number(m[1])+.5)*640` |
| F3 | Culling 700/2500/3300 + sombras 520/700/650/1450/1650 | CONFIRMADO | `src/city-world.ts:435` `d<(b.detail?700:b.road?2500:3300)`; `:436-437` sombras 520/1650, landmarks 700/1650, relief 650/1450 |
| F4 | `CityFacadeStream` es el único stream de GLB | CONFIRMADO | Resto de `ImportMeshAsync` son cargas únicas (`city-world.ts:246`, `city-rooftops.ts:49`, `city-canopy.ts:53`, etc.); no hay paginado por distancia salvo fachadas (vegetación se re-instancia, no se streamea) |
| F5 | Re-cull 100 m / re-veg 22 m / throttle 0,25 s | CONFIRMADO | `src/city-world.ts:545-550` |
| G1 | `LICENSE` es MIT clásica © 2026 linranff + contribuidores | CONFIRMADO | `LICENSE:1` «MIT License»; `LICENSE:3` «Copyright (c) 2026 linranff and the ShenChengJi (深城纪) contributors»; 21 líneas |
| G2 | Split código MIT vs assets con términos propios | CONFIRMADO | `README.md:196` «**Code is MIT-licensed**… **The license covers code only.**»; `README.md:198` «Publicly readable files do not automatically share one open-source license.» |
| G3 | Rangos citados de `data/ATTRIBUTION.md` correctos | CONFIRMADO | OSM `:3-14`, Overture `:16-24`, catálogo Shenzhen `:26-32`, Copernicus `:40-50` (notice literal en `:48`) |
| G4 | Obligaciones por activo (CC-BY vehículo, CC0 Poly Haven, NC miHoYo) | CONFIRMADO | `README.md:201` (CarConcept CC BY 4.0), `:204` (miHoYo NC), `:207` (code MIT settled); 7 ficheros en `public/licenses/` |
| H1 | Única ocurrencia runtime origen/102850/111320: 1 archivo, 1 línea | CONFIRMADO | `grep -rn "114\.025\|102850\|111320" src/` → 1 línea: `src/city-map-geometry.ts:19` `wgs84ToMap` |
| H2 | ~12 definiciones duplicadas en `scripts/` | CONFIRMADO | `grep -rln "102850\|111320\|114\.025" scripts/` → **12 archivos** (coincide con la tabla §1.3) |
| H3 | `EPSG:32649` sólo en investigación, jamás runtime | CONFIRMADO | `grep -rn "EPSG" src/` → 0; scripts `extract_city.py:21`, `preview_data.py:22,115`, `select_pilot_route.py:14-15` |
| H4 (extra) | §2 conteos `city.json`/`map-places.json`/`data/landmarks/` | CONFIRMADO | `city.json` counts `{roads:12202,buildings:16076,green:1703,water:312,landmarks:10}`; `map-places.json` 293 = 244 district/25 park/16 transport/8 place; `ls data/landmarks/ \| wc -l` = 51 |
| Extra | Anclas varias 03/01 (grados de confianza) | CONFIRMADO | `src/traffic.ts:16` speed `7+random*6`; `:23,29` `heightAt+.14`; `:28` offset `1.15`; `src/city-walk.ts:21` `.55`, `:48` `.48`; `src/navigation.ts:2-4` cuantización `/3`; `src/city-map-geometry.ts:78` `cellSize=512`; `src/city-road-names.ts:13` `size=160`; `src/pedestrians.ts:33` `min(56)`; `src/city-autopilot.ts:23` `ROAD_CRUISE`; `:294` `clamp(dt,.001,.05)`; `src/city-loading.ts:5-12,95-121`; `src/city-world.ts:218,295,318-328,420,533`; `src/city-cockpit.ts:3` `CITY_DRIVER_POSE` |

Nota de B: la evidencia de `grep` pedida en el packet es la citada en B1/B2 (`tracktype`/`smoothness` = 0 resultados; `surface` sólo en sentido material/malla; `access` sólo en `prepare_driving_city.py:35`). Conclusión para FASE 3: **REWRITE del núcleo vial**, tal como afirma el doc.

## Anclas falsas encontradas

Barrido programático: **610 anclas parseadas, 609 en rango, 1 fuera de rango.** Manual: 0 anclas inventadas que apunten a contenido distinto.

1. **`public/licenses/coastal-terrain.md:19-20`** — cite en `04-assets-blender-licencias.md:125`. **ANCLA FALSA (rango inexistente):** el archivo tiene **15 líneas**. La referencia real a `prepare_city_mountains.py` está en `public/licenses/coastal-terrain.md:15` («Generation: `scripts/prepare_city_mountains.py`»). Severidad: baja (cross-reference en §2.2, no decision-changing).
2. **`prepare_landmark_terrain.py:204`** — cite en `02-pipeline-datos-y-terreno.md:77` para «sin exageración vertical». El texto está en **`:205`**; `:204` es la línea de blends. **Ancla desplazada 1 línea.** Severidad: muy baja.

No se encontraron anclas desplazadas de mayor magnitud ni citas que apunten a otro contenido.

## Veredicto de reutilización corregido

Tabla consolidada (apta para usar tal cual). «Base» = ancla verificada. Los veredictos del audit se mantienen; sólo se agrega el matiz de acoplamiento marcado con ⚠.

| Componente | Veredicto corregido | Base verificada |
|---|---|---|
| `stepCar` (longitudinal + yaw tipo bicicleta) | **REWRITE** (conservar firma/arquitectura) | `src/driving.ts:6-16`; sin pendiente/gravedad/lateral; `grip` muerto (`:13`) |
| `CityCollision` (índice + `blocked`) | **REUSE-WITH-PARAMS** | `src/driving.ts:20-36`; poblar `land` con extent DEM o invertir regla |
| Snap Y + pitch/roll visual | **REUSE-WITH-PARAMS** | `src/city-world.ts:513` |
| `RoadGraph` + Dijkstra | **REUSE-AS-IS** | `src/navigation.ts:2-18`; agnóstico a topología |
| `CityTraffic` NPC | **REUSE-WITH-PARAMS** | `src/traffic.ts:14-29`; exige grado ≥2 |
| `CityAutopilot` | **REUSE-WITH-PARAMS** | `src/city-autopilot.ts:23,194,277,294,355` |
| Controles + cámaras + cabina | **REUSE-AS-IS** | `src/city-world.ts:204,217,517-534`; `src/city-cockpit.ts:3` |
| Walk/exit/enter + rider | **REUSE-AS-IS** | `src/city-walk.ts:2-56`; `src/city-world.ts:318-328` |
| Boot + loader por etapas | **REUSE-WITH-PARAMS** | `src/city-loading.ts:5-12,95-121` (17 stages chinos a parametrizar) |
| Render loop + instrumentación | **REUSE-AS-IS** | `src/city-world.ts:218,566-567` |
| Perfiles de calidad + panel | **REUSE-WITH-PARAMS** | `src/city-graphics-quality.ts:1-26` |
| glTF streaming (`preserve_scene_lights`) + Meshopt | **REUSE-AS-IS** | `src/city-gltf-streaming.ts:7-62`; `src/city-world.ts:7` |
| `CityFacadeStream` | **REWRITE** | `src/city-facade-stream.ts:5,11,26,30`; único stream, forma urbana |
| Culling por distancia + `renderList` | **REUSE-WITH-PARAMS** | `src/city-world.ts:435-437,545-550` |
| Cadena `groundHeight` decorada | **REUSE-WITH-PARAMS** | `src/city-world.ts:250,261` |
| Terreno base + relieve + montañas | **SHENZHEN-ONLY** | `prepare_landmark_terrain.py`, `prepare_city_mountains.py` |
| Manifiestos `city.json` + incrementos | **REUSE-WITH-PARAMS** | `src/city-types.ts:1-4`; `src/landmark-details.ts:44-98` |
| Save/state | **REUSE-WITH-PARAMS** | claves `shenchengji-*` a renombrar |
| Telemetría/benchmarks | **REUSE-AS-IS** | `src/main.ts:201`; `scripts/city-benchmark.mjs` |
| `scripts/download_osm.py` | **REUSE-WITH-PARAMS** | `:11-60`; cambiar URL/extracto a CyL/España |
| `scripts/extract_city.py` | **REUSE-WITH-PARAMS** | `:21` UTM 49N→30N; `:23` regex landmark chino; `:115-117` KeyFilter |
| `scripts/validate_data.py` | **REUSE-WITH-PARAMS** | `:9-26` |
| `scripts/prepare_driving_city.py` | **REWRITE (núcleo vial)** | `:1-3` aplanado; `:31` whitelist sin track/path; `:35` filtros; `:39-46` anchos/kind/grade |
| `scripts/prepare_city_streets.py` | **SHENZHEN-ONLY** | `:11-34`; asfalto/aceras/farolas |
| `scripts/prepare_city_ground.py` | **REUSE-WITH-PARAMS** | `:8-16` |
| `scripts/build_city_ground.py` | **REUSE-WITH-PARAMS** | `:5-18`; parte costera SHENZHEN-ONLY |
| `scripts/prepare_landmark_terrain.py` | **REUSE-WITH-PARAMS (plantilla DEM) ⚠** | `:102-185,212`; atado a Shenzhen. ⚠ Consume `city.json`/`green.geojson`/`water.geojson` del pipeline urbano → dependencia circular; generalizar cuesta más que «parametrizar» |
| `scripts/prepare_city_mountains.py` | **REUSE-WITH-PARAMS** | `:22,28,36-53,90`; atado a tiles N22/E113-114 y datum 20 m |
| `scripts/fetch_coastal_dsm.py` | **SHENZHEN-ONLY** | tiles/SHA de costa china |
| `scripts/prepare_city_ground_relief.py` | **SHENZHEN-ONLY** | `:4-5` autoral declarado |
| `src/city-types.ts` | **REUSE-WITH-PARAMS** | `:1-4` |
| `src/city-ground-relief.ts` | **REUSE-AS-IS (infra)** | `:14-35` |
| `src/city-road-surface.ts` | **SHENZHEN-ONLY** | asfalto cinematográfico urbano |
| `src/landmark-details.ts` (`terrainHeight`) | **REUSE-AS-IS** | `:33-42,55-56` |
| `requirements.lock.txt` | **REUSE-AS-IS** | osmium/shapely/pyproj/rasterio/numpy/pillow |
| `LICENSE` + estructura `data/ATTRIBUTION.md` + `public/licenses/` | **REUSE estructura / REWRITE contenido** | `LICENSE:1-21`; `README.md:194-207`; `data/ATTRIBUTION.md:3-50` |

Correcciones materiales al plan de FASE 2/3 derivadas del review: **ninguna** en los veredictos (todos resistieron), pero **sí** un ajuste de expectativa de esfuerzo en `prepare_landmark_terrain.py` (⚠) y la confirmación de que FASE 3 (vial rural) es **REWRITE**, no REUSE.

## Riesgos que el audit no cubrió

1. **Dependencia circular del «template DEM».** `prepare_landmark_terrain.py` no consume un GeoTIFF arbitrario suelto: exige `public/city/city.json` (roads/landmarks) y `data/processed/shenzhen_study/{green,water,roads}.geojson`, y ata la proyección a origen/escala del JSON (`:80-88`). Como el plan reescribe `prepare_driving_city.py` (productor de ese `city.json`), la plantilla depende de un artefacto que también se reescribe. El audit lo llama «REUSE-WITH-PARAMS» sin señalar el orden de dependencia.
2. **Nada se compiló ni ejecutó.** Los cinco docs son lectura estática. No hay validación de build, ni de que el pipeline corra punta a punta tras parametrizar.
3. **Assets GLB del checkout son stubs (~130 bytes).** Los propios docs lo admiten (01 §Confianza); cualquier presupuesto real de malla/GPU no es verificable. Los JSON sí son reales (verificado: `city.json` 8,36 MB parseable, `navigation.json` 1,3 MB, `terrain-detail.json` 381 KB).
4. **Contradicciones de alcance entre autores.** Doc 01 §9.3 declara `driving.ts` «UNKNOWN (no auditado)» mientras doc 03 lo audita completo; doc 02 §Confianza declara `navigation.json` «consumo no rastreado» mientras doc 01 lo rastrea (`src/main.ts:201`). No invalidan nada, pero muestran que los cinco audits no se leyeron entre sí: consolidar antes de decidir.
5. **Datum vertical IGN.** El audit deja `UNKNOWN` el datum IGN; MDT05/25 no es EGM2008 directo. Cualquier comparación de cotas Copernicus↔IGN arrastra un error sistemático no auditado.
6. **Presupuesto 6×6 km @5 m.** El máximo probado (15–20 m) y los techos (200k/260k tris) no escalan linealmente; no hay medición de memoria/streaming para 1,44M nodos.
7. **§5.2 de licencias es opinión de ingeniería, no legal.** El doc lo declara, pero decisiones de distribución MIT-compatible sobre un data-pack ODbL/CC-BY requieren revisión legal real.
8. **Interpretación ODbL de «Produced Works».** El doc afirma que la malla GLB no contagia ODbL pero la BD derivada sí. Es la lectura habitual, pero no está verificada contra el texto legal por el audit.

## Confianza

- **Alta** en la verificación de anclas: 610 anclas parseadas contra el repo real (609 en rango, 1 fuera de rango), + ~70 anclas leídas línea a línea con `sed`/`grep` cubriendo las 8 afirmaciones prioritarias y los conteos. La tasa de acierto de los cinco audits es objetivamente altísima.
- **Alta** en las afirmaciones A–H: todas CONFIRMADAS con el código a la vista; la única desviación es un off-by-one en una cita de prosa (C7), sin impacto en decisiones.
- **Media** en los **veredictos de reutilización**: son juicios (REUSE vs REWRITE) que dependen de requisitos de FASE 2/3 no fijados; mi review confirma los hechos que los sustentan, no el juicio en sí.
- **No verificado por mí (NO VERIFICADO):** ejecución del pipeline, presupuestos reales de render/memoria, datum vertical IGN, y el contenido real de los GLB (stubs en el checkout).
- **Veredicto de confiabilidad del audit: CONFIABLE.** No hay que reescribir los audits; sólo corregir las dos anclas listadas y añadir el riesgo #1 (dependencia circular del template DEM) al planificar FASE 2.

---

## Verificación del orquestador sobre este review (post-review)

El review dejó tres riesgos abiertos. Los verifiqué contra el repo real. **Dos se confirman y uno
resulta PEOR de lo reportado.** Esto cambia el plan de FASE 2.

### Riesgo #1 (dependencia circular del «template DEM») — CONFIRMADO, y agravado

El review detectó que `prepare_landmark_terrain.py` consume artefactos del pipeline urbano. Verificado:

| Insumo exigido | Línea | Estado real en el checkout |
|---|---|---|
| `public/city/city.json` | `:79-80` | EXISTE (8.365.073 bytes) |
| `data/processed/shenzhen_study/green.geojson` | `:86-87` | **NO EXISTE** |
| `data/processed/shenzhen_study/water.geojson` | `:134` | **NO EXISTE** |
| `data/processed/shenzhen_study/roads.geojson` | `:170-171` | **NO EXISTE** |

`data/processed/` **no existe en absoluto**: `data/` contiene sólo `ATTRIBUTION.md`, `landmarks/`,
`locations/`, `map-places.json`, `materials/` y `references/`.

**Consecuencia:** el script **no puede ejecutarse** en este checkout — le faltan 3 de sus 4 insumos.
No es un «template a parametrizar»: es un script con una etapa de pipeline entrante que no está en el
repo. El veredicto baja de `REUSE-WITH-PARAMS ⚠` a **NO EJECUTABLE / escribir uno propio**.

Se conserva lo que sí vale: la **semántica** (ventana rasterio + bilineal, datum = percentil del borde,
blends de borde, drapeado de viales). El código, no.

### Riesgo #3 (assets GLB son stubs) — CONFIRMADO, con el detalle real

- **219 archivos `.glb`**, todos entre **129 y 133 bytes**.
- Son punteros de Git LFS, no mallas: la primera línea de cada uno es
  `version https://git-lfs.github.com/spec/v1` y declara `size 177916` (ej: `public/city/facades.glb`).
- **`git-lfs` NO está instalado** (`git: 'lfs' is not a git command`), **no hay config LFS**, y el único
  remoto es `upstream` = `https://github.com/linranff/GTA_SZ.git`.

**Consecuencia:** en el checkout local **no hay ni un solo asset de malla utilizable**. Todo presupuesto
de draw calls, triángulos o GPU medido contra la referencia es **imposible de establecer**. Nuestro
objetivo de performance hay que construirlo sobre nuestra propia escena (que es lo que hace S1).

### Correcciones de anclas aplicadas en este commit
- `02-pipeline-datos-y-terreno.md`: `prepare_landmark_terrain.py:204` → `:205` (dos ocurrencias; la línea
  de blends es `:204`, «No vertical exaggeration» está en `:205`).
- `04-assets-blender-licencias.md`: `public/licenses/coastal-terrain.md:19-20` → `:15` (el archivo tiene
  15 líneas, la nota de generación está en `:15`).
