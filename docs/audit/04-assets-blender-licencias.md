# Auditoría 04 — Pipeline de assets Blender→GLB y licencias

Repo de referencia: `/home/kiri_/projects/montes-de-oca` (READ-ONLY, no modificado).
Proyecto nuevo: `/home/kiri_/projects/montes-de-oca-offroad` («Montes de Oca: Offroad Stories»).
Fecha: 2026-09-24. Auditoría de LECTURA: no se ejecutó Blender ni ningún script de build;
solo lectura de `.py`/`.mjs`/`.md` y comandos read-only (`grep`, `head`, `sed`, `ls`).

Convención de evidencia: cada afirmación cita `archivo:línea` del repo de referencia
o salida de comando. Lo no verificado se marca `UNKNOWN`.

---

## 1. API de malla compartida `scripts/city_mesh.py`

### 1.1. Qué es y qué inicializa

El docstring del módulo (`scripts/city_mesh.py:1-5`) lo define todo en cinco líneas:

> «Blender-authored exterior city, individual landmark silhouettes, electric car.
> Geometry built from local OSM-derived footprints; material facade synthesis is
> an artistic estimate, not surveyed facade reconstruction. Blender coordinates
> are east, north, up; Babylon loader removes the extra glTF root Y half turn. »

Puntos clave de ese encabezado:

- La geometría se construye desde huellas derivadas de OSM local; la síntesis de
  fachadas es **estimación artística, no reconstrucción topográfica**. Este
  descargo es reutilizable como política para nuestro terreno rural (MDT
  interpolado ≠ precisión medida).
- El convenio de ejes ya está fijado: **Blender este/norte/arriba** y el loader
  de Babylon elimina el medio giro Y del nodo raíz glTF.

`scripts/city_mesh.py:6` hace `import bpy, bmesh, math, json, random` más
`mathutils`, `tessellate_polygon` y `pathlib`. **Importar el módulo inicializa
Blender**: `scripts/city_mesh.py:11-12` borra la escena completa al importar
(`bpy.ops.object.select_all` + `delete`) y `scripts/city_mesh.py:11` fija rutas
de salida cableadas al repo (`R = padres[1]; O = R/'public/city'`). Los
consumidores lo importan con `sys.path.insert` + `from city_mesh import *`
(`scripts/build_landmark_details.py:7-8`, `scripts/build_driving_assets.py:1-3`).
`docs/assets/city-life-hub.md:17` confirma el patrón: el builder del life-hub
«solo importa la API de construcción de malla de `city_mesh.py`» y no reconstruye
nada más. Conclusión: el módulo es **mitad librería, mitad script con efectos
laterales al importar**; reutilizarlo exige aislar la importación en un proceso
Blender dedicado (que es exactamente como lo usa el repo: un proceso
`--background` por builder).

### 1.2. Funciones públicas y propósito

| Función | Ubicación | Propósito |
|---|---|---|
| `material(n, c, rough, metal, emit, tex)` | `scripts/city_mesh.py:14-22` | Crea material Principled con color/roughness/metallic/emisión y textura opcional `tex` + `tex-emissive` desde `public/city/textures`. Registra en dict global `M`. |
| `class B` (acumulador de geometría) | `scripts/city_mesh.py:32-69` | Constructor de malla por lotes: acumula vértices/caras/UV por material y los materializa como objetos Blender en `finish()`. |
| `B.pt(p)` | `scripts/city_mesh.py:34-35` | Transformación de marco 2D (traslación + yaw) aplicada a cada punto. |
| `B.face(m, pts, uv)` | `scripts/city_mesh.py:36-39` | Cara poligonal arbitraria en el material `m`, con UV por defecto `p/8`. |
| `B.box(m, p, s)` | `scripts/city_mesh.py:40-42` | Caja centrada en `p` de tamaño `s` (6 caras). |
| `B.tube(m, a, b, r, n, r2)` | `scripts/city_mesh.py:43-47` | Tubo entre `a` y `b` con radios `r`→`r2`, `n=8` segmentos, tapas incluidas. |
| `B.loft(m, rings, n, power)` | `scripts/city_mesh.py:48-54` | Loft entre anillos elípticos/superelípticos `(x,y,z,rx,ry)`; tapas incluidas. |
| `B.finish(name, smooth)` | `scripts/city_mesh.py:55-64` | Crea un objeto Blender por material (`from_pydata`), asigna material y UV; con `smooth=True` suelda dobles y activa sombreado suave. |
| `B.footprint(mat, ring, z, h, scale)` | `scripts/city_mesh.py:65-69` | Extrusión vertical de un anillo poligonal (muros + techo vía `tessellate_polygon` con material fijo `'roof'`). |
| `export(name, obs)` | `scripts/city_mesh.py:70-75` | Exporta selección a `public/city/<name>.glb` con `export_yup=True`, sin animaciones/cámaras/luces; devuelve `{file, bytes, triangles, meshes}`. |

### 1.3. Veredicto: ¿city-specific o reutilizable?

**Genuinamente reutilizable en su núcleo geométrico; city-specific en materiales,
rutas y marco de datos.** Desglose:

- **Reutilizable tal cual (lógica):** `B.pt/face/box/tube/loft/finish`,
  `footprint` y el cómputo de triángulos de `export`. Son primitivas sin
  conocimiento de Shenzhen: cajas sirven para cercas, portones y casetas;
  `tube` para postes, barandillas y mástiles; `loft` para troncos y depósitos;
  `footprint` para naves y edificios auxiliares. Ninguna menciona ciudad.
- **City-specific (hay que parametrizar):** el bloque `material(...)` de
  `scripts/city_mesh.py:23-31` (office/residential/stone/grass/road/asphalt…),
  las rutas cableadas `R/'public/city'` (`scripts/city_mesh.py:11`) y la entrada
  de datos (`city.json`, huellas OSM). Para el proyecto rural hay que crear un
  `rural_mesh.py` hermano con paleta propia (tierra, pista, pino, chapa, madera)
  y rutas a `public/rural/`, copiando la estructura de `B` + `export`.
- **No reutilizar el patrón «importar = borrar escena»** sin aislamiento: cada
  builder corre en su propio proceso Blender (`--background --factory-startup
  --python`, ver `scripts/rebuild_city_assets.mjs:53-55`). Mantener esa
  disciplina en el proyecto nuevo.

**Veredicto de la API: REUSE-WITH-PARAMS** (ver §7 para el detalle por pieza).

---

## 2. Convención build → prepare → check

Listado de `scripts/` (190 entradas): tres prefijos con semántica estricta,
confirmada por el orquestador `scripts/rebuild_city_assets.mjs:10-25` (tabla de
etapas) y `scripts/rebuild_city_assets.mjs:53-55` (cada etapa despacha
`python` / `blender --background` / `node` según su clase).

### 2.1. `build_*` — autoría Blender, produce GLB

Corre bajo Blender en background (`--background --factory-startup --python`).
Lee JSON intermedios + texturas, construye geometría con `bpy`/`city_mesh` y
exporta GLB. Ejemplos reales:

- `scripts/build_vehicle_candidate.py:1-3` — deriva un coupé runtime desde el
  CarConcept de Khronos (CC BY 4.0); solo escribe
  `artifacts/city/vehicle-candidate/`, no toca `public/city` directamente.
- `scripts/build_canopy_trees.py:7-8` — dos modos en un solo archivo:
  `--prepare` (colocación, Python sistema) y modo Blender (`blender -b --python
  ... -- --preview`) que modela 6 especies × 3 LOD y exporta a
  `public/city/landscape/canopy/*.glb`.
- `scripts/build_landmark_details.py:1-3` — hitos independientes «grounded» en
  fuente; «never overwrite city roads».
- `scripts/build_driving_assets.py:1-3` — importa `city_mesh`, genera
  `buildings.glb` + calzadas por teselas de 640 m.

### 2.2. `prepare_*` — preparación offline de datos, produce JSON

Corre con el Python del sistema/`.venv` (shapely, numpy, PIL), **sin Blender**.
Hace geoprocesamiento y escribe los JSON que luego consumen los builders.
Ejemplos reales:

- `scripts/prepare_city_ground.py:1-17` — une superficies tierra/parque/agua/mar
  con shapely y triangula a `public/city/ground-surfaces.json` («Disjoint
  land/park/water meshes: no infinite sea hidden under the whole city»).
- `scripts/prepare_city_streets.py:1-5` — une calzadas coplanares, reserva
  carriles, siembra marcas/señales; «OSM derivative data, same local
  east/north coordinates as city.json».
- `scripts/prepare_city_mountains.py` — relief desde teselas Copernicus
  (referenciado en `public/licenses/coastal-terrain.md:15`).
- `scripts/prepare_architecture_textures.mjs:22-24` — redimensiona a atlas
  512×512 y registra `{sha256, sourceSha256, generationTool}` por textura.

En `scripts/rebuild_city_assets.mjs:12-13` se ve el orden canónico:
`prepare_city_streets` → `prepare_city_ground` → `build_city_ground`, y
`prepare_landmark_terrain --offline` → `build_landmark_details`.

### 2.3. `check-*` — validación, no escribe assets

Scripts `node` (a veces + Playwright/Chromium). Dos subclases:

- **Auditoría CPU sin browser:** `scripts/check-character-assets.mjs:1-26` —
  valida `public/characters/manifest.json` contra los GLB (cabecera `glTF`,
  versión 2, longitud, `sha256`, parámetros de marcha); falla si el modelo «sigue
  siendo puntero Git LFS» (`:19`) en vez de perder los personajes en silencio.
  `scripts/check_vehicle_delivery.mjs:1` se autodescribe como «CPU-only audit…
  No browser, GPU or mutations» y exige, entre otros, transformadas identidad
  en nodos y 4 neumáticos animados con nombre `wheel_[lr][fr]_rubber`.
- **Smoke test con browser real:** `scripts/check_landmark_details.mjs:1-8` —
  lanza Chromium headless, espera `window.__SHENZHENJI_CITY__.ready`, verifica
  posiciones en vivo y captura screenshots por hito.

Muestreo de la convención de nombres: `scripts/` contiene ~25 `build_*`,
~20 `prepare_*` y ~50 `check-*`; solo se leyeron completos los citados arriba,
el resto se infirió por nombre + orquestador. `UNKNOWN` si algún `check-*`
aislado escribe artefactos (los muestreados no: `finalize_city_assets.mjs`
acepta solo `--check` o escribe manifiestos, nunca GLB).

---

## 3. Convenciones de exportación GLB

### 3.1. Conversión de ejes: Blender Z-up → glTF Y-up

**Todas** las exportaciones usan `export_yup=True`:

- `scripts/city_mesh.py:74` (exportación compartida),
- `scripts/build_canopy_trees.py:365`, `scripts/build_ebikes.py:245`,
  `scripts/build_floatplane.py:302-303`, `scripts/build_landscape_assets.py:262`,
  `scripts/build_open_vegetation.py:116`,
  `scripts/build_solid_tree_lods.py:92`,
  `scripts/build_traffic_signals.py:231`,
  `scripts/build_vehicle_candidate.py:198`,
  `scripts/build_bamboo_cafe.py:636` (salida vía `grep`, no re-leído entero).

Parámetros comunes: `export_format='GLB'`, `use_selection=True`,
`export_animations=False` (salvo personajes/vehículos animados),
`export_cameras=False`, `export_lights=False`.

### 3.2. Unidades, escala, orientación del nodo raíz

- **Unidades = metros, 1 unidad Blender = 1 metro de juego.** Evidencia:
  `scripts/build_vehicle_candidate.py:37` fija `length=5.0` (GT urbano de 5 m);
  `scripts/build_canopy_trees.py:25-32` define especies por `height` en metros
  (30/24/18/15/12/11) y radios de copa en metros; `wheelRadius=.3838*sz`
  (`scripts/build_vehicle_candidate.py:199`).
- **Nodo raíz:** el runtime **no** conserva la transformada raíz del glTF; la
  neutraliza y hornea una reflexión: `src/city-canopy.ts:59`,
  `src/city-landscape.ts:54` y `src/city-ebikes.ts:34` hacen los tres lo mismo —
  `mesh.bakeTransformIntoVertices(Matrix.Scaling(1,1,-1))` + posición/escala a
  identidad + `rotationQuaternion=Quaternion.Identity()`.
  `src/city-bamboo-cafe.ts:33` fija `assetRoot.rotationQuaternion=Identity`.
- **Contrato formal del vehículo** (`scripts/build_vehicle_candidate.py:199`):
  `'front':'Blender +Y / GLTF -Z / game after existing root reflection +Z'` y
  `'wheelCentresGltf':{k:[v[0],v[2],-v[1]]}` — es decir, mapeo Blender→glTF
  `(x, y, z) → (x, z, -y)`. La auditoría
  (`scripts/check_vehicle_delivery.mjs`, bloque `identityNodeTransforms`)
  exige transformadas identidad en todos los nodos de malla para que los
  pivotes de rueda en espacio local sean válidos.
- Los builders mantienen la geometría «en espacio local del coche, todas las
  transformadas de malla identidad»
  (`scripts/build_vehicle_candidate.py:188-193`, comentarios «Runtime currently
  rotates meshes about supplied metadata centres»).

**Regla a heredar:** modelar en metros, este/norte/arriba; exportar con
`export_yup=True` sin cámaras/luces; neutralizar raíz en el loader y hornear la
reflexión Z; auditar identidad de nodos si hay pivotes animados (ruedas,
portones, aspas del repetidor).

---

## 4. Presupuestos, validación, manifiesto y despliegue LFS/R2

### 4.1. Presupuestos por builder (asserts, no sugerencias)

- Vehículo: `report['triangles']<=110000`, `meshes<28`, `glbBytes<=8MiB`
  (`scripts/build_vehicle_candidate.py:199-201`; `triangleBudget:110000`).
- Canopy por especie/LOD: LOD0 ≤4800 / LOD1 ≤1700 / LOD2 ≤220 triángulos
  (`scripts/build_canopy_trees.py:369`).
- Streetscape: `budgets:{nearTrees:48, farTrees:220, …, detailTriangleCeiling:150000}`
  (`scripts/build_landscape_assets.py:268`, vía `head`).
- Texturas: arquitectura 512×512 (`scripts/prepare_architecture_textures.mjs:22-24`,
  con `maxDimension:512` y coste mipmap estimado); atlas de vegetación
  1024×1024 (`scripts/build_landscape_assets.py:268`); atlas de carteles
  2048×2048 (`docs/assets/city-life-hub.md:9-11`); HDR de cielo 4K
  (`public/licenses/daylight-environment.md`, SHA-256 registrado).
- Cada builder emite su manifiesto con triángulos/mallas/bytes reales medidos
  del GLB (p. ej. `vehicle-manifest.json`, `landscape/manifest.json`, manifiesto
  canopy en `scripts/build_canopy_trees.py:370-372`, manifiesto bambú con
  `blender_version` en `scripts/build_bamboo_cafe.py:639`).

### 4.2. Manifiesto de entrega (mecanismo)

`scripts/finalize_city_assets.mjs` (leído, 60+ líneas):

- Hashea **la entrega real** (`sha256` + bytes de cada fichero bajo
  `public/city/`, incluidos assets anidados de landscape y texturas).
- Parsea el JSON de cada GLB (accesores glTF, no informes de autoría) para
  contar triángulos/mallas/primitivas/UV2 (`geometry()`, valida magic `glTF`).
- Cruza manifiestos: teselas de fachada vs `facades.glb` fuente; `car.glb` vs
  `vehicle-manifest.json` (hash + bytes + triángulos); `landscape/*.glb` vs
  `landscape/manifest.json`.
- Escribe tres manifiestos (excluidos del propio hash para evitar circularidad):
  `building-exclusions.json`, `delivery-manifest.json`, `asset-manifest.json`.
- Modo `--check` valida sin escribir.

La rebuild completa es **estadificada**: `scripts/rebuild_city_assets.mjs:1-5`
documenta que un candidato no revisado nunca reemplaza `public/city`
(`--plan` solo planifica, el build escribe en `artifacts/rebuilds/<fecha-pid>/`
y exige verificación de hashes de fuente, p. ej. CarConcept, antes de integrar).

### 4.3. Despliegue LFS/R2 (alto nivel)

- **Git LFS:** `.gitattributes:2-17` pone bajo LFS `*.glb *.bin *.hdr *.blend
  *.fbx`, texturas e `mp4` de docs; `.gitignore:13-18` excluye `artifacts/`,
  `output/`, `data/raw/`, `data/processed/` (productos reproducibles y datos
  crudos no se versionan; los `.blend` editables viven en `artifacts/` local).
- **Cloudflare R2:** `cloudflare/README.md:8-12` + `scripts/cloudflare/` —
  `sync-r2.mjs` sube a R2 (`shenchengji-city`) los ficheros de `public/` de
  ≥256 KiB con copia Brotli `.br`; `r2-manifest.json` registra sha256 para
  sincronización incremental; `write-assetsignore.mjs` genera
  `dist/.assetsignore` por el límite de 25 MiB por fichero; `deploy.sh`
  encadena sync → build → deploy. El worker sirve desde R2 lo listado en el
  manifiesto (ETag 304, Range, br) y el resto como estático.

---

## 5. Licenciamiento

### 5.1. Código vs assets en este repo (texto real)

`LICENSE:1-21` es la **MIT License** clásica, © 2026 linranff and the
ShenChengJi contributors: permite uso/copia/modificación/distribución con la
única condición de incluir el aviso de copyright y la licencia
(`LICENSE:12-13`).

Pero **la MIT cubre solo el código**. `README.md:194-207` («Data, models and
licensing») lo dice explícitamente:

- «**Code is MIT-licensed** ([LICENSE](LICENSE)): everything under `src/`,
  `scripts/`, `tests/`, `cloudflare/`, `ue5/Shenchengji/Source/` and the build
  configuration. […] **The license covers code only.** »
- «Game assets under `public/`, source data under `data/`, media under
  `docs/media/` and the character models keep their own terms […] do not add
  an asset to a PR without a matching notice in `public/licenses` or
  `data/ATTRIBUTION.md`.»
- «Publicly readable files do not automatically share one open-source license.»

Obligaciones de atribución existentes (resumen con fuente):

| Activo | Licencia | Dónde consta |
|---|---|---|
| Caras/ carreteras (huellas) OSM | ODbL 1.0, © OpenStreetMap contributors; extracto Geofabrik Guangdong + `raw/guangdong.manifest.json` | `data/ATTRIBUTION.md:3-14`, `README.md:200` |
| Edificios Overture 2026-08-19.0 | ODbL 1.0, atribución por feature | `data/ATTRIBUTION.md:16-24` |
| Catálogo oficial de Shenzhen | Solo directorio público; **sin** derechos de descarga/adaptación/redistribución | `data/ATTRIBUTION.md:26-32` |
| Terreno Copernicus GLO-30 | Atribución obligatoria textual: «produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved» | `data/ATTRIBUTION.md:40-50`, `public/licenses/coastal-terrain.md` |
| Vehículo CarConcept (DGG/Eric Chadwick) | **CC BY 4.0**; el derivado mantiene la licencia y exige conservar aviso con autor, fuente, licencia y cambios | `public/licenses/carconcept-CC-BY-4.0.md`, `README.md:201` |
| Cielos/árboles/asientos Poly Haven, OpenGameArt | **CC0 1.0** (verificado por MD5 contra清单 oficial) | `public/licenses/open-city-assets.md`, `public/licenses/daylight-environment.md` |
| Personajes Kuki/Yelan (miHoYo; adaptación MMD de Guanhai) | **Prohíben uso comercial, redistribución y extracción de partes**; la atribución no otorga permisos extra; sin afiliación con HoYoverse | `README.md:204` |
| Babylon.js, meshoptimizer | Apache-2.0 / MIT (avisos incluidos) | `public/licenses/babylonjs-apache-2.0.md`, `public/licenses/babylonjs-NOTICE.md`, `public/licenses/meshoptimizer-MIT.md` |

`README.md:207` cierra: «The code license is settled (MIT); a full release
still requires a separate decision on each asset category's distribution scope.»

### 5.2. Qué cambia con IGN/CNIG (CC-BY 4.0) y OSM (ODbL) para España

> Valoración de ingeniería, **no asesoramiento legal**. Verificar con la licencia
> oficial de cada descarga (la licencia exacta la fija el fichero descargado,
> no este documento).

- **El código sigue MIT sin cambios.** Igual que en el repo de referencia, el
  código (`src/`, `scripts/`, `tests/`) va MIT y los datos/assets llevan sus
  propios términos. Requisito del proyecto («código compatible con MIT») se
  cumple **aislando** lo MIT de lo ODbL/CC-BY, nunca mezclando licencias en el
  mismo fichero.
- **IGN/CNIG bajo CC-BY 4.0** (p. ej. MDT, MTN, ortofoto PNOA según producto):
  1. Atribuir en el juego (pantalla de créditos) y en un
     `data/ATTRIBUTION.md` propio: autor (Instituto Geográfico Nacional /
     CNIG), producto, fecha de descarga, URL, hash.
  2. Indicar cambios («MDT remuestreado a malla de juego de X m, datum local
     adaptado; no es precisión medida» — mismo descargo que
     `data/ATTRIBUTION.md:44` y `scripts/city_mesh.py:1-5`).
  3. Mantener el aviso en cada redistribución del derivado. CC-BY **permite
     uso comercial y derivados**, a diferencia del caso miHoYo: no heredar
     assets con cláusula NC si el proyecto exige compatibilidad MIT en
     distribución.
- **OSM bajo ODbL 1.0** (pistas, cercas, edificios de Villafranca): la
  obligación dura es la **share-alike sobre la base de datos derivada**:
  1. Si producimos una BD derivada (red de pistas, huellas, grafo de
     navegación) a partir de OSM, esa BD debe ofrecerse bajo ODbL con
     atribución «© OpenStreetMap contributors».
  2. Las *Produced Works* (la malla GLB renderizada) no contagian licencia al
     resto del juego, pero **la BD derivada subyacente sí** debe publicarse /
     ofrecerse bajo ODbL. En la práctica: versionar `data/processed/` (o su
     equivalente) con manifiesto de fuente+hash como hace el repo
     (`raw/*.manifest.json`, `data/ATTRIBUTION.md:12`), y documentar el
     recorte («rectángulo de estudio, no término municipal completo»,
     cf. `data/ATTRIBUTION.md:13`).
  3. No fusionar en un único dataset inseparable fuentes ODbL + CC-BY sin
     trazabilidad por tesela/fuente: el repo mantiene la trazabilidad por
     producto (`coastal-terrain.md`, `LANDMARK_ATTRIBUTION.md`,
     `vehicle-manifest.json` con `source`+`sha256`). Replicar: un manifiesto
     por familia de asset con `{fuente, url, fecha, sha256, licencia,
     adaptaciones}`.
- **Consecuencia práctica para el MVP:** crear desde el día 1
  `data/ATTRIBUTION.md` + `public/licenses/` propios con una entrada por
  fuente (IGN-MDT, OSM-Villafranca, cada asset CC0/CC-BY de terceros), y un
  `delivery-manifest.json` con hashes como el de `finalize_city_assets.mjs`.
  Nada de assets «NC / todos los derechos reservados» en `public/` si la
  distribución debe ser MIT-compatible.

---

## 6. Tooling asumido y necesidades del proyecto nuevo

| Herramienta | Versión / evidencia en el repo | Necesidad proyecto nuevo |
|---|---|---|
| Blender (autoría offline) | **5.2.0 LTS** verificado en background (`docs/城市制作路线.md:18`); ruta cableada macOS `/Applications/Blender.app/Contents/MacOS/Blender` (`scripts/rebuild_city_assets.mjs:8`, `scripts/build_bamboo_cafe.py:69`); cada manifiesto guarda `bpy.app.version_string` (p. ej. `scripts/build_floatplane.py:331`, `scripts/build_landmark_details.py:174`) | Fijar la misma versión (o LTS posterior **pinneada**) en todas las máquinas; parametrizar la ruta (Linux: el path macOS no existe aquí); guardar `blender_version` en cada manifiesto |
| Python + `.venv` | `requirements.lock.txt`: shapely 2.1.2, numpy 2.5.2, rasterio 1.4.4, pillow 12.3.0, pyproj, matplotlib…; `prepare_*` corre con este intérprete | Reutilizar el lock como base; ya trae rasterio/GDAL para MDT del IGN |
| Node + gltf-transform + meshoptimizer | `@gltf-transform/{core,extensions,functions} ^4.5.0`, `meshoptimizer ^1.2.0` (`package.json:24-27`); usados por `optimize_*.mjs` (weld/meshopt/prune/dedup) y `check_*.mjs` | Idéntico stack para `optimize_*` + `check-*` + `finalize` |
| Playwright + Chrome | `scripts/check_landmark_details.mjs:8` (Chromium headless, screenshots) | Opcional al inicio; obligatorio antes de integrar assets al juego |
| Git LFS | `.gitattributes:2-17` | Imprescindible desde el día 1 (GLB, HDR, blend, PNG) |
| Cloudflare R2 / wrangler | `cloudflare/README.md`, `scripts/cloudflare/sync-r2.mjs` | Diferible post-MVP; diseñar rutas `public/` compatibles desde ya |
| Babylon.js | `^8.0.0` (`package.json`) | El proyecto nuevo hereda el mismo contrato de loader (raíz neutralizada, reflexión Z) |

`UNKNOWN`: versión exacta del SDK de Blender Python / gtlf-exporter interno
(no consta pinneado; viene con Blender 5.2.0 LTS).

---

## 7. Veredicto de reutilización por pieza

| Pieza del repo | Veredicto | Justificación |
|---|---|---|
| `city_mesh.B` + `face/box/tube/loft/footprint/finish` | **REUSE-WITH-PARAMS** | Primitivas genéricas sin conocimiento urbano (`scripts/city_mesh.py:32-69`); extraer a `rural_mesh.py` sin materiales ni rutas cableadas |
| `city_mesh.material()` + paleta + `export()` | **SHENZHEN-ONLY** | Paleta urbana y rutas `public/city` cableadas (`scripts/city_mesh.py:11,23-31`); reescribir paleta rural + rutas `public/rural/` |
| Patrón `prepare_*.py` (shapely→JSON) | **REUSE-WITH-PARAMS** | El patrón es genérico; el contenido (capas land/park/water/sea, anchos viales) es urbano (`scripts/prepare_city_ground.py`, `scripts/prepare_city_streets.py`) |
| `build_canopy_trees.py` (especies + LOD + placement con STRtree) | **REUSE-WITH-PARAMS** | Arquitectura reutilizable (prepare con pruebas de clearance + build con LOD + budgets + manifiesto); especies subtropicales NO sirven (reescribir tabla `SPECIES` con pino/roble/haya, alturas 8-20 m) |
| `build_landscape_assets.py` / `build_open_vegetation.py` / `build_solid_tree_lods.py` | **REUSE-WITH-PARAMS** | Sistema de atlas 1024 + LOD + manifiesto con budgets (`scripts/build_landscape_assets.py:268`); contenido urbano a reemplazar |
| `build_vehicle_candidate.py` (pipeline CarConcept→runtime) | **REUSE-WITH-PARAMS** | El pipeline (importar, enderezar pose, reescalar, decimación selectiva, separar por material, pivotes, manifiesto con `wheelCentresGltf`, asserts) es reutilizable; el contenido (GT urbano 5 m, `length=5.0`) es **SHENZHEN-ONLY**; un 4x4 exige otra fuente + cinemática distinta |
| `build_driving_assets.py` (calzadas por teselas 640 m + marcas) | **REUSE-WITH-PARAMS** | Técnica de teselado y pintado reutilizable; adapt ar a pistas de tierra (sin marcas viales, con roderas/bordes blandos) |
| `build_landmark_details.py` + `prepare_landmark_terrain.py` + `prepare_city_mountains.py` | **REUSE-WITH-PARAMS** | Patrón terreno-detalle (DSM→malla + hito + colisiones + `arrival()`) directamente aplicable al repetidor y al terreno; datos GLO-30/Overture a sustituir por MDT-IGN |
| `build_city_ground.py` + `prepare_city_ground_relief.py` | **REUSE-WITH-PARAMS** | Malla de suelo por capas disjuntas; capas a redefinir (tierra/pista/erial/agua) |
| `build_traffic_signals.py` (mástiles) | **REUSE-WITH-PARAMS** | Única referencia de mástiles/postes (`:171-182`); geometría de poste reutilizable como punto de partida del mástil del repetidor |
| `build_city_facades.py` + `split_city_facades.mjs` + streaming | **SHENZHEN-ONLY** | Fachadas urbanas de Shenzhen; sin equivalente rural en el MVP |
| `finalize_city_assets.mjs` + `rebuild_city_assets.mjs` + `check-*` | **REUSE-AS-IS** (adaptando rutas) | Validación por hash, estadificación de candidatos y auditorías CPU/browser son agnósticas al contenido |
| `.gitattributes` (LFS) + `.gitignore` (artifacts/output/data crudos) | **REUSE-AS-IS** | Copiar casi literal |
| `data/ATTRIBUTION.md` + `public/licenses/` | **REWRITE** (contenido) / **REUSE-AS-IS** (estructura) | Estructura a imitar; contenido Shenzhen no sirve; crear entradas IGN-CC-BY-4.0 + OSM-ODbL |
| `build_bamboo_cafe.py` / `build_city_life_hub.py` (interiores heroicos) | **SHENZHEN-ONLY** | Sin equivalente en el MVP rural |
| Personajes MMD/miHoYo | **SHENZHEN-ONLY** (excluir) | Términos NC + no redistribución (`README.md:204`); incompatibles con distribución MIT-compatible |

---

## 8. Assets faltantes del MVP y punto de partida en el repo

| # | Asset MVP | ¿Builder/librería de partida? | Qué reutilizar / qué crear |
|---|---|---|---|
| 1 | **Terreno** (malla rural ~término de Villafranca, MDT remuestreado) | Sí — `prepare_landmark_terrain.py` + `prepare_city_mountains.py` (DSM→malla) y `build_city_ground.py` + `prepare_city_ground.py` (capas disjuntas + triangulación) | Reutilizar pipeline y presupuestos; sustituir GLO-30 por MDT-IGN (CC-BY 4.0); redefinir capas a tierra/pista/erial/agua; mantener el descargo «interpolado ≠ medido» |
| 2 | **4x4** (vehículo jugable con pivotes de rueda, vano libre alto) | Parcial — `build_vehicle_candidate.py` como **plantilla de pipeline**, no de contenido | Reutilizar: enderezado de pose, decimación selectiva, separación por material, `wheelCentresGltf` + `wheelRadius` en manifiesto, asserts (110k tris/<28 mallas/8 MiB a recalibrar). Crear: nueva fuente con licencia CC0/CC-BY (el CarConcept es un GT urbano, no un 4x4); cinemática de suspensión fuera del alcance del builder actual |
| 3 | **Tramos de pista forestal** (rectas, curvas, cruces en tierra) | Sí — `prepare_city_streets.py` (unión de calzadas, reservas) + sección de calzadas de `build_driving_assets.py` (teselas 640 m, `pavement`/`asphalt` por cara) | Reutilizar teselado y reservas de carril; sustituir `asphalt/roadline` por tierra con roderas (dos bandas oscuras) y borde blando; eliminar marcas viales |
| 4 | **Árboles** (pinos/robles de la zona, 3 LOD, colocación con clearances) | Sí — `build_canopy_trees.py` (6 especies × 3 LOD, budgets 4800/1700/220, placement con STRtree y pruebas contra carretera/edificio/agua) + atlas de `build_landscape_assets.py` | Reutilizar arquitectura prepare+build+manifiesto; reescribir `SPECIES` (pino albar, roble, haya; portes 8-20 m) y paletas; coronas en clumps opacos (misma técnica, sin alpha cards) |
| 5 | **Cercas / portones** (postes + alambre/tablas, portón animable) | Parcial — primitivas `B.box/tube/face` (`scripts/city_mesh.py:40-47`) como librería de formas; sin builder de cercas existente (`UNKNOWN`: ningún `build_*` modela cercas; solo mástiles en `build_traffic_signals.py:171-182`) | Crear `build_rural_fences.py` sobre `B.*`; portón con pivote documentado en manifiesto estilo `wheelCentresGltf`; postes reutilizables para el vallado del repetidor |
| 6 | **Instalación de repetidor** (mástil + caseta + vallado + placa solar) | Parcial — `build_landmark_details.py` (patrón hito: geometría + `footprint()` de colisión + `arrival()` + registro) + `build_traffic_signals.py:171-182` (mástil con brazo) + `B.tube/loft/box` | Crear `build_repeater_site.py` sobre el patrón landmark; mástil como `tube` ahusado (`r2`), caseta como `box/footprint`, vallado del builder de cercas; colisiones y radio de exclusión como en `landmark-detail.json` |

Nada del MVP parte de cero salvo el **contenido** (especies, vehículo, capas de
suelo): todos tienen pipeline o primitivas de partida. Lo que **no** existe en
el repo y hay que diseñar: cinemática de 4x4 (suspensión/diferenciales),
roderas deformables y portones animados en runtime (el repo solo anima ruedas,
personajes y válvulas simples).

---

## Confianza

- **Alta:** API `city_mesh` (leída entera, `scripts/city_mesh.py:1-75`),
  semántica build/prepare/check (orquestador + 6 ficheros leídos), convención
  `export_yup=True` (13 sitios vía `grep`), presupuestos con asserts (3
  ficheros), mecanismo de manifiesto (`finalize_city_assets.mjs` entero),
  licencias (textos reales de `LICENSE`, `README.md:194-207`,
  `data/ATTRIBUTION.md`, 7 ficheros de `public/licenses/`), LFS/R2
  (`.gitattributes`, `cloudflare/README.md`).
- **Media:** mapeo MVP→builders para cercas/portones/repetidor (inferido de
  primitivas + patrón landmark; no existe builder previo que lo confirme) y
  versiones exactas de Python/Node (el lock y `package.json` dan rangos,
  no versiones instaladas medidas).
- **Baja / UNKNOWN:** versión del exporter glTF interno de Blender (acoplada
  al binario 5.2.0 LTS, no pinneada aparte); si algún `check-*` no muestreado
  escribe artefactos; presupuestos óptimos para hardware objetivo del proyecto
  nuevo (los citados son del prototipo Shenzhen, hay que recalibrar).
- **Riesgo principal:** licencias. El repo resuelve código-MIT vs
  assets-con-sus-términos con disciplina de manifiestos; el proyecto nuevo debe
  replicar esa disciplina desde el primer asset IGN/OSM. La sección 5.2 es
  valoración de ingeniería, no asesoramiento legal.
