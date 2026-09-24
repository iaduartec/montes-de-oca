# TASK PACKET W1 — Auditoría de runtime, boot y streaming

## Estándares del proyecto (auto-resueltos)
- El repo de referencia `/home/kiri_/projects/montes-de-oca` es **READ-ONLY**. No lo modifiques.
- Build exitoso NO es validación. No afirmes que algo funciona sin evidencia.
- Citá `archivo:línea` en cada afirmación. Si algo no se sabe, escribí `UNKNOWN`. NUNCA inventes.
- Escribí la salida en **español** técnico.
- Si descubrís algo importante, guardalo en engram con `mem_save` y `project: "montes-de-oca"` antes de terminar.

## Contexto
- El repo de referencia es **GTA_SZ / 深城纪**: juego de ciudad en el navegador con **Babylon.js 8 + TypeScript + Vite**, ambientado en Shenzhen. ~140 módulos en `src/`.
- Estamos construyendo un juego **SEPARADO**: **"Montes de Oca: Offroad Stories"**, open world rural off-road en Villafranca Montes de Oca (Burgos, España). Mismo stack base.
- Raíz del proyecto nuevo: `/home/kiri_/projects/montes-de-oca-offroad`
- Tu trabajo alimenta un audit de "¿qué reutilizamos?". La pregunta central: ¿qué es **motor genérico** y qué es **contenido específico de Shenzhen**?

## GOAL
Auditar la arquitectura de **runtime, boot y streaming** y escribir `docs/audit/01-runtime-y-streaming.md`.

## FILES (leé estos; si un archivo listado importa algo chico que necesitás entender, leelo también y decilo)
- src/main.ts
- src/world.ts
- src/city-world.ts  (grande — leelo en secciones, no lo vuelques entero)
- src/city-loading.ts
- src/city-gltf-streaming.ts
- src/city-graphics-quality.ts
- src/state.ts
- src/save.ts
- src/city-types.ts
- index.html
- vite.config.ts
- package.json

## PREGUNTAS (con evidencia `archivo:línea`)
1. Secuencia de boot: de `index.html` al primer frame renderizado. Listá los pasos ordenados.
2. Scene/render loop: dónde se crea el engine, qué render loop, qué switches de calidad existen.
3. Streaming: cómo se cargan/descargan assets de ciudad. Distancias, esquema de tiles/chunks, presupuestos, estrategia LOD. ¿El streaming es genérico o tiene forma de "ciudad densa"?
4. Formato de manifiesto: qué aporta `public/city/city.json` vs `landmark-detail.json`. Cómo se mergea en runtime.
5. Save/state: qué se persiste y dónde.
6. Tooling de performance ya presente (panel de calidad, hooks de benchmark, settings gráficos).
7. **Veredicto de reutilización por subsistema**: REUSE-AS-IS / REUSE-WITH-PARAMS / SHENZHEN-ONLY / REWRITE, con una línea de justificación cada uno.
8. Lista concreta de acoplamientos hard-codeados a Shenzhen en estos archivos (coords, nombres, ids, extensiones).
9. Qué necesitaría un terreno rural de 6×6 km + red viaria que esta arquitectura **NO** provee hoy (p. ej. heightfield de terreno con streaming vs plano de ciudad).

## CONSTRAINTS
- NO toques `/home/kiri_/projects/montes-de-oca`.
- Escribí ÚNICAMENTE `docs/audit/01-runtime-y-streaming.md`. Ningún otro archivo. Ningún cambio de código.
- Reporte denso y escaneable: secciones, tablas para el veredicto, bullets cortos. Reportá honestamente lo que NO pudiste determinar.

## DELIVERABLE
`/home/kiri_/projects/montes-de-oca-offroad/docs/audit/01-runtime-y-streaming.md`, cerrando con `## Confianza` (qué verificaste leyendo vs qué inferiste).

## VALIDATION
- El archivo existe y no está vacío.
- Cada veredicto de reutilización tiene ancla `archivo:línea`.
- En tu respuesta final: ruta, cantidad de líneas, top-5 candidatos a reutilizar, top-3 bloqueos para un juego rural off-road, y tu nivel de confianza.
