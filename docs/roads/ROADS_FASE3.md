# FASE 3a — Red vial rural (solo datos, sin runtime)

Producto de la capa de datos vial de **Montes de Oca: Offroad Stories**: la red de
caminos de la ventana jugable, clasificada para off-road, en coordenadas de mundo,
verificada y lista para que el runtime la drapee sobre el terreno.

> **Alcance:** este documento y los scripts asociados **no escriben ni una línea en
> `src/`**. El consumo (drapeo, física, pathfinding en runtime) es de otro worker.

---

## 1. Resumen ejecutivo

| Métrica | Valor |
|---|---|
| Ways descargados de OSM | **469** |
| Ways conservados (dentro de la ventana y jugables) | **434** (438 segmentos) |
| Longitud total jugable | **139,021 km** — ROAD 20,592 · TRACK 91,515 · PATH 26,914 |
| TRACK con `tracktype` | 144 de 213 segmentos (67,6 %) → 18,594 km sin dato |
| Grafo de navegación | **3 869 nodos / 4 007 aristas / 10 componentes** (la mayor = 98,2 % de los nodos) |
| **TRACK alcanzable desde Villafranca (3097, 3945)** | **89,553 km = 97,9 %** |
| TRACK alcanzable solo por vías rodables (sin sendas) | 87,324 km = 95,4 % |
| Vías tocadas por el borde de la ventana | 46 (55 endpoints) |
| **Endpoints interiores que NO son un node original** | **0** ← recorte correcto |
| Auditoría con buffer 0,01°: ways que intersectan la ventana y faltan | **0** |
| TRACK en el cuadrante noreste (x ≥ 3000, z ≥ 3000) | **22,295 km en las 9 celdas de 1 km** |

---

## 2. Convención de coordenadas (fija, respetada al pie de la letra)

- Proyección **EPSG:25830** (UTM 30N), metros, `worldScale = 1`.
- Ventana: `E = [471500, 477500]`, `N = [4689000, 4695000]` → 6000 × 6000 m exactos.
- Origen del mundo = esquina **sudoeste**: `E0 = 471500`, `N0 = 4689000`.
  `worldX = E − 471500` · `worldZ = N − 4689000`. X crece al este, Z al norte.

### Hallazgo no obvio: el rectángulo WGS84 de la ventana NO es el de las dos esquinas

El enunciado da `SW lon=-3.346047 lat=42.352742` / `NE lon=-3.273430 lat=42.406975`.
Esas son las **dos esquinas opuestas** del rectángulo UTM, pero por la **convergencia de
UTM 30N** el rectángulo proyectado tiene los otros dos vértices en:

```
SW (471500, 4689000) -> -3.346047, 42.352742
SE (477500, 4689000) -> -3.273196, 42.352939   <- lon máximo real
NE (477500, 4695000) -> -3.273430, 42.406975
NW (471500, 4695000) -> -3.346344, 42.406778   <- lon mínimo real
```

Si se consulta Overpass con el rectángulo literal `(42.352742, -3.346047, 42.406975, -3.273430)`
se pierde un filete de ~25 m en el borde oeste y ~19 m en el este. Por eso
`fetch_osm_roads.py` **muestrea los 4 bordes** (cada 250 m), toma el envolvente real
`lat ∈ [42.352742, 42.406975]`, `lon ∈ [-3.346344, -3.273196]` y le suma el buffer.

---

## 3. Fuente de datos: por qué se volvió a bajar OSM

El archivo `data/geo/raw/osm_highways_bbox.geojson.json` (bbox `[42.350651, -3.350784,
42.404549, -3.277816]`) **no sirve para esta ventana**: está corrido al sudoeste y no
cubre el noreste. Cuantificado sobre la ventana jugable:

| Clase | km de la ventana que el bbox VIEJO no cubría | Ways afectados |
|---|---|---|
| TRACK | **10,298 km** | 91 |
| ROAD | 3,489 km | |
| PATH | 1,856 km | |
| **Total** | **15,643 km** | **91** |

Por eso se consultó Overpass de nuevo con la ventana exacta + buffer.

### Consulta realizada

```
[out:json][timeout:180];
way["highway"](42.351242,-3.347844,42.408475,-3.271696);
out tags geom qt;
```

- **Endpoint:** `https://overpass-api.de/api/interpreter` (POST).
- **User-Agent explícito:** `MontesDeOcaOffroad-RoadsBot/1.0 (open-world driving game data; offline research)`
  — Overpass responde **406** con UA genérico.
- **Buffer:** `0,0015°` (≈165 m de latitud, ≈123 m de longitud) sobre el envolvente real.
- **`out tags geom` SIN bbox:** con `out geom(bbox)` Overpass **recorta** la geometría
  (deja el primer/último punto fuera del bbox) y ahí sí se perderían tramos.
- **Sin node ids a propósito:** la conectividad se reconstruye por igualdad exacta de
  coordenadas — Overpass serializa el mismo node con el mismo `lat/lon` en todas las
  ways que lo comparten, así que la igualdad de coordenadas reproduce la conectividad
  de OSM sin necesidad de bajar los nodos.
- Overpass devuelve **HTTP 504 con frecuencia** (servidor saturado): el script reintenta
  con backoff (6 intentos, 8 s).

### Reproducción exacta

```bash
# 1. descarga (ventana exacta + buffer)
.venv/bin/python scripts/roads/fetch_osm_roads.py --force
# 2. descarga de auditoría (buffer grande, para probar que no falta nada)
.venv/bin/python scripts/roads/fetch_osm_roads.py --buffer-deg 0.01 \
    --name osm_highways_audit_buffer001.json --force
# 3. construcción
.venv/bin/python scripts/roads/build_roads.py
# 4. validación cruzada independiente
.venv/bin/python scripts/roads/validate_roads.py
```

Salida real de (1):

```
BBox consulta (S,W,N,E) = 42.351242,-3.347844,42.408475,-3.271696  (buffer 0.0015 deg)
Endpoint: https://overpass-api.de/api/interpreter
Descargando...
  intento 1/6 -> HTTP 504, reintento en 8s
HTTP 200 en 2 intento(s)
osm3s.timestamp_osm_base = 2026-09-24T22:33:36Z
elementos = 469 {'way': 469}
bytes = 529998  sha256 = 98782f981b1cd50737aeae5a0f646010338676a26edc138420f697ed522b99ef
-> data/roads/raw/osm_highways_window.json
-> data/roads/raw/osm_highways_window_manifest.json
```

Salida real de (3):

```
ways bajados       : 469
ways conservados   : 434  segmentos: 438
km por clase       : {'ROAD': 20.592, 'TRACK': 91.515, 'PATH': 26.914}  total 139.021 km
km por tracktype   : {'grade1': 1.259, 'grade2': 19.603, 'grade3': 7.851, 'grade4': 26.598, 'grade5': 17.61, 'sin_tracktype': 18.594}
excluidos          : 17.318 km -> ['access=private', 'highway=proposed', 'motor_vehicle=no']
grafo              : 3869 nodos / 4007 aristas / 10 componentes / mayor=3801
borde              : 46 ways / 55 endpoints en borde / 853 interiores / 0 erroneos
desvio max fuera   : 0.0 m
NE (km)            : {'TRACK': 22.2947744891071, 'ROAD': 11.593749142455822, 'PATH': 2.271718563373703}
desde Villafranca  : TODAS 89.553 km TRACK (97.9%) | SOLO RODABLES 87.324 km (95.4%)
TRACK inalcanzable : {'conexion_fuera_de_ventana': 1.818, 'hueco_de_mapeo': 0.144}
auditoria buffer   : coverage_ok=True (solo_en_audit=55, faltantes_que_intersectan=0)
```

Salida real de (4):

```
27/27 checks OK
TODO OK
```

---

## 4. Clasificación off-road

El motor de referencia tiene una whitelist **urbana** (`scripts/prepare_driving_city.py:31`)
que descarta `track` y `path`, y jamás lee `tracktype`, `surface` ni `smoothness`. Esta
clasificación es **neta nueva**.

| Clase | `highway=` | Uso en el juego |
|---|---|---|
| **ROAD** | `trunk`, `primary`, `secondary`, `tertiary`, `unclassified`, `residential`, `living_street`, `service` (+ `motorway`, ver nota) | Asfalto/rodado firme. Se conduce normal. |
| **TRACK** | `track` | **El corazón del juego.** Firme natural; ancho y calidad según `tracktype`. |
| **PATH** | `path`, `footway`, `bridleway`, `cycleway`, `steps`, `pedestrian` | Senda. No apta para 4x4 → penalización fuerte. |
| **EXCLUDE** | `proposed`, `construction`, `raceway`, `escape`, `ferry`, `corridor`, `via_ferrata`, `rest_area`, `services`, `bus_stop`, `platform`, y lo que filtren `access`/`motor_vehicle` | Fuera. |

Notas:

- Los `*_link` se clasifican por su tipo base (`tertiary_link` → ROAD).
- **Extensión documentada:** `motorway` queda en ROAD por coherencia (excluir una autovía
  sería un error). En la ventana **no hay ninguna** (`by_kind` lo confirma).
- **`access`/`motor_vehicle`:** solo se descartan los valores `no` y `private`.
  `agricultural` y `forestry` **no** se descartan: en un juego de pistas forestales son
  justamente el terreno que queremos.
- Preservados por vía: `tracktype`, `surface`, `smoothness`, `access`, `name`, `ref`,
  `width`, `oneway`, `layer`, `bridge`, `tunnel` y **los tags crudos completos** en el
  campo `tags` (para no tener que volver a bajar OSM si se necesita otro campo).

### Exclusiones reales (16 ways, 17,318 km)

| Motivo | Ways | km dentro de la ventana | Clase |
|---|---|---|---|
| `highway=proposed` (A-12 en proyecto) | 3 | 15,578 | — |
| `access=private` (accesos particulares) | 12 | 0,795 | ROAD 0,654 / PATH 0,141 |
| `motor_vehicle=no` | 1 | 0,945 | ROAD |

**Ningún `track` fue excluido por acceso.** Los filtros tocan ROAD y PATH nomás, por lo
que no pueden esconder pista (confirmado además con la variante diagnóstica de la §7.3).

Además: **19 ways quedaron completamente fuera de la ventana** (sólo tocaban el buffer)
y 46 cruzan el borde — esos 469 − 19 − 16 = 434 ways es exactamente `ways_kept`.

---

## 5. Tablas de diseño (ancho y velocidad)

> **Ambas tablas son DISEÑO de gameplay, no mediciones.** OSM no trae ancho fiable salvo
> el tag `width`, que sólo existe en **9 de 438** segmentos. Cuando existe, el tag manda
> y el campo `widthSource` lo declara (`osm_width` / `osm_est_width` frente a
> `diseno_*`).

### 5.1 Ancho

| Clase / tipo | Ancho | | Clase / `tracktype` | Ancho |
|---|---|---|---|---|
| `trunk` | 7,5 m | | `grade1` | 4,5 m |
| `primary` | 7,0 m | | `grade2` | 4,0 m |
| `secondary` | 6,5 m | | `grade3` | 3,5 m |
| `tertiary` | 6,0 m | | `grade4` | 3,0 m |
| `unclassified` | 5,5 m | | `grade5` | 2,5 m |
| `residential` | 5,5 m | | sin `tracktype` | 3,5 m |
| `living_street` | 5,0 m | | **PATH** (todos) | 1,5 m |
| `service` | 4,5 m | | | |
| `motorway` | 7,5 m | | | |

- `unclassified` y `living_street` **no venían en la tabla del encargo**: se les asignó
  5,5 m y 5,0 m respectivamente (unclassified = misma clase de vía que residential en
  España; living_street, algo más estrecha por ser zona de convivencia). Es una
  decisión de diseño, no dato.
- `service` en la ventana son sobre todo accesos cortos (11 ways, 1,754 km).

### 5.2 Penalización de velocidad (`speedFactor`)

Multiplicador sobre la velocidad máxima en asfalto (`ROAD = 1,0`). El runtime decide la
velocidad base; esto sólo dice *qué tan rápido se puede andar por acá*.

| Vía | `speedFactor` | Justificación cualitativa |
|---|---|---|
| `ROAD` (cualquier tipo) | **1,00** | Referencia: asfalto/rodado firme. |
| `track` / `grade1` | **0,60** | Firme excelente (compactado/grava), pero sigue siendo terreno natural: polvo, baches, animales. Nunca asfalto. |
| `track` / `grade2` | **0,50** | Buen estado con irregularidades puntuales; se mantiene ritmo pero sin tirar. |
| `track` / `grade3` | **0,42** | Rueda suelta y erosión visible: hay que moderar en las curvas. |
| `track` / `grade4` | **0,33** | Surcos y piedra suelta; el 4x4 ya pide bajar marchas. |
| `track` / `grade5` | **0,25` | Estela/informal: terreno blando, casi sendero; ritmo de senderismo motorizado. |
| `track` sin `tracktype` | **0,45** | Centro cauteloso: en España lo no etiquetado suele ser grade2–grade4; se asume lo intermedio sin premiar. |
| `PATH` | **0,10** | No está pensada para 4x4. El factor es tan agresivo que el pathfinding la evite salvo que sea el único vínculo, y si la toca, el ritmo es de sendero. |

Es una **curva monotónica** grade1→grade5 (0,60 → 0,25) anclada en los puntos que pidió
el encargo (`grade1 ≈ 0,6`, `grade5 ≈ 0,25`, `PATH ≈ 0,1`).

**No se aplicó** ningún módulo extra por `surface` ni `smoothness` (aunque ambos quedan
guardados): aplicar los dos sería doble conteo con `tracktype`, que ya codifica la
calidad del firme. Si más adelante se quiere, están los tags crudos para recalcular.

---

## 6. Números de la red

### 6.1 Por clase y por tipo (`length_km`)

| Clase | km | % |
|---|---|---|
| ROAD | 20,592 | 14,8 % |
| **TRACK** | **91,515** | **65,8 %** |
| PATH | 26,914 | 19,4 % |
| **Total** | **139,021** | |

| `highway` | Ways | km |
|---|---|---|
| `track` | 210 | 91,515 |
| `path` | 77 | 26,028 |
| `trunk` | 27 | 8,118 |
| `residential` | 77 | 5,193 |
| `tertiary` | 7 | 5,059 |
| `service` | 11 | 1,754 |
| `pedestrian` | 9 | 0,582 |
| `living_street` | 7 | 0,301 |
| `footway` | 5 | 0,207 |
| `unclassified` | 1 | 0,167 |
| `steps` | 3 | 0,097 |

*(No hay `primary`, `secondary`, `motorway`, `cycleway` ni `bridleway` en la ventana.)*

### 6.2 TRACK por `tracktype`

| `tracktype` | Segmentos | km |
|---|---|---|
| `grade1` | 7 | 1,259 |
| `grade2` | 31 | 19,603 |
| `grade3` | 23 | 7,851 |
| `grade4` | 49 | 26,598 |
| `grade5` | 34 | 17,610 |
| sin `tracktype` | 69 | 18,594 |

### 6.3 Por `surface` (sólo informativo; 88 de 438 segmentos lo traen)

`asphalt` 14,831 · `compacted` 6,687 · `dirt` 2,366 · `ground` 1,584 · `concrete` 0,715 ·
`gravel` 0,462 · `paving_stones` 0,185 · `grass` 0,090 · `wood` 0,015 km.

### 6.4 Otras cifras de contexto

- 20 puentes (`bridge=yes`), 0 túneles, 8 `oneway`, 117 segmentos con `name`.
- 40 nodos donde confluyen ways con `layer` distinto (`grade` `0`/`1`): en los 40 la way
  con `layer=1` tiene `bridge=yes` y en 37 de 40 ambas ways comparten `name`/`ref`/tipo
  (p. ej. `551252195`/`551252200`, ambas *Camino de Santiago*): son los **cortes de
  puente** de la misma vía, conexión legítima, no un cruce a distinto nivel mal
  conectado. (No todos los IDs son consecutivos — sólo 19/40 lo son —, por eso la
  prueba es el `bridge=yes` + nombre compartido, no la cercanía de los IDs.)
- Simplificación con **vértices compartidos protegidos**: 6 911 → 4 450 vértices (−35,6 %)
  acortando sólo 0,053 km (0,038 %). Sin esa protección, Douglas-Peucker borraría cruces
  y partiría la red en silencio.

---

## 7. Validaciones

### 7.1 Cobertura: ninguna vía quedó cortada por error de consulta

Tres pruebas independientes:

**(a) Auditoría de buffer (la fuerte).** Se bajó una **segunda** copia con buffer de
`0,01°` (≈1,1 km de margen): 524 ways contra los 469 de la descarga principal.

| Chequeo | Resultado |
|---|---|
| Ways que están sólo en el buffer grande | 55 |
| Ways que están sólo en la descarga principal | 0 |
| **De esas 55, ¿alguna intersecta la ventana con largo > 0?** | **0 → `coverage_ok: true`** |

Es decir: **no existe ninguna way que cruce la ventana y no esté en la descarga
principal**. La consulta no dejó nada afuera. (Esto además valida empíricamente el
supuesto de que el filtro bbox de Overpass no recorta geometría: `out geom` se pidió sin
bbox, y las 55 ways extra están fuera de la ventana, no cortadas.)

**(b) Verificación de extremos (la del recorte).** Para cada endpoint de cada segmento
recortado se comprueba que sea **o** un point sobre el borde de la ventana **o** un
**node original** de la way en OSM:

| Métrica | Valor |
|---|---|
| Ways que tocan/cruzan el borde | 46 (con 46 que efectivamente pierden longitud fuera: `ways_crossing_border = 46`) |
| Endpoints **sobre el borde** (cortes legítimos del recorte) | 55 |
| Endpoints **interiores** | 853 — **todos** son un node original de OSM |
| **Endpoints interiores que NO son un node original** | **0** ← `clip_errors: []` |
| Desvío máximo de un punto fuera de la ventana | **0,0 m** |

Si el recorte hubiera cortado una vía en falso, ese punto sería interior y no coincidiría
con ningún node de la way: el contador daría > 0. Da 0.

**(c) Conteo de formas.** 469 ways = 404 completamente adentro + 46 que cruzan el borde +
19 completamente fuera (sólo tocaban el buffer). Cierra exacto.

> **¿Por qué 46 ways en el borde es correcto?** Porque Overpass devuelve la geometría
> **completa** de las ways que intersectan el bbox; la longitud que queda fuera de la
> ventana (121,200 km, de los cuales 64,2 km son las tres ways `proposed` de la A-12, de
> 39,4 / 24,3 / 16,1 km) es geometría real que sigue existiendo más allá del mapa. El
> recorte la saca del entregable porque el mundo del juego mide 6 × 6 km, **no** porque
> la consulta haya fallado. Las vías que salen del mapa están bien; las que terminan
> abruptamente adentro, no — y de éstas hay 0.

### 7.2 Cuadrante noreste (el que el bbox viejo no cubría)

| Cuadrante (x ≥ 3000, z ≥ 3000) | ROAD | TRACK | PATH |
|---|---|---|---|
| Noreste | 11,594 km | **22,295 km** | 2,272 km |

Rejilla de 1 km — TRACK por celda en el cuadrante noreste (todas con dato):

| z \ x | 3000 | 4000 | 5000 |
|---|---|---|---|
| **5000** | 1,923 | 3,491 | 3,939 |
| **4000** | 3,407 | 1,683 | 0,136 |
| **3000** | 3,908 | 2,841 | 0,968 |

**9 de 9 celdas del cuadrante noreste tienen geometría de pista.** (El validador lo
chequea como test: `cobertura: las 9 celdas del cuadrante NE tienen TRACK — 9/9`.)
La celda con menos (0,136 km, esquina este/z=4000) es real: ahí está el valle y la
autovía, no bosque. El detalle de las 36 celdas está en `stats.coverage.grid_1km_km`.

### 7.3 Conectividad desde Villafranca (worldX 3097, worldZ 3945)

Método: se proyecta el punto al **arista más cercana** (8,51 m, `Calle Mayor`, clase ROAD),
se siembran ambos extremos y se recorre el grafo. Para un conjunto de aristas permitidas,
una arista cuenta como alcanzada si **ambos** extremos lo están (así los ciclos no
subestiman los km). Se calcula alcanzabilidad, no distancia: el peso no cambia el
resultado.

| Variante | Clases permitidas | TRACK alcanzado | % del TRACK total | Nodos | Aristas |
|---|---|---|---|---|---|
| **todas las clases** | ROAD + TRACK + PATH | **89,553 km** | **97,9 %** | 3 801 | 3 947 |
| solo rodables | ROAD + TRACK | 87,324 km | 95,4 % | 2 869 | 2 953 |
| diagnóstico (incluye ways excluidas por `access`) | ROAD + TRACK + PATH | 89,593 km | 97,9 % | 3 946 | 4 095 |

Lectura:

- **97,9 % del TRACK es alcanzable desde el pueblo.** 2,229 km de pista sólo se llega
  atravesando una `PATH` (con `speedFactor` 0,1): el pathfinding puede usarlas, pero le
  sale caro, así que preferirá la vía rodable cuando exista.
- **Los filtros de `access` NO son el problema:** incluyendo de vuelta las 16 ways
  excluidas, el TRACK alcanzable sube de 89,553 a 89,593 km (**+0,040 km**). Los filtros
  cuestan 40 metros de pista, nada más. Sí sube el ROAD alcanzado (20,560 → 22,090 km),
  porque los accesos privados son cortos caminos de servicio.
- Distancia de ruta máxima desde el arranque: **6 531 m** (recorrido, no desplazamiento).

**El 2,1 % que NO se alcanza (1,962 km de TRACK) investigado, componente por
componente** — 9 componentes aisladas sobre 10:

| # | Vías | TRACK | ¿Toca el borde? | Dist. a la red principal | Causa |
|---|---|---|---|---|---|
| 1 | `1228075600` | 544 m | sí (norte) | 566 m | conexión fuera de la ventana |
| 2 | `170306190` | 472 m | sí | 786 m | conexión fuera de la ventana |
| 3 | `858669218.1` | 348 m | sí (este) | 74 m | conexión fuera de la ventana (la *otra* parte de esa way, 1 881 m, está en la red principal) |
| 6 | `218781062` | 398 m | sí (ambos extremos) | 157 m | conexión fuera de la ventana |
| 7 | `1228075601` | 49 m | sí | 703 m | conexión fuera de la ventana |
| 9 | `741763074` | 8 m | sí | 2,4 m | conexión fuera de la ventana |
| 4 | `858630485` (2 partes) | 104 m | **no** | 37 m | **hueco de mapeo** (bucle interior sin node compartido) |
| 5 | `1120670232` | 40 m | **no** | 32 m | **hueco de mapeo** |
| 8 | `168431338` (ROAD, 32 m) | — | sí | 8,9 m | conexión fuera de la ventana |

- **1,818 km (92,7 % de lo inalcanzable): vías que se van por el borde.** Su empalme real
  está **fuera** del mapa; dentro de la ventana son punta ciega. Es geometría legítima,
  no un error de consulta ni de recorte (los 55 endpoints de borde lo confirman).
- **0,144 km (7,3 %): huecos de mapeo de OSM** — dos ways adentro de la ventana que no
  comparten node con nadie, a 37 m y 32 m de la red. Están **reportados**, no ocultos.
  Arreglarlos es editar OSM (unir los cruces), no tocar los datos del juego; también se
  podrían unir en tiempo de build con una tolerancia de ~40 m, pero eso **inventa**
  cruces y se decidió no hacerlo con un valor tan grande (un snap de 1 m sí está activo,
  con 3 aplicaciones, todas ≤ 0,83 m — detalle en `stats.coverage.snap`).
- `duplicate_edges_same_pair = 5`: cinco tramos de 4–13 m donde una way de `path` está
  mapeada **sobre** la misma geometría que una calle. El `Map` del `RoadGraph` sólo
  conserva una arista; aquí se desempata a favor de la clase rodable y se registra el
  caso (`tie_break`), para que ningún tramo de asfalto quede etiquetado como senda.

---

## 8. Esquema de salida y compatibilidad con el motor de referencia

### `public/roads/roads.json` → `{meta, roads[]}`

Alineado al tipo `Road` de `src/city-types.ts`:

```ts
{ id: string; name: string; kind: string; width: number;
  oneway: boolean; points: [number, number][]; grade: string }   // <- Road del motor
```

Campos nuevos encima de eso:

```jsonc
{
  "id": "858669218.1",        // "wayId" o "wayId.N" si el recorte partió la way
  "osmType": "way", "osmId": 858669218,
  "name": "", "ref": "N-120",
  "kind": "track",             // highway crudo (compat Road.kind)
  "class": "TRACK",            // ROAD | TRACK | PATH  <- lo nuevo
  "width": 3.5, "widthSource": "diseno_track/grade3",   // o "osm_width"
  "speedFactor": 0.42,         // diseno de gameplay
  "oneway": false, "onewayValue": "",
  "grade": "0",                // == tag layer (compat Road.grade)
  "tracktype": "grade3", "surface": "", "smoothness": "",
  "access": "", "bridge": false, "tunnel": false,
  "length": 1880.67,           // metros
  "points": [[6000.0, 1801.09], ...],   // coords de mundo, cm de precisión
  "tags": { "highway": "track", ... }    // tags crudos COMPLETOS
}
```

> ⚠️ **`grade` NO es la calidad de la pista.** En el motor de referencia `grade` es el
> tag `layer` (`city-rain-puddles.ts:93` y `city-roadside-planting.ts:114` lo usan como
> `Number(road.grade)!==0` para saltarse puentes). Se conserva ese significado para no
> romper la compatibilidad; la calidad de la pista está en **`tracktype`**. El mismo
> aviso está en `roads.json.meta.grade_semantics`.

### `public/roads/navigation.json` → `{meta, nodes[], edges[], edgeMeta[]}`

```jsonc
{
  "nodes":  [[3097.0, 3945.0], ...],       // un nodo por VÉRTICE de vía
  "edges":  [[0, 1], ...],                 // pares de índices, grafo NO dirigido
  "edgeMeta": [{ "length": 3.2, "class": "TRACK", "roadId": "123",
                 "kind": "track", "tracktype": "grade3",
                 "speedFactor": 0.42 }, ...]   // paralelo a edges
}
```

**Compatibilidad con `RoadGraph` (`src/navigation.ts`):**

- La rama `noded` del constructor hace `new RoadGraph(null, {nodes, edges})` y calcula el
  peso como `Math.hypot(nodes[a] − nodes[b])`. Como aquí **hay un nodo por cada vértice**,
  `hypot` **coincide exactamente** con la longitud del tramo y con `edgeMeta.length`
  (chequeado: `nav: edgeMeta.length == hypot(nodos) — 0 descuadres`). El mismo
  constructor sirve para consumir `roads.json` por la rama `Road[]`.
- **Se adaptó el esquema, no se copió el archivo**: `edgeMeta` es una capa adicional con
  clase y `speedFactor`, que el `RoadGraph` original no tiene porque el motor de referencia
  no sabía qué era una pista.
- **Sin cuantizar `/3`:** el motor de referencia cuantiza a 3 m porque *deriva* los nodos
  de listas de puntos y necesita fusionar coordenadas cercanas. Acá los nodos vienen
  explícitos, con coordenadas OSM exactas (cm), y fusionarlos a 3 m sólo introduciría
  error y podría partir cruces en el límite de una celda. La *estructura* (`{nodes, edges}
  con pares`) es la misma: entra tal cual al constructor. Si el runtime igualmente
  quiere reconstruir desde `roads.json` con cuantización `/3`, los puntos de ambas rutas
  son los mismos, así que obtiene la misma topología.
- Peso sugerido para ruteo rápido: `length / speedFactor` (documentado en
  `navigation.json.meta.dijkstra_hint`).

### `public/roads/stats.json`

Ver §1, §4, §5, §6 y §7: `counts`, `length_km` (clase/kind/tracktype/surface),
`excluded`, `design_tables`, `graph`, `connectivity` (3 variantes + desglose de
inalcanzables), `coverage` (auditoría, borde, snap, cuadrante NE, rejilla 1 km, gap del
bbox viejo), `simplification`.

---

## 9. Qué NO quedó hecho

1. **Nada de runtime.** Cero archivos en `src/`. El drapeo sobre el terreno, la física y
   el uso del grafo en juego son de otro worker.
2. **Sin elevación.** Todo es 2D en el plano `worldX/worldZ`; la cota (Z) sale del DEM
   cuando el runtime drapee. Los tags `layer`, `bridge` y `tunnel` quedan preservados
   para que ese decida cómo tratar los viaductos.
3. **Sólo ways, sin relaciones.** No se consumieron relations de rutas (p. ej. el
   Camino de Santiago como relation); sí están sus ways individuales con `name` y `ref`.
4. **Grafo plano.** Un cruce a distinto nivel sólo queda separado si en OSM no comparten
   node (que es la regla). Los 40 nodos con `layer` distinto son cortes de puente de la
   misma vía (la way `layer=1` tiene `bridge=yes` en los 40) y **sí** deben estar
   conectados; se verificó con `bridge=yes` + nombre compartido.
5. **No se parchearon los huecos de mapeo** (0,144 km de TRACK + un tramo de ROAD de 32 m
   a 8,9 m de la red). Unirlos exigiría una tolerancia de ~40 m, que inventa cruces.
   Quedan listados en `stats.connectivity.unreachable.detail`.
6. **No se validó contra el terreno.** Si el DEM muestra que una pista queda colgada o
   enterrada, eso es materia de la capa de terreno, no de este paquete.
7. **`width`/`speedFactor` no son medida.** 429 de 438 segmentos usan la tabla de diseño.
8. **Snapshot único.** OSM cambia; el manifiesto guarda SHA-256 + timestamp para poder
   detectar qué tan viejos son estos datos (`2026-09-24T22:33:36Z`).
9. **Sin relaciones de acceso condicional** (`access:conditional`) ni valores de acceso
   distintos de `no`/`private`/`agricultural`/`forestry` (ver §4).

---

## 10. Archivos entregados

| Archivo | Qué es |
|---|---|
| `scripts/roads/fetch_osm_roads.py` | Overpass con la ventana exacta, UA explícito, reintentos, manifiesto SHA-256 + URL + timestamp |
| `scripts/roads/build_roads.py` | recorte, clasificación, snap, simplificación protegida, grafo, stats, validaciones |
| `scripts/roads/validate_roads.py` | validación cruzada **independiente** de los 3 JSON (27 cheques) |
| `data/roads/raw/osm_highways_window.json` | respuesta cruda de Overpass (469 ways) |
| `data/roads/raw/osm_highways_window_{manifest.json,query.txt}` | SHA-256, URL, UA, timestamps, consulta exacta |
| `data/roads/raw/osm_highways_audit_buffer001*` | descarga de auditoría con buffer 0,01° (524 ways) |
| `public/roads/roads.json` | **el entregable**: 438 segmentos con clase, ancho, penalización, tags y geometría en coords de mundo (258 KB) |
| `public/roads/navigation.json` | grafo 3 869 nodos / 4 007 aristas + `edgeMeta` (540 KB) |
| `public/roads/stats.json` | km por clase, por tracktype, conectividad, cobertura (19,7 KB) |
| `public/roads/ATTRIBUTION.md` | ODbL de OpenStreetMap: atribución + share-alike |
| `docs/roads/ROADS_FASE3.md` | este documento |
