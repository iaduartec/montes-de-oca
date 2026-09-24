# TASK PACKET W3 — Auditoría de conducción, jugador y física

## Estándares del proyecto (auto-resueltos)
- El repo de referencia `/home/kiri_/projects/montes-de-oca` es **READ-ONLY**. No lo modifiques.
- Build exitoso NO es validación. Citá `archivo:línea` en cada afirmación. Si no se sabe, `UNKNOWN`. NUNCA inventes.
- Escribí la salida en **español** técnico.
- Si descubrís algo importante, guardalo en engram con `mem_save` y `project: "montes-de-oca"` antes de terminar.

## Contexto
- El repo de referencia es **GTA_SZ / 深城纪**: Babylon.js 8 + TypeScript + Vite, ciudad de Shenzhen. Ya tiene conducción arcade, tráfico NPC, autopilot, peatones y vista de cabina.
- Juego nuevo: **"Montes de Oca: Offroad Stories"** — open world rural **OFF-ROAD** en Villafranca Montes de Oca (Burgos). El MVP es: aparecer → conducir un 4x4 por asfalto → doblar a una pista forestal → subir los Montes de Oca → llegar a un objetivo → interactuar → volver. El terreno es DEM real (¡con pendientes!). Superficies: ASPHALT / GRAVEL / DIRT / GRASS. Conducir fuera de ruta tiene que ser divertido.
- Raíz del proyecto nuevo: `/home/kiri_/projects/montes-de-oca-offroad`

## GOAL
Auditar **conducción, jugador, física de vehículo y tráfico AI** y escribir `docs/audit/03-conduccion-jugador-fisica.md`. Sé brutalmente específico sobre si la física actual puede con pendientes, laderas y superficies sueltas.

## FILES
- src/driving.ts            (paso de vehículo + colisión)
- src/traffic.ts            (autos NPC)
- src/navigation.ts         (grafo vial)
- src/city-autopilot.ts     (grande — leelo en secciones)
- src/city-walk.ts
- src/city-rider.ts
- src/city-vehicle-manifest.ts
- src/city-vehicle-materials.ts
- src/city-cockpit.ts
- src/city-vehicle-finish.ts

## PREGUNTAS (con evidencia `archivo:línea`)
1. El modelo de vehículo: ecuaciones exactas en `stepCar` (src/driving.ts). ¿Entradas, estado, constantes? ¿Timestep fijo? ¿Substepping?
2. **¿Hay gravedad, pendiente o término de pitch/roll?** ¿Al auto le importa la altura del terreno, o es un modelo 2D sobre un plano? Citá las líneas que prueban tu respuesta. ESTA ES LA PREGUNTA MÁS IMPORTANTE.
3. Modelo de agarre / superficie: ¿hay fricción por superficie? ¿Dónde se elige la superficie (mirá también src/city-road-surface.ts si hace falta para responder)? ¿Qué tan difícil sería agregar ASPHALT/GRAVEL/DIRT/GRASS?
4. Colisión: ¿cómo funciona `CityCollision`? ¿Maneja edificios/agua/bordes de tierra? ¿Qué se rompe en un mapa rural sin edificios?
5. Altura/snap: ¿cómo obtiene el auto su Y? ¿Dónde se aplica `heightAt` / el offset de superficie (dentro de `stepCar` o fuera)? Citalo.
6. Grafo vial + AI: ¿cómo se arman nodos/aristas desde los datos viales (src/navigation.ts)? ¿El tráfico NPC puede funcionar en pistas rurales o asume topología urbana densa?
7. Controles y cámara del jugador: qué existe hoy (cabina, caminar, salir del vehículo). Dónde se bindea el controlador.
8. **Veredicto de reutilización** por subsistema: REUSE-AS-IS / REUSE-WITH-PARAMS / REWRITE, con justificación.
9. **Análisis de huecos para off-road**: enumerá exactamente qué hay que construir para un 4x4 creíble en una pista de tierra empinada (fuerza por pendiente, gravedad a lo largo de la ladera, pitch/roll visual, suspensión, contacto de ruedas, torque en reducida, fricción por superficie, polvo, riesgo de vuelco). Para cada uno: ¿existe algo en el repo sobre lo que construir?

## CONSTRAINTS
- NO toques `/home/kiri_/projects/montes-de-oca`.
- Escribí ÚNICAMENTE `docs/audit/03-conduccion-jugador-fisica.md`. Ningún otro archivo.
- Citá líneas de código reales (snippets cortos) como evidencia — este doc tiene que ser confiable.
- Conciso y denso. Reportá lo que no pudiste determinar.

## DELIVERABLE
`/home/kiri_/projects/montes-de-oca-offroad/docs/audit/03-conduccion-jugador-fisica.md`, cerrando con `## Confianza`.

## VALIDATION
- El archivo existe y no está vacío.
- La pregunta 2 (gravedad/pendiente) respondida con un snippet de código citado, sin ambigüedad.
- En tu respuesta final: el modelo de vehículo en 3 líneas, la lista de huecos off-road, y confianza.
