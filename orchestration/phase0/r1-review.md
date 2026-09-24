# TASK PACKET R1 — Review adversarial cruzado de la FASE 0

## Estándares del proyecto (auto-resueltos)
- El repo de referencia `/home/kiri_/projects/montes-de-oca` es **READ-ONLY**. No lo modifiques.
- **No afirmes nada sin verificarlo con el código.** Tu trabajo es exactamente el opuesto: dudar.
- Citá `archivo:línea` en cada verificación. Si no pudiste verificar, escribí `NO VERIFICADO`.
- Escribí la salida en **español** técnico.
- Si descubrís algo importante, guardalo en engram con `mem_save` y `project: "montes-de-oca"` antes de terminar.

## Contexto
- Los docs `docs/audit/01..05-*.md` del proyecto `/home/kiri_/projects/montes-de-oca-offroad` fueron escritos por **cinco modelos distintos y económicos** (no por un humano) a partir del repo de referencia **GTA_SZ / 深城纪** (Babylon.js 8 + TS + Vite, ciudad de Shenzhen).
- Tu modelo es distinto al de ellos a propósito. Sos el **revisor adversarial**.
- Riesgo principal: **anclas `archivo:línea` inventadas o desplazadas**. Un audit con anclas falsas es peor que no tener audit, porque decisiones de arquitectura se van a tomar sobre él.

## GOAL
Verificar los `docs/audit/01..05-*.md` contra el código real y escribir `docs/audit/REVIEW-phase0.md`.

## MÉTODO (obligatorio)
1. Para cada doc, tomá las afirmaciones **que cambian decisiones** (veredictos de reutilización, afirmaciones sobre física, licencias y esquema de datos) — no hace falta revisar todo.
2. Abrí el archivo citado en la línea citada y comprobá si **realmente dice eso**. Usá `sed -n 'N,Mp' archivo` para leer el rango exacto.
3. Clasificá cada afirmación: `CONFIRMADO` / `REFUTADO` / `IMPRECISO` / `ANCLA FALSA` / `NO VERIFICADO`.
4. Cuando refutes algo, mostrá el código real que lo contradice.

## AFIRMACIONES PRIORITARIAS A VERIFICAR
Estas son las que cambian el plan. Verificalas sí o sí:

- **A (crítica)** — `03-conduccion-jugador-fisica.md` §2: que `stepCar` (`src/driving.ts:6-16`) NO tiene gravedad ni término de pendiente y que el parámetro `grip` es sólo un tope de velocidad (`53*grip`, línea 13). **Y además** verificá que `src/city-world.ts:513` SÍ aplica un pitch visual con `atan2(front-rear,3)` muestreando la altura a ±1,5 m. Confirmá que ambas cosas son ciertas a la vez (física sin pendiente + render con pitch) y decí si el doc refleja esa distinción o la confunde.
- **B (crítica)** — `02-pipeline-datos-y-terreno.md` §4: que los tags OSM `tracktype`, `surface`, `smoothness`, `access` **no** se leen para lógica vial, y que `highway=track/path` no entra en la whitelist vial. Esto decide si la FASE 3 es REUSE o REWRITE. Grepeá `scripts/` vos mismo y pegalo como evidencia.
- **C (crítica)** — `02-pipeline-datos-y-terreno.md` §5 y §6: ¿el terreno embarcado es DEM real o autoral? ¿Qué contiene exactamente `public/city/terrain-detail.json` y qué script lo produce? Decí con precisión qué es real y qué es inventado, porque de esto depende toda la FASE 2.
- **D** — `02-...` §8: que `scripts/prepare_landmark_terrain.py` es la mejor plantilla de ingesta de DEM reutilizable (ventana + bilineal + datum + drapeado). Verificá si realmente podría consumir un GeoTIFF arbitrario o si está atado a Shenzhen.
- **E** — `03-...` §4: comportamiento de `CityCollision.blocked` en un mapa **sin edificios ni landmarks**.
- **F** — `01-runtime-y-streaming.md` §3: distancias de streaming, tamaños de tile, presupuestos LOD, y si `CityFacadeStream` es realmente el único stream.
- **G** — `04-assets-blender-licencias.md` §5: el split de licencias código vs assets. **Citá el texto literal de `LICENSE` y de `data/ATTRIBUTION.md`.** Si el doc lo parafraseó mal, es un problema legal.
- **H** — `05-acoplamiento-shenzhen.md` §1: ¿están TODAS las ocurrencias de origen local / 102850 / 111320 / 0.60? Verificá el conteo con `grep -c` vos mismo y reportá el número real.

## CONSTRAINTS
- NO toques `/home/kiri_/projects/montes-de-oca`.
- NO modifiques NINGUNO de los `docs/audit/0*.md`. Tu único archivo de salida es `docs/audit/REVIEW-phase0.md`.
- No reescribas los audits "mejorados". Sólo verificá y reportá.
- Sé duro. Encontrar anclas falsas es un resultado valioso, no un fracaso.
- No gastes contexto leyendo archivos enormes enteros: usá `grep`, `sed -n` y `wc`.

## DELIVERABLE
`/home/kiri_/projects/montes-de-oca-offroad/docs/audit/REVIEW-phase0.md` con:
`## Resumen ejecutivo` (¿es confiable el audit o no, en 5 líneas) / `## Verificación por afirmación` (tabla: afirmación, veredicto, evidencia `archivo:línea`) / `## Anclas falsas encontradas` (lista concreta) / `## Veredicto de reutilización corregido` (tabla final consolidada que yo pueda usar tal cual) / `## Riesgos que el audit no cubrió` / `## Confianza`

## VALIDATION
- Cada fila de la tabla tiene evidencia `archivo:línea` leída por vos (pegá el snippet cuando refutes).
- Declará explícitamente cuántas afirmaciones verificaste, confirmaste y refutaste.
- En tu respuesta final: veredicto de confiabilidad del audit, lista de anclas falsas, y la tabla de reutilización corregida resumida.
