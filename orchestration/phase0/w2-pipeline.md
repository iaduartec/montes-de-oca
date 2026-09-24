# TASK PACKET W2 — Auditoría de pipeline de datos y terreno

## Estándares del proyecto (auto-resueltos)
- El repo de referencia `/home/kiri_/projects/montes-de-oca` es **READ-ONLY**. No lo modifiques.
- Build exitoso NO es validación. Citá `archivo:línea` en cada afirmación. Si no se sabe, `UNKNOWN`. NUNCA inventes.
- Nunca trates estimaciones de fotos ni tags de OSM como valores medidos. La procedencia debe ser explícita.
- Escribí la salida en **español** técnico.
- Si descubrís algo importante, guardalo en engram con `mem_save` y `project: "montes-de-oca"` antes de terminar.

## Contexto
- El repo de referencia es **GTA_SZ / 深城纪**: juego de ciudad en navegador con Babylon.js + TypeScript + Vite, ambientado en Shenzhen. Tiene un pipeline maduro **OSM → datos de ciudad → terreno → runtime** manejado con Python en `scripts/`.
- Estamos construyendo un juego **SEPARADO**: **"Montes de Oca: Offroad Stories"**, open world rural off-road en Villafranca Montes de Oca (Burgos, España). Necesitamos terreno REAL (DEM IGN/CNIG) y rutas REALES (OSM), después conducir un 4x4.
- Raíz del proyecto nuevo: `/home/kiri_/projects/montes-de-oca-offroad`

## GOAL
Documentar el **pipeline de datos y terreno** de punta a punta, para poder reutilizarlo en un área rural. Escribí `docs/audit/02-pipeline-datos-y-terreno.md`.

## FILES
- scripts/download_osm.py
- scripts/extract_city.py
- scripts/validate_data.py
- scripts/prepare_city_streets.py        (el paso OSM → calles/rutas: leelo con cuidado)
- scripts/prepare_city_ground_relief.py
- scripts/build_city_ground.py
- scripts/prepare_landmark_terrain.py
- src/city-types.ts                       (el esquema de datos de runtime)
- src/city-ground-relief.ts               (muestreo de altura en runtime)
- src/city-road-surface.ts                (superficies)
- requirements.lock.txt
- data/ATTRIBUTION.md

## PREGUNTAS (con evidencia `archivo:línea`)
1. Cadena completa: descarga `.osm.pbf` → extracción → JSON preparado → `public/city/*.json` embarcado. Nombrá cada etapa, su entrada, su salida y el script exacto.
2. Esquema exacto de los datos de ciudad en runtime: ¿qué campos tiene `Road`? ¿`Building`? ¿`water`/`green`/`land`? (desde src/city-types.ts). ¿Cuáles son las unidades?
3. Manejo de coordenadas: ¿dónde pasa WGS84 lon/lat a X/Z de juego? ¿Qué factores de escala? ¿Hay paso de proyección (pyproj/EPSG)? ¿Origen hard-codeado?
4. Clasificación vial: ¿cómo se mapean tags `highway=*` a clases/anchos/superficies? ¿Soporta `track`, `path`, `tracktype`, `surface`, `smoothness`, `access`? (¡crítico para off-road!)
5. Terreno: ¿el terreno embarcado es un heightfield DEM real o un relieve autoral/placeholder? ¿Cómo se produce y consume `terrain-detail.json`? ¿Qué resolución? ¿Acepta DEM arbitrario o está atado a Shenzhen?
6. Reconciliación terreno-vía: ¿cómo se apoyan las rutas sobre el terreno? ¿Hay aplanado/carving? ¿Dónde?
7. Obligaciones de licencia/atribución que arrastra el pipeline (ODbL, etc.) — sobre todo lo que cambia para España / datos IGN CC-BY.
8. **Veredicto de reutilización** por script: REUSE-AS-IS / REUSE-WITH-PARAMS / SHENZHEN-ONLY / REWRITE, con justificación.
9. Huecos concretos para nuestro caso: protagonismo de `track`/`path` rural, heightfield de 6×6 km a resolución útil, ingesta de DEM IGN, cero edificios, densidad vial baja, área más grande.

## CONSTRAINTS
- NO toques `/home/kiri_/projects/montes-de-oca`.
- Escribí ÚNICAMENTE `docs/audit/02-pipeline-datos-y-terreno.md`. Ningún otro archivo.
- Conciso, denso, tablas donde ayude. Reportá lo que no pudiste determinar.

## DELIVERABLE
`/home/kiri_/projects/montes-de-oca-offroad/docs/audit/02-pipeline-datos-y-terreno.md`, cerrando con `## Confianza`.

## VALIDATION
- El archivo existe y no está vacío.
- Cada etapa del pipeline nombrada con su script y ancla de línea.
- En tu respuesta final: la lista de etapas, los veredictos de reutilización, los top-3 huecos para una España rural, y confianza.
