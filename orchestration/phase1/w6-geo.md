# TASK PACKET W6 — GEO FASE 1: Villafranca Montes de Oca y fuentes DEM

## Estándares del proyecto (auto-resueltos)
- Nunca trates estimaciones, tags de OSM ni grillas interpoladas como valores medidos. La procedencia de cada número debe ser explícita.
- SIEMPRE reportá la URL de la fuente, el código HTTP que realmente obtuviste, el tamaño del archivo y un checksum cuando descargues algo.
- `UNKNOWN` es una respuesta válida. NUNCA inventes coordenadas, resoluciones ni términos de licencia.
- Escribí el reporte en **español** técnico.
- Si descubrís algo importante, guardalo en engram con `mem_save` y `project: "montes-de-oca"` antes de terminar.

## Contexto
- Juego nuevo: **"Montes de Oca: Offroad Stories"** — open world rural **OFF-ROAD**. Primera área: **Villafranca Montes de Oca, Burgos, Castilla y León, España**.
- Coordenadas aproximadas (VERIFICAR, no confiar): lat 42.3865, lon -3.4140. Está en el extremo oeste de la sierra de **Montes de Oca**, sobre el **Camino de Santiago Francés**, cerca de los corredores **N-120** y **A-12**. Relieve de sierras, bosque (pino/roble), campos de labor, elevación aproximada 800–1100 m dentro de una caja de 6×6 km.
- Objetivo: un área jugable de **6 × 6 km** alrededor del pueblo, terreno DEM real, rutas y pistas forestales reales de OSM.
- Stack base: Babylon.js + TypeScript + Vite. La preparación de datos es en Python.
- Directorio de trabajo: `/home/kiri_/projects/montes-de-oca-offroad`
- Proyecto de referencia (READ-ONLY, sólo para convenciones de pipeline): `/home/kiri_/projects/montes-de-oca`

## RUTAS ASIGNADAS (ownership — no escribas fuera de acá)
- Reporte: `/home/kiri_/projects/montes-de-oca-offroad/docs/geo/GEO_PLAN.md`
- Datos crudos / muestras: `/home/kiri_/projects/montes-de-oca-offroad/data/geo/raw/`
- Scripts auxiliares, si los necesitás: `/home/kiri_/projects/montes-de-oca-offroad/scripts/geo/`
No escribas en ningún otro lugar. No toques el repo de referencia.

## ENTORNO (ya verificado — re-verificá barato si importa)
- Disponibles: `curl`, `wget`, `unzip`, `jq`, `python3` (3.12.3).
- **NO instalados**: GDAL (`ogr2ogr`, `gdal_translate`, `gdalwarp`), `osmium`, `pdal`, `Blender`. No hay venv todavía. `pip` está disponible.
- Overpass API: `POST https://overpass-api.de/api/interpreter`, body vía `--data-urlencode "data@file"`, y **DEBÉS** mandar header `User-Agent` o te devuelve HTTP 406. Verificado funcionando.
- Geofabrik: `https://download.geofabrik.de/europe/spain/castilla-y-leon-latest.osm.pbf` (devuelve 302 → redirect).
- IGN WCS: `https://servicios.idee.es/wcs-inspire/mdt` GetCapabilities devolvió 200.

## GOAL
Producir el **plan de FASE 1 (GEO)** con fuentes de datos verificadas para terreno y rutas, y adquirir muestras reales chicas que prueben que el pipeline es viable.

## TAREAS
1. **Verificá la ubicación.** Confirmá la coordenada del centro de Villafranca Montes de Oca y su relación con Montes de Oca, el Camino Francés y N-120/A-12, con una consulta real (Overpass `relation`/`node` con `name=Villafranca Montes de Oca`, o Nominatim con User-Agent propio). Reportá la coordenada que efectivamente obtuviste y la fuente.
2. **Proponé el bbox jugable** para 6 × 6 km, justificado en términos de la geografía real (el pueblo, la sierra, el bosque, un destino adecuado para la "instalación de repetidor"). Daló en bounds WGS84 y en tamaño en metros.
3. **Rutas y pistas OSM.** Corré una query real de Overpass para el bbox y reportá **conteos reales** por categoría: `highway=primary/secondary/tertiary/unclassified/residential/service/track/track+tracktype/path/footway/bridleway`. Reportá cobertura de tags `surface`, `smoothness`, `access`. Guardá el JSON crudo (o un extracto normalizado) en `data/geo/raw/`. Mantenelo chico — este bbox es rural, debería ser unos pocos MB como mucho. Reportá tamaño exacto y SHA-256.
4. **DEM de terreno.** Esta es la parte crítica. Determiná el **mejor DEM disponible para España** y verificá cada candidato con un request HTTP real:
   - **MDT02** de IGN/CNIG (2 m, de LiDAR PNOA) — probá el WCS de IGN `https://servicios.idee.es/wcs-inspire/mdt` (leé GetCapabilities, reportá los coverage IDs reales y los CRS soportados) y/o el centro de descargas CNIG `https://centrodedescargas.cnig.es/`.
   - **MDT05 / MDT25** de IGN como fallbacks más gruesos.
   - **Copernicus DEM GLO-30** como fallback sin autenticación.
   Para cada candidato reportá: URL real o request WCS, código HTTP, formato (GeoTIFF/ASC), resolución nativa, datum vertical, CRS nativo, licencia, y si requiere auth/registro. **Intentá una descarga real** de un tile chico que cubra parte del bbox y reportá tamaño + SHA-256 + si pudiste leerlo con Python (probá `rasterio`/`numpy` — instalá un venv en `/home/kiri_/projects/montes-de-oca-offroad/.venv` desde `requirements.lock.txt` del repo de referencia, o como mínimo reportá los bytes de cabecera del GeoTIFF).
   Si auth/registro bloquea la descarga, DECILO explícitamente y pasá al siguiente candidato.
5. **Propuesta de proyección y origen.** Recomendá un sistema de coordenadas local de juego: un CRS proyectado adecuado para Burgos (p. ej. UTM 30N / ETRS89 EPSG:25830), un origen local (en el pueblo o en el centro del bbox), y la escala metros → unidades de juego. Comparalo con la convención del proyecto de referencia (metros reales × 0.60, origen en WGS84 [114.025, 22.536], lon×102850 / lat×111320) y decí qué deberíamos cambiar para España. Anotá la diferencia entre las coords de investigación tempranas EPSG:32649 y el origen local que el juego embarcado realmente usa.
6. **Propuesta de tiling de terreno.** Compará **512 × 512 m** vs **1024 × 1024 m** para un área de 6 × 6 km: cantidad de tiles, cantidad de vértices a una densidad de muestreo sensata (declará tu densidad, p. ej. 2 m, 5 m, 10 m), bytes estimados, y cómo mapea sobre la arquitectura de streaming existente. Dale una recomendación con números, no con opiniones.
7. **Advertencia de resolución vertical.** Decí explícitamente la diferencia de resolución útil entre un DEM LiDAR de 2 m, uno de 5 m, uno Copernicus de 30 m y cualquier grilla interpolada. No dejes que nadie afirme que interpolar aumenta la resolución real.
8. **Entorno Python**: reportá el set exacto de comandos para crear `.venv` e instalar los paquetes necesarios para DEM/OSM, y si efectivamente funcionó (reportá la cola real de la salida de pip).
9. **Atribución**: string(s) de atribución exactos requeridos para IGN/CNIG (CC-BY 4.0) y OSM (ODbL) para un juego publicado.

## CONSTRAINTS
- **NO** descargues el PBF completo de España o Castilla y León salvo que pruebes que una fuente más chica es imposible. Preferí Overpass para este bbox. Si descargás un archivo grande, reportá el tamaño primero y justificalo.
- Nunca dejes una descarga de >200 MB sin reportarla.
- NO modifiques el repo de referencia.
- Cada número del reporte tiene que ser trazable a un comando que efectivamente corriste.

## DELIVERABLE
`/home/kiri_/projects/montes-de-oca-offroad/docs/geo/GEO_PLAN.md`, con secciones:
`## 1. Ubicación verificada` / `## 2. Bounding box propuesto` / `## 3. Red viaria OSM` / `## 4. Fuentes DEM` / `## 5. Proyección y origen local` / `## 6. Tiling de terreno` / `## 7. Advertencia de resolución vertical` / `## 8. Entorno Python` / `## 9. Atribución` / `## 10. Riesgos y bloqueos` / `## Confianza`
Datos crudos y muestras bajo `data/geo/raw/`.

## VALIDATION
- Reportá los códigos HTTP y tamaños de archivo **reales** que observaste.
- Reportá el resultado exacto del pip install.
- Si alguna fuente crítica está bloqueada, eso es un resultado válido e importante — reportalo como bloqueo.
- La respuesta final debe incluir: coordenada verificada del pueblo, bbox, conteos OSM por categoría, DEM elegido + evidencia real de descarga, recomendación de tiling con números, bloqueos, y confianza.
