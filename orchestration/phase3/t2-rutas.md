# TASK PACKET T2 — FASE 3a: red vial rural (SOLO DATOS, sin runtime)

## Estándares del proyecto (auto-resueltos)
- `/home/kiri_/projects/montes-de-oca` (motor GTA_SZ) es **READ-ONLY**: podés leerlo, jamás modificarlo.
- Proyecto propio: `/home/kiri_/projects/montes-de-oca-offroad`. Ahí va tu output.
- Documentación en **español** técnico.
- **No hagas commits git.** Nunca agregues `Co-Authored-By` ni atribución de IA.
- Si descubrís algo no obvio, guardalo en engram con `mem_save` y `project: "montes-de-oca"`.

## Contexto
Juego: **"Montes de Oca: Offroad Stories"**, mundo abierto rural en navegador ambientado en
**Villafranca Montes de Oca** (Burgos). El objetivo central es **conducir un 4x4 por pistas forestales**.
Sos la **capa de datos vial**: producir la red de caminos rurales lista para consumir. **NO escribas
código de runtime** (nada de `src/`): de eso se encarga otro worker después.

## CONVENCIÓN DE COORDENADAS (fija — NO la reinterpretes)
- Proyección `EPSG:25830` (UTM 30N). Todo en **metros**, `worldScale = 1` (una unidad = un metro).
- **Ventana del mapa**: `E=[471500, 477500]`, `N=[4689000, 4695000]` → 6000 × 6000 m exactos.
- **Origen del mundo** = esquina SUDOESTE: `E0=471500`, `N0=4689000`.
  `worldX = E − 471500` · `worldZ = N − 4689000`. X crece al **este**, Z al **norte**.
- En WGS84 la ventana es `SW lon=-3.346047 lat=42.352742` / `NE lon=-3.273430 lat=42.406975`.

## ⚠️ DATO IMPORTANTE: el bbox de OSM que ya existe NO sirve
En `data/geo/raw/` hay un `osm_highways_bbox.geojson.json` bajado con un bbox **anterior y corrido al
sudoeste**: `[42.350651, -3.350784, 42.404549, -3.277816]`. Verificado: **no cubre la ventana de arriba**
— le faltan ~361 m al este y ~270 m al norte. Si lo usás, el noreste del mapa queda sin calles y las
pistas aparecen cortadas contra una frontera invisible.
**Tenés que volver a consultar Overpass con la ventana EXACTA de arriba** (con un pequeño buffer para
capturar las vías que cruzan el borde; Overpass devuelve la geometría completa de las vías que
intersectan, así que el buffer es sólo por seguridad).

## GOAL
La red vial rural completa de la ventana, **clasificada para off-road**, en coordenadas de mundo, con
toda la metadata de OSM preservada, verificada y lista para que el runtime la drapee sobre el terreno.

## CLASIFICACIÓN (esto es lo nuevo: el motor de referencia NO soporta pistas)
La auditoría verificó que el motor de referencia tiene una whitelist **urbana** que excluye
`track` y `path` (`scripts/prepare_driving_city.py:31`), y que **nunca** lee `tracktype`, `surface`,
`smoothness` ni usa `access` para otra cosa que descartar (`:35`). O sea: esta clasificación es **neta nueva**.

| Clase | `highway=` | Uso en el juego |
|---|---|---|
| `ROAD` | `trunk`, `primary`, `secondary`, `tertiary`, `unclassified`, `residential`, `living_street`, `service` | Asfalto/rodado firme. Se conduce normal. |
| `TRACK` | `track` | **El corazón del juego.** Firme natural. Ancho y calidad según `tracktype`. |
| `PATH` | `path`, `footway`, `bridleway`, `cycleway`, `steps`, `pedestrian` | Senda. No apta para 4x4 (o con penalización fuerte). |
| `EXCLUDE` | `proposed`, `construction`, `raceway`, y lo que filtren `access`/`motor_vehicle` | Fuera |

Guardá `tracktype` (`grade1`…`grade5`), `surface`, `smoothness`, `access`, `name`, `ref` y el ancho si
existe. **Preservá los tags crudos** para no tener que volver a bajar OSM si después queremos otro campo.

**Ancho sugerido por clase** (documentalo y decí que es estimación de diseño, no medición):
`ROAD` por tipo (`trunk` 7,5 m / `primary` 7 / `secondary` 6,5 / `tertiary` 6 / `residential` 5,5 /
`service` 4,5), `TRACK` por `tracktype` (`grade1` 4,5 m → `grade5` 2,5 m, sin dato 3,5 m), `PATH` 1,5 m.

**Penalización de velocidad por clase y `tracktype`**: proponé una tabla (el `ROAD` es la referencia 1,0;
`track/grade1` ≈ 0,6; `grade5` ≈ 0,25; `PATH` ≈ 0,1). Justificá cualitativamente y documentá que es
**diseño de gameplay, no dato**.

## Deliverables
| Archivo | Qué es |
|---|---|
| `scripts/roads/fetch_osm_roads.py` | Overpass con la ventana EXACTA. `User-Agent` explícito. Guarda SHA256 + URL + timestamp |
| `scripts/roads/build_roads.py` | recorte a la ventana, clasificación, grafo, simplificación, validación |
| `data/roads/raw/*.json` | respuesta cruda de Overpass (por si hay que reprocesar) |
| `public/roads/roads.json` | **el entregable**: vías con clase, ancho, penalización, tags y geometría en coords de mundo |
| `public/roads/navigation.json` | grafo nodos/aristas para pathfinding (ver abajo) |
| `public/roads/stats.json` | km por clase, por `tracktype`, conectividad, cobertura |
| `public/roads/ATTRIBUTION.md` | **ODbL de OpenStreetMap**: atribución + la nota de share-alike |
| `docs/roads/ROADS_FASE3.md` | qué hiciste, la clasificación, las tablas, los números, y qué NO quedó |

### Grafo de navegación
El motor de referencia tiene un `RoadGraph` + Dijkstra en `src/navigation.ts` con nodos **cuantizados**
(`/3` en `src/navigation.ts:2-4`) que la auditoría marcó **REUSE-AS-IS** (agnóstico a la topología).
Leé ese archivo y `src/city-types.ts` y **producí el grafo con un formato compatible** (misma idea de
nodos cuantizados + aristas con largo y clase), para que el runtime lo consuma sin traducción.
**Adaptá el esquema, no copies el archivo.**

## MÉTODO
1. Leé `src/navigation.ts`, `src/city-types.ts` (tipo `Road`) y `scripts/prepare_driving_city.py` del repo
   de referencia, para alinear el esquema de salida.
2. Bajar OSM con la ventana exacta. **Overpass exige `User-Agent`** o devuelve 406. Usá
   `https://overpass-api.de/api/interpreter` (verificado funcionando). No uses `overpass.kumi.systems`
   (devolvió `000`).
3. Recortá a la ventana, clasificá, y construí el grafo.
4. **Validá la conectividad** (ver abajo) antes de entregar.
5. Escribí los deliverables + el doc.

## CONSTRAINTS
- **PROPIEDAD DE ARCHIVOS — hay varios workers en paralelo.** Podés escribir **sólo** en:
  `scripts/roads/**`, `data/roads/**`, `public/roads/**`, `docs/roads/**`.
  **PROHIBIDO tocar**: `src/**` (lo está usando otro worker), `scripts/terrain/**`, `data/terrain/**`,
  `public/terrain/**`, `scripts/geo/**`, `data/geo/**`, `docs/geo/**`, `docs/audit/**`, `orchestration/**`.
- **NO escribas código de runtime.** Ni una línea en `src/`.
- No toques el repo de referencia.
- Python: usá el `.venv` del repo (`rasterio`, `numpy`, `pyproj`, `shapely` ya están). **No agregues deps.**
- No hagas commit.
- **No inventes resultados.** Si Overpass falla o la cobertura es parcial, decilo.

## VALIDATION (lo que decide si acepto el trabajo)
1. `stats.json` real con: km por clase, conteo de ways, km por `tracktype`.
2. **Cobertura**: confirmá que **ninguna** vía quedó cortada por el borde de la ventana de recorte por
   error de consulta (las que salen del mapa están bien; las que terminan abruptamente adentro, no).
   Reportá cuántas vías tocan el borde y por qué es correcto.
3. **Conectividad** — el número que más me importa: **desde Villafranca (worldX=3097, worldZ=3945),
   cuántos km de `TRACK` son alcanzables** siguiendo el grafo. Y qué % del total de `TRACK` de la ventana
   representa. Si es bajo, investigá por qué (huecos de mapeo, filtros de `access` demasiado agresivos) y
   reportalo — **no lo escondas**.
4. Confirmá que hay geometría de pista en **todo** el cuadrante noreste (el que el bbox viejo no cubría).
5. Pegá el `stats.json` completo en tu respuesta.

## RESPUESTA FINAL
Archivos creados · comandos exactos + salida · el `stats.json` · el resultado de la conectividad desde el
pueblo · el ancho y la penalización por clase con su justificación · **qué NO quedó hecho**.
