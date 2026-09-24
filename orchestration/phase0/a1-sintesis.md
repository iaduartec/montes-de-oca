# TASK PACKET A1 — Síntesis consolidada de la auditoría (PROJECT_AUDIT.md)

## Estándares del proyecto (auto-resueltos)
- Repos de referencia: `/home/kiri_/projects/montes-de-oca` (motor GTA_SZ / 深城纪) es **READ-ONLY**.
  El proyecto nuevo es `/home/kiri_/projects/montes-de-oca-offroad`.
- Documentación en **español** técnico.
- **No hagas commits git.** Nunca agregues `Co-Authored-By` ni atribución de IA.
- Si descubrís algo no obvio, guardalo en engram con `mem_save` y `project: "montes-de-oca"`.

## Contexto
El juego es **"Montes de Oca: Offroad Stories"**, un mundo abierto rural 3D en navegador (Babylon.js)
ambientado en Villafranca Montes de Oca (Burgos, España). Reutilizamos el motor de **GTA_SZ**, que es
una ciudad densa de Shenzhen: nosotros necesitamos **terreno real y pistas forestales**.

Ya existe una auditoría de la FASE 0 repartida en estos archivos (todos ya escritos, **NO los modifiques**):

| Archivo | Contenido |
|---|---|
| `docs/audit/01-runtime-y-streaming.md` | boot, render loop, streaming, manifiestos, save, performance |
| `docs/audit/02-pipeline-datos-y-terreno.md` | pipeline Python, DEM, terreno, OSM |
| `docs/audit/03-conduccion-jugador-fisica.md` | `stepCar`, colisión, tráfico, autopista, cámara |
| `docs/audit/04-assets-blender-licencias.md` | Blender, GLB, licencias, atribución |
| `docs/audit/05-acoplamiento-shenzhen.md` | inventario de acoplamiento al contenido de Shenzhen |
| `docs/audit/REVIEW-phase0.md` | **review adversarial que ya verificó las anclas de los 5 anteriores** |

## GOAL
Consolidar esos **seis** documentos en **UNO SOLO** utilizable para decidir: `docs/audit/PROJECT_AUDIT.md`.
Hoy la información está repartida y hay contradicciones de alcance entre autores; el objetivo es que
alguien que llegue nuevo lea un solo archivo y sepa **qué reutilizamos, qué reescribimos y qué no existe**.

## REGLA MÁS IMPORTANTE: no inventes nada nuevo
- **NO re-audites el código.** No abras el repo de referencia para descubrir cosas nuevas.
- **NO agregues afirmaciones nuevas.** Tu trabajo es **consolidar y ordenar** lo que ya está escrito.
- **TODA** afirmación del documento debe poder rastrearse a uno de los 6 archivos fuente.
- Mantené las anclas `archivo:línea` **tal como están en las fuentes**. No las reescribas ni las
  reformatees: ya fueron verificadas y una alteración las invalida.
- Si dos fuentes se contradicen, **mostrá la contradicción** en una sección propia en vez de elegir en
  silencio. (Ejemplo real ya detectado: `01` declara `driving.ts` como `UNKNOWN` mientras `03` lo audita
  completo; `02` declara `navigation.json` sin consumo rastreado mientras `01` lo rastrea.)
- Donde `REVIEW-phase0.md` corrigió algo (los veredictos, las dos anclas), **usá la versión corregida** y
  dejá constancia de que fue corregida.

## ESTRUCTURA OBLIGATORIA
1. `## Qué es el motor de referencia` — 1 párrafo + stack (versiones) + escala del código.
2. `## Resumen ejecutivo` — qué reutilizamos, qué reescribimos, qué no existe. Legible en 2 minutos.
3. `## Mapa motor-común vs contenido-Shenzhen` — **la tabla más importante del documento**: cada
   subsistema con su veredicto (`REUSE-AS-IS` / `REUSE-WITH-PARAMS` / `REWRITE` / `SHENZHEN-ONLY`) y su
   ancla. Usá **exactamente** la tabla consolidada de `REVIEW-phase0.md` §"Veredicto de reutilización
   corregido", que ya está verificada. Podés añadir las filas nuevas que aparezcan en `01`, `02`, `04`
   y `05` que no estén en esa tabla, respetando el formato y con su ancla.
4. `## Los hallazgos que cambian el plan` — los que obligan a decidir distinto. Como mínimo:
   - La física del vehículo: `stepCar` es 2D sin gravedad ni pendiente, pero hay un pitch **visual**
     en `city-world.ts:513`. Explicá la distinción física vs render porque se confunde fácil.
   - El núcleo vial: `track`/`path` fuera de la whitelist, `tracktype`/`smoothness` sin lecturas.
   - El terreno: base plana a 0 + parches de DSM real + relleno autoral. Cuál es cuál.
   - El template de DEM que **no puede ejecutarse** (ver punto 6).
5. `## Frontera de reutilización` — qué se copia tal cual, qué se parametriza, qué se escribe nuevo.
   Incluí el hallazgo de que el runtime tiene **una sola** ocurrencia del origen/escala
   (`city-map-geometry.ts:19`) mientras los `scripts/` tienen 12 definiciones duplicadas.
6. `## Insumos que NO existen en el checkout` — sección crítica, verificada por el orquestador:
   - `data/processed/` **no existe**: `prepare_landmark_terrain.py` exige
     `data/processed/shenzhen_study/{green,water,roads}.geojson` (`:86-87`, `:134`, `:170-171`) y
     **no están**. El script **no puede ejecutarse**. No es un template a parametrizar.
   - Los **219** archivos `.glb` son **punteros Git LFS de ~130 bytes**; `git-lfs` no está instalado.
     Cero assets de malla utilizables ⇒ **ningún** presupuesto de draw calls/triángulos/GPU se puede
     medir contra la referencia.
7. `## Contradicciones y alcance no cubierto` — las contradicciones entre autores + lo que quedó sin auditar.
8. `## Riesgos abiertos` — incluí los 8 del review y marcá cuáles ya fueron verificados por el
   orquestador y cuáles siguen abiertos (ej: datum vertical IGN, interpretación legal ODbL).
9. `## Qué falta para la FASE 1/2/3` — lista corta y accionable.

## CONSTRAINTS
- **NO modifiques** `docs/audit/01..05-*.md` ni `REVIEW-phase0.md`. Tu **único** archivo de salida es
  `docs/audit/PROJECT_AUDIT.md`.
- No toques el repo de referencia.
- No agregues recomendaciones de arquitectura propias: sólo consolidación.
- Sé honesto con lo que falta. Si algo no está en las fuentes, **no lo escribas**.

## VALIDATION
- Contá y declaré al final cuántas filas tiene la tabla de reutilización y de qué fuente(s) salió cada una.
- Verificá que **todas** las anclas `archivo:línea` que escribas existen textualmente en las fuentes
  (podés hacerlo con `grep` sobre los 6 archivos fuente). Reportá el conteo.
- En tu respuesta final: cuántas líneas tiene el documento, cuántas filas la tabla, y qué contradicciones
  encontraste entre los autores.
