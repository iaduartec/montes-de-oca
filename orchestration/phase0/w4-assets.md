# TASK PACKET W4 — Auditoría de assets (Blender/GLB) y licencias

## Estándares del proyecto (auto-resueltos)
- El repo de referencia `/home/kiri_/projects/montes-de-oca` es **READ-ONLY**. No lo modifiques.
- Build exitoso NO es validación. Citá `archivo:línea` o salida de comando en cada afirmación. Si no se sabe, `UNKNOWN`. NUNCA inventes.
- Nunca trates valores estimados como medidos. La procedencia debe ser explícita.
- Escribí la salida en **español** técnico.
- Si descubrís algo importante, guardalo en engram con `mem_save` y `project: "montes-de-oca"` antes de terminar.

## Contexto
- El repo de referencia es **GTA_SZ / 深城纪**, Babylon.js + TS + Vite, ciudad de Shenzhen. Los modelos se autoran en **Blender vía Python** y se exportan a **GLB**; los assets grandes van en **Git LFS** y se despliegan a Cloudflare R2.
- Juego nuevo: **"Montes de Oca: Offroad Stories"** — rural off-road, Villafranca Montes de Oca (Burgos). Vamos a necesitar: malla de terreno, vehículo 4x4, pistas forestales, árboles, cercas/portones, una instalación de repetidor. El código debe ser compatible con MIT; el licenciamiento de assets tiene que quedar registrado.
- Raíz del proyecto nuevo: `/home/kiri_/projects/montes-de-oca-offroad`

## GOAL
Auditar el **pipeline de autoría de assets (Blender→GLB)** y el **modelo de licencias/atribución**. Escribí `docs/audit/04-assets-blender-licencias.md`.

## FILES
- scripts/city_mesh.py                  (API de malla compartida — ojo: importarlo inicializa Blender)
- scripts/build_vehicle_candidate.py
- scripts/build_landmark_details.py
- scripts/build_canopy_trees.py
- scripts/rebuild_city_assets.mjs
- scripts/check-character-assets.mjs
- LICENSE
- data/ATTRIBUTION.md
- .gitattributes
- .gitignore
- docs/assets/            (listá el directorio; leé sólo lo necesario)
- public/licenses/        (listá el directorio)
Investigá la convención de nombres de `scripts/` (`build_*.py`, `prepare_*.py`, `check-*.mjs`) listando el directorio — no los leas todos, muestreá 2-3 según haga falta.

## PREGUNTAS (con evidencia de archivo:línea / comando)
1. Calificá la **API de malla compartida** `scripts/city_mesh.py`: ¿qué primitivas/helpers expone? ¿Es city-specific o genuinamente reutilizable para objetos rurales? Listá las funciones públicas y su propósito.
2. La convención **build → prepare → check**: ¿qué hace cada etapa? Dale el significado exacto de los prefijos `build_*` vs `prepare_*` vs `check-*` con ejemplos reales del repo.
3. **Convenciones de exportación GLB**: conversión de ejes (Blender Z-up → glTF Y-up), unidades, escala, manejo de orientación del nodo raíz. Citá el código.
4. ¿Cómo se hacen cumplir presupuestos/validación de assets (conteo de triángulos, tamaño de texturas, hashes de manifiesto)? Señalá el mecanismo de manifiesto y la ruta de despliegue LFS/R2 a alto nivel.
5. **Licenciamiento**: decí exactamente cómo se licencia código vs assets en este repo (leé LICENSE, data/ATTRIBUTION.md y la sección de licencias del README si se referencia). ¿Qué obligaciones de atribución existen? ¿Qué cambia al pasar a datos **IGN/CNIG (CC-BY 4.0) y OSM (ODbL)** para España?
6. ¿Qué tooling se asume instalado (versión de Blender, scripts node, gltf-transform, meshoptimizer) y qué necesitaríamos para el proyecto nuevo?
7. **Veredicto de reutilización** por pieza: REUSE-AS-IS / REUSE-WITH-PARAMS / SHENZHEN-ONLY / REWRITE.
8. Lista concreta de assets faltantes para el MVP: 4x4, tramos de pista forestal, árboles, cercas/portones, instalación de repetidor, terreno. Para cada uno: ¿hay un builder reutilizable o una librería de formas como punto de partida en el repo?

## CONSTRAINTS
- NO toques `/home/kiri_/projects/montes-de-oca`.
- NO ejecutes Blender ni ningún script de build — esto es un audit de LECTURA. Leer `.py`/`.mjs` y correr comandos read-only (`ls`, `grep`, `wc`, `head`) está bien.
- Escribí ÚNICAMENTE `docs/audit/04-assets-blender-licencias.md`. Ningún otro archivo.

## DELIVERABLE
`/home/kiri_/projects/montes-de-oca-offroad/docs/audit/04-assets-blender-licencias.md`, cerrando con `## Confianza`.

## VALIDATION
- El archivo existe y no está vacío.
- La sección de licencias es explícita y cita el texto real de LICENSE/ATTRIBUTION — no podemos equivocarnos en esto.
- En tu respuesta final: veredicto de la API de malla, resumen de licencias, lista de assets faltantes del MVP, y confianza.
