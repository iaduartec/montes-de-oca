# GEO_PLAN — FASE 1 (GEO): «Montes de Oca: Offroad Stories»

Área jugable: **Villafranca Montes de Oca (Burgos), Castilla y León, España**.
Documento producido el **2026-09-25**. Todos los números son trazables a un
comando ejecutado; cada descarga reporta **URL + código HTTP real + bytes +
SHA-256**. Donde no hubo evidencia se marca `UNKNOWN`.

**Convención de procedencia usada en todo el documento**

| Etiqueta | Significado |
| --- | --- |
| **[MEDIDO]** | Valor calculado localmente a partir de bytes descargados (rasterio/shapely/pyproj). |
| **[DECLARADO]** | Valor que el proveedor publica en su ficha de producto / GetCapabilities / página de licencia. |
| **[TAG OSM]** | Metadato mapeado a mano por colaboradores de OSM. **No es una medición.** |
| **[DERIVADO]** | Aritmética sobre valores medidos o declarados (tiling, bytes, triángulos). |
| **UNKNOWN** | No se verificó. No se rellena con estimaciones. |

---

## 1. Ubicación verificada

### 1.1 La coordenada del packet está mal

| Fuente | Lat | Lon | Verificación |
| --- | --- | --- | --- |
| Packet (afirmación a verificar) | 42.3865 | −3.4140 | — |
| **Overpass `node 492410655`** | **42.3883784** | **−3.3086147** | **[TAG OSM]** HTTP 200, 840 B |
| Overpass `relation 343198` (center) | 42.3890787 | −3.3163919 | **[TAG OSM]** HTTP 200, 1 343 B |
| Nominatim `search` (relation 343198) | 42.3883784 | −3.3086147 | **[TAG OSM]** HTTP 200, 486 B |
| Wikidata `Q959000` P625 | 42.386388888889 | −3.3091666666667 | **[DECLARADO]** HTTP 200, 57 682 B |

**Desvío del punto del packet vs. el pueblo real: 8 677,2 m**
(`data/geo/raw/tiling_projection.json → proyeccion.desvio_packet_vs_real_m`,
calculado en **EPSG:25830** por `scripts/geo/tiling_and_projection.py`).
**[MEDIDO]**

El punto reclamado cae a **2 215,8 m** del hamlet de *San Juan de Ortega*
(`node 490767631`, `place=hamlet`, `ele=1007`, `population=22`), en el municipio
de Juarros — o sea, ~8,7 km al **oeste** de donde está el pueblo real.
**[MEDIDO]**

> **Conclusión:** usar `42.3883784 / −3.3086147` en todo el proyecto.
> La coordenada del packet **no se usa**.

**Comandos**

```bash
# Overpass (UA obligatorio; sin él puede devolver 406)
printf '[out:json][timeout:60];node(492410655);out;\n' > /tmp/q.overpassql
scripts/geo/overpass.sh /tmp/q.overpassql data/geo/raw/osm_village_node.json
# -> HTTP 200  bytes=840  sha256=d0114d5be7300cf2faa7cd32b9dd0e6d9921e6137a5bb5d0dbcdbf70c1c0c4fc

curl -sS -o /tmp/nom.json -w 'HTTP %{http_code} bytes=%{size_download}\n' \
  "https://nominatim.openstreetmap.org/search?q=Villafranca%20Montes%20de%20Oca&format=json&limit=1"
# -> HTTP 200 bytes=486
```

### 1.2 Tags del nodo (lo que OSM afirma, no mide)

`place=village`, `capital=8`, `ele=951`, `population=110` (`population:date=2025`),
`ref:ine=09431000201`, `wikidata=Q959000`, `wikipedia=es:Villafranca Montes de Oca`,
`source=Instituto Geográfico Nacional`, `source:date=2011-06`,
**`source-ele=MDT5`**, `source-name=Nomenclátor Geográfico de Municipios y
Entidades de Población`. **[TAG OSM]**

La relación `343198` es `boundary=administrative`, `admin_level=8`,
`ine:municipio=09431`, `population=117`, `source=BDLL25, EGRN, Instituto
Geográfico Nacional`. **[TAG OSM]**

### 1.3 Contexto geográfico real (todo recalculado hoy)

Método: **[MEDIDO]** distancia mínima punto→segmento en **EPSG:25830**
(`pyproj.Transformer` + aritmética punto-segmento). Script:
`scripts/geo/verify_context.py` → `data/geo/raw/geo_verification.json`
(SHA-256 `3c84339fdeedb231837ac633c4e3579eaf202d4fd35470b380792e9c8a4927f3`).

| Hecho | Valor | Procedencia |
| --- | --- | --- |
| **N-120** pasa a | **8,5 m** del nodo del pueblo (way `34075414`, `highway=trunk`, `name=Calle Mayor`, `maxspeed=50`, `lanes=2`, `surface=asphalt`) | **[MEDIDO]** + **[TAG OSM]** |
| A-12 tramo `proposed` más cercano | **592,25 m** (way `306374282`, «Autovía del Camino de Santiago», 8 ways) | **[MEDIDO]** |
| A-12 `construction` más cercana | **16,375 km** (way `764020347`, 13 ways) | **[MEDIDO]** |
| A-12 `motorway_link` más cercano | **29,190 km** (way `188536200`) | **[MEDIDO]** |
| A-12 **construida** más cercana | **29,453 km** (way `686254670`, 10 ways) | **[MEDIDO]** |
| **Camino Francés** pasa a | **66,6 m** del nodo del pueblo (way `741760074`, «La Plaza») | **[MEDIDO]** |
| Ways del Camino Francés con vértice dentro del bbox | **22** de 523 | **[MEDIDO]** |
| Otra relación Camino cercana | `21016892` «Camino de Santiago Vasco del Interior (Armiñón-Burgos)», centro a **17,31 km** | **[TAG OSM]** |

**Dos correcciones al packet:**

1. **El packet acierta con el Camino Francés.** Mi búsqueda previa con radio de
   6 km y límite de 200 elementos no lo encontró; la consulta correcta
   (`rel(2163558); way(r); out geom`) confirma que la relación
   **«Camino Francés - 03 Logroño a Burgos»** pasa a **66,6 m** del pueblo y
   mete **22 ways dentro del bbox**. Prueba guardada en
   `data/geo/raw/osm_camino_frances_rel2163558_ways.json`
   (529 115 B, SHA-256 `fead100d…`).
   *Resultado negativo complementario:* `way(around:15000,…)["network"~"Camino"]`
   devuelve **0 elementos** (`osm_camino_network_ways_15km.json`, 287 B) → el
   tag `network` sólo vive en las relaciones, no sirve como filtro espacial.
2. **La A-12 NO está cerca.** Sólo hay un tramo `proposed` a **592 m**; el
   tramo en obra (`construction`) está a **16,4 km** y el tramo ya construido a
   **29,5 km**.

### 1.4 Cumbres dentro del bbox **[TAG OSM en `ele`, distancia MEDIDA]**

| OSM id | Nombre | `ele` (m) | Dist. al pueblo (m) |
| --- | --- | --- | --- |
| 1888844387 | Peñalta | 1096 | 2 341,2 |
| 13096825594 | Somoro | 1112 | 2 696,8 |
| 3306174952 | Valbuena | 1168 | 2 874,2 |
| 6221861345 | Castillo de Alba | 1083 | 2 968,2 |
| 6221864769 | Somoro | 1109 | 3 013,5 |

El packet decía «elevación aproximada 800–1100 m». **El MDT02 mide
891,19–1 196,29 m dentro del bbox** (§4.4): la banda alta se queda corta.

### 1.5 Cobertura del suelo en el bbox **[MEDIDO sobre geometrías OSM]**

Recortado al rectángulo del bbox con shapely en EPSG:25830
(`verify_context.py`), área de bbox = **3 595,13 ha**:

| Clase OSM | ways | ha | % del bbox |
| --- | --- | --- | --- |
| `landuse=farmland` | 65 | 76,02 | 2,11 % |
| `landuse=forest` | 4 | 10,91 | 0,30 % |
| `natural=wood` (+ ways miembro sin tag) | 3 + 44 | 27,79 | 0,77 % |
| **Unión bosque (forest ∪ wood)** | — | **38,17** | **1,06 %** |
| `landuse=meadow` | 1 | 3,87 | 0,11 % |

**Advertencia importante:** OSM etiqueta sólo el **1,06 %** del bbox como bosque
y el **2,11 %** como cultivo. Esto **no** significa que el terreno sea pelado —
significa que OSM infraestima la cobertura vegetal en esta zona. **Para la
máscara de bosque del juego hay que usar CORINE Land Cover o ESA WorldCover,
no OSM.** OSM sirve para pistas y etiquetas, no para vegetación.

> Nota metodológica: `relation[natural=wood]` devuelve `bounds` pero **no**
> miembros con `out geom`; hay que encadenar `rel(…); way(r); out geom`.
> Queda anotado porque costó descubrirlo.

---

## 2. Bounding box propuesto

```
42.350651, -3.350784, 42.404549, -3.277816      (S, W, N, E)   WGS84
```

| Métrica | Valor | Procedencia |
| --- | --- | --- |
| Ancho (SO→SE) | **6 009,80 m** | **[MEDIDO]** `tiling_projection.json` |
| Alto (SO→NO) | **5 984,69 m** | **[MEDIDO]** |
| Área | **3 595,13 ha** | **[MEDIDO]** `geo_verification.json` |
| Esquinas en EPSG:25830 | SO `471108.924 / 4688769.377` · SE `477118.679 / 4688747.168` · NE `477138.238 / 4694731.803` · NO `471133.621 / 4694754.016` | **[MEDIDO]** |
| Centro del bbox (EPSG:25830) | **474 124,866 / 4 691 750,591** | **[DERIVADO]** |
| Pueblo respecto al centro | **1 284,5 m** al NE | **[DERIVADO]** |

**Justificación geográfica**

- El bbox **incluye el pueblo** (42.3884 / −3.3086) y la **N-120** que lo cruza.
- Incluye la **cresta de Montes de Oca** con Peñalta, Somoro, Valbuena y
  Castillo de Alba a 2,3–3,0 km del pueblo → relieve real con 300 m de rango.
- Incluye **22 ways del Camino Francés** (§1.3) → el «peregrino» es contenido jugable real.
- **No** incluye la A-12 construida (29,4 km) → el paisaje rural se sostiene.

**Rango hipométrico real dentro del bbox (MDT02, 2 m) [MEDIDO]**

```
min 891.19   p05 939.5   media 1065.94   p50 1074.7   p95 1170.5   max 1196.29   std 69.24
```

---

## 3. Red viaria OSM

### 3.1 Consulta y evidencia

```
POST https://overpass-api.de/api/interpreter      (User-Agent: MontesDeOcaOffroad-GeoBot/1.0)
Q:   way["highway"](42.350651,-3.350784,42.404549,-3.277816);  out tags geom;
```

| | |
| --- | --- |
| Archivo | `data/geo/raw/osm_highways_bbox.geojson.json` |
| HTTP | **200** |
| Bytes | **466 800** |
| SHA-256 | `25854c3cfa0787a44ef8e44702e6c023e0ccf64afee06e062b5d0ded55e2fe2d` |
| `timestamp_osm_base` | **2026-09-24T21:54:51Z** |
| Generator | Overpass API 0.7.62.11 |

Extractor de estadísticas: `scripts/geo/osm_highways_stats.py` →
`data/geo/raw/osm_highways_stats.json` (2 396 B, SHA-256 `f21ca72f…`).
**Las longitudes están recortadas al bbox** con `shapely.intersection`: Overpass
devuelve la geometría completa de una way si ésta *toca* el bbox, así que sin
recorte las cifras se inflan (p.ej. la A-12 `proposed`).

### 3.2 Totales

| | Valor | Procedencia |
| --- | --- | --- |
| Ways `highway=*` | **395** | **[DERIVADO]** |
| Longitud total recortada | **150,355 km** | **[DERIVADO]** |
| — de la cual `highway=proposed` (A-12 fantasma) | **15,730 km** | **[DERIVADO]** |
| **Longitud de vía existente** | **134,625 km** | **[DERIVADO]** |
| Ways sin `name` | **302** (76,5 %) | **[DERIVADO]** |

### 3.3 Por familia pedida en el packet **[TAG OSM]**

| Familia | ways | km |
| --- | ---: | ---: |
| `primary` | 0 | 0,000 |
| `secondary` | 0 | 0,000 |
| `tertiary` | 6 | 4,241 |
| `unclassified` | 2 | 1,113 |
| `residential` | 48 | 3,076 |
| `service` | 20 | 3,118 |
| **`track`** | **191** | **87,373** |
| `path` | 76 | 26,210 |
| `footway` | 7 | 0,341 |
| `bridleway` | 0 | 0,000 |

### 3.4 Subclases adicionales presentes en el bbox **[TAG OSM]**

| Subclase | ways | km |
| --- | ---: | ---: |
| `path` | 76 | 26,210 |
| `track/grade4` | 43 | 24,399 |
| `track/grade2` | 33 | 23,190 |
| `track/sin-tracktype` | 64 | 18,366 |
| **`proposed`** | **3** | **15,730** |
| `track/grade5` | 29 | 15,632 |
| `trunk` | 24 | 8,209 |
| `track/grade3` | 15 | 4,524 |
| `tertiary` | 6 | 4,241 |
| `service` | 20 | 3,118 |
| `residential` | 48 | 3,076 |
| `track/grade1` | 7 | 1,262 |
| `unclassified` | 2 | 1,113 |
| `pedestrian` | 8 | 0,544 |
| `footway` | 7 | 0,341 |
| `living_street` | 7 | 0,302 |
| `steps` | 3 | 0,097 |

> ⚠️ **Hallazgo crítico para el diseño:** dentro del bbox hay **15,730 km de
> `highway=proposed`** en 3 ways, **las tres de la A-12**
> (`306374282` 7,869 km · `306571752` 6,185 km · `764020359` 1,676 km).
> Es una autovía **que no existe en el terreno**. Si se drena la red cruda al
> juego aparece un fantasma de 15,7 km cruzando el área jugable.
> **Excluir `highway=proposed` (y `construction`) del grafo jugable.**
> **[MEDIDO]**

### 3.5 `tracktype` (subclases de `track`) **[TAG OSM]**

| `tracktype` | ways |
| --- | ---: |
| `grade1` | 7 |
| `grade2` | 33 |
| `grade3` | 15 |
| `grade4` | 43 |
| `grade5` | 29 |
| *sin `tracktype`* | 64 |

87,4 km de pistas en 191 ways es el **contenido principal** de un juego
off-road. Pero **64 ways (18,4 km) no tienen `tracktype`** → hay que inferir
tracción con criterios propios (ancho, sinuosidad, pendiente del DEM) y
declararlo como inferencia, nunca como dato OSM.

### 3.6 Cobertura de tags **[TAG OSM]**

| Tag | ways con tag | % de 395 |
| --- | ---: | ---: |
| `surface` | 82 | 20,8 % |
| `access` | 14 | 3,5 % |
| `smoothness` | 9 | 2,3 % |
| `motor_vehicle`/`motorcar` | 1 | 0,3 % |

Valores de `access`: `private` 12 · `no` 1 · `yes` 1.

> **Lectura honesta:** el **79,2 % de las vías no tiene `surface`** y el
> **96,5 % no tiene `access`**. No se puede derivar «cómo se conduce» de los
> tags. La física de conducción tendrá que salir del DEM (pendiente), del
> `tracktype` donde exista, y de una capa propia — todo ello declarado como
> **inferencia**, no como dato OSM.

---

## 4. Fuentes DEM

### 4.1 WCS de IGN (`servicios.idee.es`) — descartado como fuente de 2 m

| | |
| --- | --- |
| URL | `https://servicios.idee.es/wcs-inspire/mdt?SERVICE=WCS&VERSION=2.0.1&REQUEST=GetCapabilities` |
| HTTP | **200** |
| Bytes | **12 162** |
| SHA-256 | `30c95575991611cd15924369d2a3ad5066aa9a81ff68f8e549c71bdc6c638d3f` |
| Archivo | `data/geo/raw/ign_mdt_getcapabilities.xml` |

**[DECLARADO]** del XML:

- `ows:Title` = «Modelos Digitales del Terreno de España», `ServiceTypeVersion` = **2.0.1**
- **17 `CoverageId`** (`grep -o "Elevacion[0-9]*_[0-9]*" | sort -u`):

  ```
  Elevacion{4258,4083,25830}_{1000,500,200,25,5}   (15)
  Elevacion4326_{1000,500}                          ( 2)
  ```

- **No existe ninguna cobertura de 2 m.** Resoluciones disponibles:
  **1000 / 500 / 200 / 25 / 5 m**.
- `crs:crsSupported` (8): `EPSG 25828, 25829, 25830, 25831, 4258, 3857, 4326, 4083`
- `wcs:formatSupported` (10): `image/tiff, ArcGrid, application/asc, image/png,
  image/jpeg, image/gif, image/png; mode=8bit (×2), GEOTIFFINT16, GEOTIFF_RGB`
- `ows:Fees` = **«No se aplican condiciones»**
- `ows:AccessConstraints` = **«CC BY 4.0 scne.es»**

**DescribeCoverage de `Elevacion25830_5`**
(`ign_describe_Elevacion25830_5.xml`, 2 536 B, SHA-256 `da3b2638…`):

- `gml:Envelope srsName=…/EPSG/0/25830` **`axisLabels="x y"`**, `uomLabels="m m"`
- `lowerCorner −19452.5 3901197.5` → `upperCorner 1140352.5 4865682.5`
- `RectifiedGrid` `gml:high 231960 192896`, `offsetVector 5.000000 0` y `0 −5.000000`
- `gmlcov:rangeType` → `swe:uom code="W.m-2.Sr-1"`
- `wcs:nativeFormat` = **`COG`**

> **Dos trampas que ya mordieron y hay que documentar:**
> 1. Los ejes del subset son **`x` e `y`**, no `Easting`/`Northing`. Usar
>    `SUBSET=Easting(...)` devuelve **`InvalidAxisLabel` / HTTP 404**.
> 2. El `rangeType` declara `W.m-2.Sr-1` (unidades de radiación). Es
>    **metadato defectuoso** del servicio: los datos son cotas en metros.

**GetCoverage exitoso (reproducido hoy, byte-idéntico)**

```
https://servicios.idee.es/wcs-inspire/mdt?SERVICE=WCS&VERSION=2.0.1
  &REQUEST=GetCoverage&COVERAGEID=Elevacion25830_5
  &SUBSET=x(474000,475000)&SUBSET=y(4692500,4693500)&FORMAT=image/tiff
-> HTTP 200  Content-Type: image/tiff  bytes=80536
-> SHA-256 ea12565fd04bd89d606b98659a2d62b1c2a02cecffe308dcc16bda71cec3c42f
   (idéntico al archivo data/geo/raw/mdt05_sample_1km.tif ya archivado)
```

**Veredicto:** funciona, sin auth, licencia clara — pero **máximo 5 m**. Sirve
como *fallback* y como control de calidad, no como DEM principal.

### 4.2 CNIG / IGN **MDT02 (2 m)** — **DEM ELEGIDO**

**Ficha de producto [DECLARADO]**
(`https://centrodedescargas.cnig.es/…`, HTML archivado):

> «Modelo digital del terreno **2ª Cobertura (2015-2021)** con paso de malla de
> **2 metros**. Se ha obtenido por **interpolación a partir de la clase terreno
> de los vuelos LIDAR de la segunda cobertura del Plan Nacional de
> Ortofotografía Aérea (PNOA)** […]. Sistema de Referencia Geodésico:
> **ETRS89 y WGS84**. ETRS89 en la península, Illes Balears, Ceuta y Melilla, y
> REGCAN95 en Canarias. Proyección UTM en el huso correspondiente. […]
> **Alturas ortométricas.** Unidad de descarga: **Hojas del MTN25**. Formato:
> **COG (Cloud Optimized GeoTIFF)**.»

**`datum` vertical / geoide concreto: `UNKNOWN`.** La ficha dice «alturas
ortométricas» pero **no nombra el geoide** (REGENTE/EGM2008/etc.). No se rellena.

**Flujo de descarga — HTTP real, SIN autenticación ni registro**

| Paso | Request | Resultado observado |
| --- | --- | --- |
| 1 | `POST https://centrodedescargas.cnig.es/CentroDescargas/archivosSerie` con `codAgr=MOMDT&codSerie=MDT02&coordenadas={"type":"FeatureCollection",…lon/lat…}` | 2 ficheros en el catálogo: **107,79 MiB** ETRS89-HU30 (= **113 031 094 B**, el que descargamos) y **127,38 MiB** WGS84, escala 2 m, fecha 2019 |
| 2 | `POST /CentroDescargas/checkFile` | `{"msj":"OK","secuencial":11587251,…}` |
| 3 | `POST /CentroDescargas/initDescargaDir` con `muestraLic:"NO"` | `{"muestraLic":"NO","nuevaVentana":"N","secuencialDescDir":"11587251","textLicForm":null}` |
| 4 | `POST /CentroDescargas/descargaDir` con `secDescDirLA=11587251` | **HTTP/1.1 200**, `Content-Type: image/tiff`, `Content-Disposition: attachment; filename=MDT02-ETRS89-HU30-0201-4-COB2.tif`, `Content-Language: es-ES` |

**Hoja descargada**

| | |
| --- | --- |
| Archivo temporal | `/tmp/opencode/MDT02-ETRS89-HU30-0201-4-COB2.tif` |
| Bytes | **113 031 094** (107,8 MB) — *descarga reportada, < 200 MB* |
| SHA-256 | `7ca1d9f5ecd28e3fa44398c10c24f3e5eb3e2320db162befa350f4c99f6b782c` |
| Geometría **[MEDIDO]** | 6 929 × 4 701, `EPSG:25830`, res `(2.0, 2.0)`, `float32`, `nodata=-32767` |
| Bounds | `470767.0 / 4686751.0 / 484625.0 / 4696153.0` |

**El bbox jugable (471109–477139 / 4688771–4694733) cae entero dentro de la
hoja** → sin mosaico, sin huecos. **[MEDIDO]**

**Recorte al bbox — verificado píxel a píxel**

```bash
./.venv/bin/python scripts/geo/crop_mdt02.py \
  /tmp/opencode/MDT02-ETRS89-HU30-0201-4-COB2.tif \
  data/geo/raw/mdt02_bbox_2m.tif
# ventana     : col_off=171.0 row_off=710.0 w=3015.0 h=2981.0
# verificacion: pixeles identicos a la ventana de la hoja = True
```

| | |
| --- | --- |
| Archivo | `data/geo/raw/mdt02_bbox_2m.tif` |
| Bytes | **28 033 650** |
| SHA-256 | `104f4883680ac8ac2365549c6d31ba852e8dfa97bfa98dff6cd73569a45e01f5` |
| **[MEDIDO]** | 3 015 × 2 981, `float32`, `EPSG:25830`, res **2,0 m**, `nodata=-32767`, bounds `471109 / 4688771 / 477139 / 4694733` |
| **[MEDIDO]** | min **891,19** · max **1 196,29** · media **1 065,94** · std **69,24** m |

### 4.3 Copernicus GLO-30 — descargado como fallback

| | |
| --- | --- |
| URL | `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N42_00_W004_00_DEM/Copernicus_DSM_COG_10_N42_00_W004_00_DEM.tif` |
| HTTP (HEAD, reproducido hoy) | **200 OK**, `Last-Modified: Mon, 09 May 2022 14:23:06 GMT`, `ETag "99554a64e8426bdd3bd796387d251b97"` |
| Bytes | **41 147 905** |
| SHA-256 | `71748b2709a207bd9b3cb8a0bec963ad0b2cd7ecd9ce0f08ee99ff8169464b79` |
| **[MEDIDO]** | 3 600 × 3 600, `float32`, `EPSG:4326`, res 1″ (0,000277778°), bounds `-4.0 / 42.0 / -3.0 / 43.0`, sin `nodata` declarado |
| Rango sobre el bbox | 891,06 – 1 206,93 m |

**[DECLARADO]** — registro AWS (`registry.opendata.aws/copernicus-dem/`):
*«The Copernicus DEM is a **Digital Surface Model (DSM)** which represents the
surface of the Earth including buildings, infrastructure and vegetation.»*
→ **es DSM, no DTM**: incluye copa de árbol y tejados. Para un terreno
conducible hay que corregirlo.

Licencia: *«available on a free basis for the general public under the terms
and conditions of the Licence»* — el texto completo de la licencia **no se
verificó en esta fase (`UNKNOWN`)**; la atribución exigida se cita en §9
tomada de `data/ATTRIBUTION.md` del repo de referencia.

### 4.4 Comparación medida entre los tres DEM

`scripts/geo/compare_dems.py` → `data/geo/raw/dem_comparison.json`
(1 408 B, SHA-256 `a1f3f963f803e9dc252bd266eafdf233e2b178bb9f3f197860c70e01acf5b153`).
**[MEDIDO]**, todo sobre la grilla de 2 m del MDT02 (8 987 715 px):

| Comparación | bias | RMSE | p50 \|err\| | p95 \|err\| | max \|err\| |
| --- | ---: | ---: | ---: | ---: | ---: |
| MDT02 vs **MDT05** (reinterp. a 2 m) | −0,400 m | **0,835 m** | 0,410 | 1,430 | 28,182 |
| MDT02 vs **Copernicus** (reinterp. a 2 m) | **−4,989 m** | **6,799 m** | 5,088 | 12,121 | 36,158 |
| Media 30 m de MDT02 vs Copernicus nativo | −4,923 m | 6,937 m | — | — | 28,523 |

**Relieve que una grilla de 30 m NO puede representar**
(desvío estándar de las 225 muestras de 2 m dentro de cada celda de 30 m,
39 798 celdas): **media 1,76 m · p95 3,918 m · máx 20,441 m**
(máx 3,37 m en celdas de relieve ya alto).

### 4.5 Decisión

| | MDT02 (2 m) | MDT05 (5 m) | Copernicus GLO-30 (30 m) |
| --- | --- | --- | --- |
| Tipo | **DTM (clase terreno LiDAR)** | DTM | **DSM** |
| Resolución | **2 m** | 5 m | 30 m |
| CRS nativo | **EPSG:25830** | EPSG:25830 | EPSG:4326 |
| Auth | **No** (flujo POST directo) | No (WCS) | No (S3 público) |
| Licencia | CC BY 4.0 (Orden FOM/2807/2015) | CC BY 4.0 scne.es | `UNKNOWN` (texto completo no verificado) |
| Cubre el bbox | **Sí, entero** | Sí | Sí |
| RMSE vs MDT02 | — | 0,835 m | **6,799 m** |

**→ Elegido: MDT02 IGN/CNIG 2 m.** Es el único de los tres que es terreno
desnudo a resolución métrica, ya viene en `EPSG:25830` (cero reproyección) y
se descargó sin auth con evidencia HTTP completa.

---

## 5. Proyección y origen local

**[MEDIDO / DERIVADO]** — `scripts/geo/tiling_and_projection.py` →
`data/geo/raw/tiling_projection.json` (10 063 B, SHA-256 `e900f6ac…`).

### 5.1 Recomendación

| Parámetro | Valor |
| --- | --- |
| **CRS de juego** | **`EPSG:25830`** (ETRS89 / UTM zona 30N) |
| Unidades del CRS | `metre` |
| **Origen** | **E 474 123 / N 4 691 751** (vértice de celda del MDT02) |
| **Escala** | **1,0** (1 m real = 1 unidad de juego) |
| Fórmula | `x = E − 474123` · `z = −(N − 4691751)` (Babylon: +z hacia el sur) |

**Por qué `EPSG:25830`**

1. El MDT02 y el MDT05 **ya vienen en `EPSG:25830`** → cero reproyección en el
   pipeline de terreno, cero resampling, cero pérdida.
2. El huso 30N (meridiano −3°) tiene su centro a **0,309°** del pueblo: estamos
   casi sobre el meridiano central → distorsión mínima.
3. Los conteos OSM, las distancias y las áreas ya se calcularon en ese CRS.

**Por qué escala 1,0 y no 0,6**

El repo de referencia usa `metros × 0.60` porque autentica assets de Shenzhen a
escala de juego. Acá **no hay assets previos que respetar**, y escala 1,0
simplifica todo: el DEM en metros entra tal cual, `heightAt()` devuelve metros,
y la física de suspensión trabaja en unidades conocidas. Cambiar la escala más
adelante es un `multiply` global; empezar con 0,6 es un costo innecesario hoy.

**Por qué origen en el centro del bbox y no en el pueblo**

El pueblo está **1 284,5 m** del centro. Con origen en el centro, las 12×12
tiles quedan simétricas y el mundo cubre ±3 072 m en cada eje. Con origen en
el pueblo habría que desplazar la grilla y romper la simetría del streaming.

**Alineación de la grilla (detalle que ahorra dolores de cabeza)**

El raster tiene bounds `471109 … 477139` con celdas de 2 m → los vértices de
caja están en coordenadas **impares**. El centro exacto del raster es
`(474124, 4691752)`, que **cae en el centro de una celda, no en un vértice**.
Propongo el vértice de celda más cercano:

```
E 474123  (474123 − 471109 = 3014, par  ✓)
N 4691751 (4691751 − 4688771 = 2980, par  ✓)
```

Está a **1,91 m** del centro real del bbox y garantiza que cada límite de tile
(±512 k) caiga exactamente sobre un vértice del DEM. **[DERIVADO]**

### 5.2 Comparación con la convención del repo de referencia

| | Repo de referencia (Shenzhen) | Este proyecto |
| --- | --- | --- |
| Fórmula | `east=(lon−114.025)*102850*0.60` · `north=(lat−22.536)*111320*0.60` | `x=E−474123` · `z=−(N−4691751)` |
| CRS implícito | equirectangular local (sin CRS oficial) | **`EPSG:25830`** |
| Factor lon | 102 850 m/° (lat 22,536) | **82 234,2 m/°** (lat 42,3776) |
| Factor lat | 111 320 m/° | 111 320 m/° |
| Escala | 0,60 | **1,0** |

**Qué hay que cambiar para España:**

- **El factor lon NO se puede reutilizar.** 102 850 vs 82 234,2 → **+20,04 % de
  error**. Reusarlo deformaría el mundo un 20 % en X. **[DERIVADO]**
- **Error del equirectangular local vs UTM en las esquinas del bbox:**
  `24,961 / 7,004 / 22,367 / 9,886 m` → **máx 24,961 m**. Es aceptable para un
  mundo de 6 km, pero como el DEM ya viene en UTM, **no hay razón para
  aceptar ese error**: se usa `EPSG:25830` y listo. **[MEDIDO]**
- El repo de referencia advierte explícitamente en
  `scripts/landmark_tasks.py:89` que *«la referencia UTM vieja no se puede
  mezclar en las coordenadas actuales del juego»* — es la misma lección.

### 5.3 Sobre `EPSG:32649` (la investigación temprana)

`EPSG:32649` = WGS 84 / UTM zona **49N** (meridiano **111° E**), diseñado para
el sudeste asiático. Proyectando el pueblo de Burgos:

```
E −4 711 544,413   N 12 700 050,513
area_of_use = 108.0, 0.0, 114.0, 84.0
distancia al centro de huso = 114,309°
```

Coordenadas **negativas** en Easting y el punto a **114,3°** del meridiano
central → la proyección es matemáticamente válida pero **geográficamente
absurda**: la distorsión sería enorme. **Esta fue una confusión heredada del
repo de referencia (Shenzhen cae en el huso 49).** Para Burgos usar
`EPSG:25830`. **[MEDIDO]**

---

## 6. Tiling de terreno

**[DERIVADO]** — `scripts/geo/tiling_and_projection.py` →
`data/geo/raw/tiling_projection.json → tiling`.

### 6.1 Geometría de la grilla

| Eje | Declarado 6 000 m | Alineado a 6 144 m |
| --- | --- | --- |
| **512 m** | 12/lado, última tile **368 m** (parcial) → cobertura 6 144 m | **12/lado, todas de 512 m** |
| **1024 m** | 6/lado, última tile **880 m** (parcial) → cobertura 6 144 m | **6/lado, todas de 1 024 m** |

6 144 = 12 × 512 = 6 × 1024. **Recomendación: declarar el mundo como
6 144 × 6 144 m** y descartar las tiles parciales. Con el origen propuesto
(§5.1), esa ventana es `471051 … 477195` / `4688679 … 4694823`, **enteramente
dentro de la hoja MDT02 descargada** (`470767 … 484625` / `4686751 … 4696153`)
→ se puede re-recortar sin pedir nada nuevo. **[MEDIDO]**

### 6.2 Opciones, con densidad declarada

Densidades con **celdas enteras** por lado (las únicas que alinean malla y DEM):

| Tile | Densidad | Celdas/lado | Vértices | Triángulos | `u16` cabe | Malla/tile | Tiles totales (6 144 m) | Triángulos totales | MiB totales |
| ---: | ---: | ---: | ---: | ---: | :---: | ---: | ---: | ---: | ---: |
| 512 | 2 m | 256 | 66 049 | 131 072 | **NO** | 1 837 060 B | 144 | 18 874 368 | 252,28 |
| 512 | **4 m** | 128 | **16 641** | 32 768 | **sí** | 263 172 B | 144 | 4 718 592 | 36,14 |
| 512 | **8 m** | 64 | **4 225** | 8 192 | **sí** | 66 052 B | 144 | 1 179 648 | 9,07 |
| 1024 | 4 m | 256 | 66 049 | 131 072 | **NO** | 1 837 060 B | 36 | 4 718 592 | 63,07* |
| 1024 | 8 m | 128 | 16 641 | 32 768 | sí | 263 172 B | 36 | 1 179 648 | 9,04 |

\* *El JSON del script reporta 63,07 MiB para `1024@4m` porque cuenta los
índices como `u32` (correcto: 66 049 vértices no caben en `u16`). La celda de
esta tabla refleja eso.*

Bytes = `vértices × 4` (alturas `float32`) + `triángulos × 3 × 2|4` (índices
`u16`/`u32`). No incluye normales ni textura de alturas (`(celdas+1)²` px).

### 6.3 En pantalla (streaming radio-dependiente)

Fórmula: `tiles_en_vista = (⌈2·r / tile⌉ + 1)²`

| Tile | Densidad | r = 1 000 m | r = 1 500 m | r = 2 000 m |
| --- | ---: | --- | --- | --- |
| 512 | 4 m | 25 tiles · **819 200 tri** · 6,27 MiB | 49 tiles · 1 605 632 tri · 12,30 MiB | 81 tiles · 2 654 208 tri · 20,33 MiB |
| 512 | 8 m | 25 tiles · **204 800 tri** · 1,57 MiB | 49 tiles · 401 408 tri · 3,09 MiB | 81 tiles · 663 552 tri · 5,10 MiB |
| 1024 | 4 m | 9 tiles · 1 179 648 tri | 16 tiles · 2 097 152 tri | 25 tiles · 3 276 800 tri |
| 1024 | 8 m | 9 tiles · 294 912 tri | 16 tiles · 524 288 tri | 25 tiles · 819 200 tri |

### 6.4 Mapeo sobre la arquitectura de streaming existente

Presupuestos verificados **leyendo el código del repo de referencia (READ-ONLY)**:

| Presupuesto | Valor | Fuente exacta |
| --- | --- | --- |
| `ground-relief` triángulos totales | **≤ 200 000** | `src/city-ground-relief.ts:74` (`manifest.budgets.triangles>200000`) |
| `ground-relief` tiles | **≤ 100** | `src/city-ground-relief.ts:74` (`manifest.tiles.length>100`) |
| `mountains` triángulos totales | **≤ 260 000** | `src/city-mountains.ts:20` y `scripts/prepare_city_mountains.py:80` (`assert triangles<260000`) |
| `mountains` tiles | **≤ 180** | `src/city-mountains.ts:20` |
| Grilla de bloques | **640 unidades de juego** (= 1 066,7 m reales a escala 0,6) | `src/city-world.ts:253` |
| Radios de culling | 700 (detalle) / 2 500 (carreteras) / 3 300 (bloques) **unidades de juego** | `src/city-world.ts:435` |
| Chunk de `ground-relief` | **1 280 unidades** (= 2 133,3 m reales) | `scripts/prepare_city_ground_relief.py:123` |
| Única capa de streaming | `CityFacadeStream`: carga a **700**, visible a **700**, evict a **1 500** | `src/city-facade-stream.ts:10, 21, 33` |

**Análisis honesto de esos números:**

- `512@8m` con radio 1 000 m → **204 800 triángulos**, prácticamente el
  presupuesto de 200 000 del `ground-relief`. **Encaja.**
- `512@4m` con radio 1 000 m → **819 200 triángulos = 4,1×** ese presupuesto.
- El presupuesto de 200 000 es **global** (`budgets.triangles` del manifest), no
  por vista. Para que 144 tiles entren en 200 000 haría falta una densidad de
  **19,43 m** → demasiado grueso. **`ground-relief` NO es un presupuesto
  reutilizable para un mundo de 6 × 6 km**: se calculó para el parque de
  Shenzhen, un área mucho menor.
- Con el patrón `evict a 1 500` de `CityFacadeStream` y tiles de 512 m →
  **49 tiles residentes** como máximo → **401 408 tri / 3,09 MiB @ 8 m**,
  **1 605 632 tri / 12,30 MiB @ 4 m**.

### 6.5 Recomendación (con números)

> **Tiles de 512 m, grilla alineada de 6 144 m (12 × 12 = 144 tiles),
> origen E 474123 / N 4691751, escala 1,0 en `EPSG:25830`.**
>
> - **Capa base a 8 m** → 4 225 vértices (índices `u16` ✓), 8 192 tri/tile,
>   66 052 B/tile, **144 tiles = 1 179 648 tri = 9,07 MiB**;
>   **204 800 tri en vista a 1 000 m** (≈ el presupuesto existente),
>   **401 408 tri residentes** con evict a 1 500 m.
> - **LOD cercano a 4 m** para los anillos ≤ 1 000 m → 16 641 vértices
>   (`u16` ✓), 32 768 tri/tile. El presupuesto de triángulos hay que
>   **subirlo y redefinirlo**: no sirve copiar los 200 000 del repo de
>   referencia.
> - **Descartar 2 m** (66 049 vértices → índices `u32`, 252 MiB) y
>   **descartar 1024 m**: gana en draw calls (36 vs 144) pero **pierde en
>   granularidad de streaming** — la unidad mínima de detalle que se puede
>   promover/demover es de 1 024 m en vez de 512 m, y con el mismo radio de
>   vista se cargan *más* triángulos (294 912 vs 204 800 a 8 m en r = 1 000 m).

**Tradeoffs explícitos de la decisión**

| Opción | A favor | En contra |
| --- | --- | --- |
| 512 @ 8 m (recomendado) | cabe en `u16`, 9 MiB totales, streaming granular, ~presupuesto actual en vista | 8 m es 4× la resolución del DEM → se pierde detalle de pista |
| 512 @ 4 m | 4× más detalle, aún en `u16` | 4,1× el presupuesto de triángulos actual; 36 MiB; 12,3 MiB residentes |
| 512 @ 2 m | resolución nativa del DEM | **`u16` NO cabe** (66 049 > 65 536) → `u32`, 252 MiB, 18,8 M tri |
| 1024 @ 8 m | 36 draw calls | peor granularidad de streaming, más tri en vista al mismo radio |
| 1024 @ 4 m | pocas tiles | `u16` **NO cabe**, 63 MiB |

---

## 7. Advertencia de resolución vertical

> **Interpolar NO crea resolución.** Reproyectar un DEM de 30 m a una grilla de
> 2 m produce 225 píxeles por celda original **todos derivados de la misma
> información**. Sólo permite *medir* cuánto detalle de 2 m no puede contener la
> fuente gruesa; no lo hace aparecer.

Evidencia medida en este proyecto (`dem_comparison.json`, §4.4):

| Cadena | RMSE vs MDT02 | Lo que significa |
| --- | ---: | --- |
| MDT05 (5 m) → 2 m | **0,835 m** | Dos DTM del IGN con distinta resolución coinciden sub-métrico |
| Copernicus (30 m) → 2 m | **6,799 m** | Sesgo sistemático de **−4,99 m** + p95 de 12,1 m |

Y lo que una celda de 30 m **no puede representar** aunque la interpolemos:
desvío estándar de las 225 muestras de 2 m dentro de cada celda de 30 m
(39 798 celdas) → **media 1,76 m · p95 3,918 m · máx 20,441 m**.

**Reglas para el equipo:**

1. **MDT02 (2 m)** = terreno desnudo, DTM LiDAR → base de `heightAt()` y de la
   física. **No decimar por debajo de 4 m sin aceptar perder pistas.**
2. **MDT05 (5 m)** = control de calidad / fallback, nunca la fuente primaria.
3. **Copernicus GLO-30 (30 m)** = **DSM**, incluye vegetación y edificios.
   Nunca usarlo como suelo conducible sin corrección.
4. Cualquier grilla remuestreada (2 m → 4 m → 8 m → LOD) se etiqueta
   **«remuestreo de MDT02»**, jamás «resolución 4 m/8 m».
5. `ele` de OSM (`source-ele=MDT5` en el nodo del pueblo) es **dato mapeado**,
   no medido. Se usa para validar, no como fuente.

---

## 8. Entorno Python

### 8.1 Comandos exactos ejecutados

```bash
cd /home/kiri_/projects/montes-de-oca-offroad
python3 -m venv .venv                       # -> venv rc=0
./.venv/bin/python -m pip install -U pip     # -> pip-upgrade rc=0
./.venv/bin/python -m pip install \
    -r /home/kiri_/projects/montes-de-oca/requirements.lock.txt
                                             # -> install rc=0
```

`python3 -V` → **Python 3.12.3**. Log completo: `/tmp/opencode/venv.log`.

### 8.2 Resultado real de `pip install` (cola de la salida)

```
Installing collected packages: urllib3, tqdm, six, pyparsing, pyfiglet, pyarrow,
pillow, packaging, orjson, numpy, kiwisolver, idna, fonttools, cycler, colorama,
click, charset-normalizer, certifi, attrs, shapely, requests, python-dateutil,
pyproj, contourpy, cligj, click-plugins, affine, rasterio, overturemaps, osmium,
matplotlib

Successfully installed affine-3.0.1 attrs-26.1.0 certifi-2026.7.22
charset-normalizer-3.5.1 click-8.5.0 click-plugins-1.1.1.2 cligj-0.7.2
colorama-0.4.6 contourpy-1.3.3 cycler-0.12.1 fonttools-4.64.0 idna-3.19
kiwisolver-1.5.1 matplotlib-3.11.1 numpy-2.5.2 orjson-3.12.0 osmium-4.3.1
overturemaps-1.0.2 packaging-26.3 pillow-12.3.0 pyarrow-25.0.1 pyfiglet-1.0.4
pyparsing-3.3.2 pyproj-3.7.2 python-dateutil-2.9.0.post0 rasterio-1.4.4
requests-2.34.2 shapely-2.1.2 six-1.17.0 tqdm-4.70.0 urllib3-2.7.0
install rc=0
```

Paquetes realmente usados en FASE 1: `rasterio 1.4.4`, `numpy 2.5.2`,
`pyproj 3.7.2`, `shapely 2.1.2`, `osmium 4.3.1` (instalado, no llegó a
necesitarse: Overpass cubrió el bbox).

`.venv/` está en `.gitignore` ✓. El repo de referencia **no se modificó**
(sólo se leyó `requirements.lock.txt`).

### 8.3 Scripts creados

| Script | Produce |
| --- | --- |
| `scripts/geo/overpass.sh` | POST a Overpass con UA propio, 4 reintentos ante 429/504, imprime `HTTP / bytes / sha256` |
| `scripts/geo/osm_highways_stats.py` | `data/geo/raw/osm_highways_stats.json` |
| `scripts/geo/verify_context.py` | `data/geo/raw/geo_verification.json` (distancias N-120/A-12/Camino, cumbres, cobertura) |
| `scripts/geo/crop_mdt02.py` | recorta la hoja MDT02 y **verifica píxel a píxel** que es un recorte exacto |
| `scripts/geo/compare_dems.py` | `data/geo/raw/dem_comparison.json` |
| `scripts/geo/tiling_and_projection.py` | `data/geo/raw/tiling_projection.json` |

Los cuatro generadores de JSON se re-ejecutaron y reprodujeron **salidas
byte-idénticas** (mismo SHA-256) → los números del informe son reproducibles.

---

## 9. Atribución

### 9.1 IGN / CNIG — MDT02 (CC BY 4.0)

**[DECLARADO]** — `https://www.ign.es/resources/licencia/Condiciones_licenciaUso_IGN.pdf`
(**HTTP 200**, `Content-Type: application/pdf`, **145 381 B**, extraído con
`pdftotext`):

> Fórmula general exigida:
> **`<identificador del producto> <fecha> CC-BY 4.0 <atribución de productores>`**
>
> Ejemplos del propio documento:
> - `BTN25 2014-2015 CC-BY 4.0 ign.es`
> - Abreviada: `CC-BY 4.0 scne.es 2010`
> - Obra derivada: `Obra derivada de PNOA 2010-2013 CC-BY scne.es`
>
> Base legal: **Orden FOM/2807/2015** (BOE 2015.12.26), que modifica la Orden
> FOM/956/2008. Artículo 4: el uso implica aceptación de la licencia **CC BY 4.0**.
> «Esta mención de atribución obligatoria se mostrará **visible junto con los
> datos**, de forma legible.»

**String a usar en el juego (sobre pantalla de créditos / `ATTRIBUTION.md`):**

```
MDT02 2015-2021 CC-BY 4.0 ign.es
```

*Estructura derivada de la fórmula oficial: `MDT02-cob2` + rango de fechas del
producto (2ª cobertura, 2015-2021) + `CC-BY 4.0` + `ign.es` (el productor que
usa el propio IGN en sus ejemplos). Si legal exige la forma completa, usar
`MDT02-cob2 2015-2021 CC-BY 4.0 ign.es`. **No inventar más productores de los
que figuran en la licencia.***

### 9.2 OpenStreetMap (ODbL)

**[DECLARADO]** — `https://www.openstreetmap.org/copyright` (HTTP 200):

> *«OpenStreetMap is open data, licensed under the **Open Data Commons Open
> Database License (ODbL)** by the OpenStreetMap Foundation (OSMF). In summary:
> You are free to copy, distribute, transmit and adapt our data, as long as you
> **credit OpenStreetMap and its contributors**. If you alter or build upon our
> data, you may distribute the result only under the same license.»*
>
> *«Where you use OpenStreetMap data, you are required to do the following two
> things: **Provide credit to OpenStreetMap by displaying our attribution
> notice.** Make clear that the data is available under the **Open Database
> License**.»*

Y el propio response de Overpass/Nominatim lo repite:

```
"The data is made available under ODbL."
"Data © OpenStreetMap contributors, ODbL 1.0. http://osm.org/copyright"
```

**Strings a usar:**

```
© OpenStreetMap contributors
Datos © OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright
```

### 9.3 Copernicus GLO-30 (sólo si se usa)

**[DECLARADO]** — tomado de `data/ATTRIBUTION.md` del repo de referencia, que
lo atribuye a los requisitos del proveedor:

```
produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus
Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European
Union and ESA; all rights reserved
```

**`UNKNOWN`:** el texto completo de la licencia de GLO-30 no se abrió en esta
fase; el registro AWS sólo dice *«under the terms and conditions of the Licence
found on here»*. **Si Copernicus entra al pipeline, verificar la licencia antes
de publicar.**

### 9.4 Dónde mostrarlo

La licencia IGN exige la mención **visible junto a los datos, de forma
legible** → pantalla de créditos del menú + `public/ATTRIBUTION.md`. Para OSM,
enlaces al copyright page + la cadena `© OpenStreetMap contributors` en la
interfaz (hud de mapa, créditos).

---

## 10. Riesgos y bloqueos

| # | Riesgo / bloqueo | Severidad | Estado |
| --- | --- | --- | --- |
| 1 | **15,730 km de `highway=proposed` (A-12) dentro del bbox** | **Alta** | Detectado. Excluir `proposed`/`construction` del grafo jugable. |
| 2 | **Sólo 20,8 % de ways con `surface`, 3,5 % con `access`** | **Alta** | No hay datos para la física. Inferir desde DEM + `tracktype` y **declararlo como inferencia**. |
| 3 | **64 de 191 `track` sin `tracktype` (18,4 km)** | Media | Inferir tracción con criterios propios + etiquetar como inferencia. |
| 4 | **Presupuesto de triángulos del repo de referencia (200 k / ≤100 tiles) no sirve para 6×6 km** | **Alta** | Requiere nuevo presupuesto + validador de manifest propio. 144 tiles > 100. |
| 5 | **`geoide` exacto de las alturas ortométricas MDT02 = `UNKNOWN`** | Media | La ficha dice «ortométricas» sin nombrar el geoide. Si el juego mezcla fuentes verticales, verificar antes. |
| 6 | **`muestraLic=NO` en el flujo de descarga CNIG** | Media | Funcionó hoy; el flujo es interno y puede cambiar sin aviso. Mitigación: el snapshot de la hoja ya está verificado por SHA-256. |
| 7 | **WCS IGN no tiene 2 m** (sólo 1000/500/200/25/5) | Baja (ya resuelto) | Se usa CNIG directo. |
| 8 | **Nominatim devolvió `403 Access denied` una vez** (2026-09-24 23:44) | Baja | Re-verificado hoy: **HTTP 200** con y sin UA. Fue transitorio (política OSMF). Overpass sigue siendo la fuente primaria. |
| 9 | **`rangeType` del WCS declara `W.m-2.Sr-1`** | Baja | Metadato defectuoso del servicio; documentado para no confundir unidades. |
| 10 | **Relación OSM del Camino Francés no hallada en la primera búsqueda** | Resuelto | Causa: radio de 6 km + límite `out … 200`. Ahora verificado con `rel(2163558); way(r)` → 66,6 m. |
| 11 | **OSM etiqueta sólo 1,06 % del bbox como bosque** | Media | No es cobertura real. Usar CORINE / ESA WorldCover para la máscara de vegetación. |
| 12 | **PBF de Castilla y León NO descargado** (177 195 869 B = 169 MB, `Last-Modified 2026-09-24`) | Info | Confirmado por HEAD con redirect 302→200. **No se descargó**: Overpass cubrió el bbox con 466 KB. |
| 13 | **`lat`/`lon` de la relación y del nodo coinciden exactamente** en Nominatim | Info | No es error: Nominatim devuelve el label point. Coincide con Overpass `node 492410655`. |

**No descargas > 200 MB sin reportarlas.** La mayor descarga de esta fase fue la
hoja MDT02 con **113 031 094 B (107,8 MB)**, reportada arriba.

---

## Confianza

| Afirmación | Confianza | Base |
| --- | --- | --- |
| Coordenada del pueblo `42.3883784 / −3.3086147` | **Alta** | 3 fuentes independientes coincidentes (Overpass node, Overpass relation vía Nominatim, Wikidata) re-verificadas hoy |
| La coordenada del packet está mal (8 677,2 m) | **Alta** | Aritmética en `EPSG:25830` sobre dos puntos verificados |
| bbox 6 × 6 km y sus métricas | **Alta** | Proyección oficial + shapely, reproducible con `tiling_and_projection.py` |
| Conteos OSM (395 ways / 150,355 km) | **Alta** en el snapshot · **Media** en la completitud de OSM | JSON crudo con SHA-256 + `timestamp_osm_base`; OSM puede estar incompleto en rural |
| N-120 a 8,5 m · Camino Francés a 66,6 m | **Alta** | Punto→segmento en UTM sobre geometría descargada |
| A-12 construida a 29,453 km | **Alta** | Idem, radio 40 km, 64 ways |
| MDT02 es el mejor DEM disponible para el bbox | **Alta** | Ficha de producto + GetCapabilities completo + descarga real + comparación RMSE contra los otros dos |
| MDT02 cubre el bbox entero sin mosaico | **Alta** | Bounds de la hoja vs bounds del bbox, verificado con rasterio |
| Recorte píxel-idéntico de `mdt02_bbox_2m.tif` | **Alta** | `np.array_equal` contra la ventana de la hoja original (`crop_mdt02.py`) |
| RMSE 0,835 m y 6,799 m | **Alta** | `compare_dems.py`, reproducible byte-idéntico |
| `EPSG:25830` + escala 1,0 + origen grid-aligned | **Alta** como recomendación técnica | Depende de que el equipo acepte escala 1,0 — decisión de diseño, no de datos |
| Cifras de tiling | **Alta** (aritmética) | Depende de que se fije la densidad; los presets están calculados |
| Presupuesto de triángulos del repo de referencia insuficiente | **Alta** | Leído directamente de `src/city-ground-relief.ts:74` y `src/city-mountains.ts:20` |
| Licencia CC BY 4.0 del IGN + fórmula de atribución | **Alta** | PDF oficial descargado (145 381 B) y extraído con `pdftotext` |
| `geoide` de las alturas MDT02 | **`UNKNOWN`** | No está nombrado en la ficha. No se rellena. |
| Licencia Copernicus GLO-30 (texto completo) | **`UNKNOWN`** | No se abrió en esta fase |
| Cobertura forestal real del bbox | **Baja con OSM** | OSM sólo etiqueta 1,06 %; usar CORINE/ESA WorldCover (pendiente) |

---

## Anexo A — Inventario de `data/geo/raw/`

Todos con `sha256sum data/geo/raw/*`:

| Archivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `mdt02_bbox_2m.tif` | 28 033 650 | `104f4883680ac8ac2365549c6d31ba852e8dfa97bfa98dff6cd73569a45e01f5` |
| `copernicus_glo30_N42_W004.tif` | 41 147 905 | `71748b2709a207bd9b3cb8a0bec963ad0b2cd7ecd9ce0f08ee99ff8169464b79` |
| `mdt05_bbox_5m.tif` | 2 893 184 | `04268d8b6472ac0eca83b7a59eba5d742342f5fb625e691605949ce49bff3996` |
| `mdt05_sample_1km.tif` | 80 536 | `ea12565fd04bd89d606b98659a2d62b1c2a02cecffe308dcc16bda71cec3c42f` |
| `osm_highways_bbox.geojson.json` | 466 800 | `25854c3cfa0787a44ef8e44702e6c023e0ccf64afee06e062b5d0ded55e2fe2d` |
| `osm_camino_frances_rel2163558_ways.json` | 529 115 | `fead100da52a713d8ebb8f8ba7ceb6427229b659c78cb9dc6591c0d2e7263b56` |
| `osm_landcover_bbox.json` | 149 460 | `8aed3e03b33a47e96850858d3cf7793c163794a81059cec65820ca464a79cec3` |
| `osm_forest_bbox.json` | 101 362 | `e26bf25f455ba4c96d338c54cda3d017da14dc24ad2e13e7d1c1ab546544d5f1` |
| `osm_a12_within40km.json` | 72 628 | `33b2ee278e4924577379af768230075e92a863c0d0b685b3fc14b0fce3daec46` |
| `wikidata_Q959000.json` | 57 682 | `b9f3f9372aa6a0a569fe0b4c7940fce462f1e077e8f66dc2d1c96aa565b53ad9` |
| `osm_context_places_peaks.json` | 37 160 | `b47cfad70aa5cf58170151664a9988244cc915106c89846a586c5ad81dadc9ae` |
| `osm_n120_a12_within3km.json` | 33 733 | `cee5d7aa466dada3273cd4346d3e9f6a8a824ea2f9f9c9e10909570a015827bd` |
| `osm_peaks_within20km.json` | 10 912 | `d8982a7bb2f747020965b3c249c4bd9c69bdb3d117548589207655d93ed88264` |
| `osm_camino_relations_within40km.json` | 12 338 | `757df202e0491bae9a1ed88c926281eb40593f9e8e97651a4000eaf1ba5d8e4f` |
| `ign_mdt_getcapabilities.xml` | 12 162 | `30c95575991611cd15924369d2a3ad5066aa9a81ff68f8e549c71bdc6c638d3f` |
| `geo_verification.json` | 10 074 | `3c84339fdeedb231837ac633c4e3579eaf202d4fd35470b380792e9c8a4927f3` |
| `tiling_projection.json` | 10 063 | `e900f6ac56c998039fbfa3e73e811cc8e4bd91a36c1e9db5b61a9c469da8deca` |
| `ign_describe_Elevacion25830_5.xml` | 2 536 | `da3b2638ecceb52eeb837fc5d020e6573489fdfb2ce0435872e34e1f5876421a` |
| `osm_highways_stats.json` | 2 396 | `f21ca72f4897257819c696139242300299c9cd340ac20dc7d281a59f3aa31602` |
| `dem_comparison.json` | 1 408 | `a1f3f963f803e9dc252bd266eafdf233e2b178bb9f3f197860c70e01acf5b153` |
| `osm_village_node_relation.json` | 1 343 | `4b63d6bb64fa3b5c6a181fd24c8906d7ddea1072d80dc9ad5d121e8426cb669f` |
| `osm_village_node.json` | 840 | `d0114d5be7300cf2faa7cd32b9dd0e6d9921e6137a5bb5d0dbcdbf70c1c0c4fc` |
| `nominatim_villafranca.json` | 486 | `b32212dff93decd59a71c2fd00848c140515f51a4d93570fc7572ba87c8b75f9` |
| `osm_camino_network_ways_15km.json` | 287 | `0a3b9f3d9f3a20f3fbc15b6044b51af6742f5170a708ca46f69cfa5a44324d94` |

Fuera del repo (temporales, reportados por completitud):

| Archivo | Bytes | SHA-256 |
| --- | ---: | --- |
| `/tmp/opencode/MDT02-ETRS89-HU30-0201-4-COB2.tif` (hoja CNIG completa) | 113 031 094 | `7ca1d9f5ecd28e3fa44398c10c24f3e5eb3e2320db162befa350f4c99f6b782c` |
| `/tmp/opencode/lic_ign.pdf` (licencia IGN) | 145 381 | — |

**No se descargó:** `castilla-y-leon-260923.osm.pbf` (Geofabrik) —
HTTP 302 → 200, **`Content-Length: 177 195 869`** (169 MB), `Last-Modified
2026-09-24 01:17:54 GMT`. Confirmado con `curl -sSIL`, **no descargado**.

## Anexo B — Reproducción

```bash
# 1) Overpass: red viaria del bbox
printf 'way["highway"](42.350651,-3.350784,42.404549,-3.277816);out tags geom;\n' > /tmp/q.overpassql
scripts/geo/overpass.sh /tmp/q.overpassql data/geo/raw/osm_highways_bbox.geojson.json
./.venv/bin/python scripts/geo/osm_highways_stats.py

# 2) Contexto (N-120, A-12, Camino, cumbres, cobertura)
./.venv/bin/python scripts/geo/verify_context.py

# 3) Recorte del MDT02 (no reescribe si ya existe; sólo verifica)
./.venv/bin/python scripts/geo/crop_mdt02.py \
    /tmp/opencode/MDT02-ETRS89-HU30-0201-4-COB2.tif data/geo/raw/mdt02_bbox_2m.tif

# 4) Comparación de DEM
./.venv/bin/python scripts/geo/compare_dems.py

# 5) Proyección y tiling
./.venv/bin/python scripts/geo/tiling_and_projection.py

# 6) Integridad
sha256sum data/geo/raw/*
```
