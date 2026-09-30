# Objetivo del proyecto — Montes de Oca Offroad

Este documento reúne el objetivo del juego y un backlog orientativo para mejorar la experiencia. Las reglas de trabajo activas están en `AGENTS.md`; consulta las guías pertinentes de `.agents/skills/`.

El objetivo es consolidar un videojuego 3D off-road convincente y jugable, ambientado en Villafranca Montes de Oca. Integra los sistemas existentes, conserva los controles y la arquitectura que funcionan, y prioriza cambios perceptibles y verificables sobre la incorporación de sistemas por sí misma.

Antes de iniciar una prioridad, inspecciona HEAD y comprueba si sigue pendiente. Esta lista es una guía revisable: no repitas trabajo ya resuelto ni presentes como hecho lo que no hayas verificado. Cualquier delegación, selección de herramientas y límite de agentes debe seguir `AGENTS.md` y las instrucciones activas del entorno; este documento no fija modelos ni cantidades de agentes.

Usa la documentación oficial de Babylon.js cuando una tarea dependa de sus APIs y contrasta los ejemplos con la versión instalada. Distingue datos observados, estimaciones y objetivos de rendimiento.

Las especificaciones de hardware y FPS que aparecen más abajo son objetivos orientativos, no resultados medidos; contrástalos con el dispositivo disponible antes de informar de rendimiento.

==================================================
ESTADO ACTUAL
==================================================

El proyecto ya NO es una maqueta inicial.

Está basado en:

Babylon.js 8
TypeScript
Vite

Ya existen:

- MDT05 georreferenciado;
- EPSG:25830;
- escala 1 unidad = 1 metro;
- tiles de terreno;
- ortofoto PNOA;
- red vial OSM;
- ROAD / TRACK / PATH;
- draping de vías;
- vegetación;
- más de 33.000 instancias;
- siete tipos de vegetación;
- pueblo de Villafranca;
- ~330 edificios;
- alturas OSM/LiDAR;
- fachadas;
- materiales;
- muros OSM;
- agua;
- río;
- sitios focales;
- vehículos múltiples;
- catálogo de vehículos;
- selector;
- luces de freno;
- motocicleta;
- minimapa;
- primera misión;
- objetivo repetidor;
- tests extensos.

NO rehagas estos sistemas desde cero.

==================================================
FUENTE DE VERDAD
==================================================

Leer antes:

AGENTS.md
OBJECTIVE.md

y:

.agents/skills/

Especialmente:

montes-oca-game-visuals

Consulta documentación oficial Babylon.js cuando sea necesario:

https://doc.babylonjs.com/

==================================================
MISIÓN DE ESTA PASADA
==================================================

Llevar el proyecto desde:

"mundo técnicamente avanzado"

a:

"vertical slice de videojuego convincente".

Prioridad:

GAMEPLAY + FEEL + VISUAL COHESION + PERFORMANCE.

No queremos añadir sistemas por añadir.

Queremos integrar y pulir lo que ya existe.

==================================================
FASE 0 — AUDITORÍA ACTUAL REAL
==================================================

Inspecciona HEAD actual.

Ejecuta:

npm run typecheck
npm run build
npm test

Ejecuta el juego real.

Captura:

- spawn;
- pueblo;
- carretera;
- pista;
- bosque;
- objetivo;
- vehículo;
- personaje/NPC;
- vista aérea.

Registra:

FPS
frame time
draw calls
active meshes
triangles
textures
shadow casters
JS heap

No uses datos históricos cuando puedas medir HEAD.

==================================================
PRIORIDAD P0 — INTEGRAR LA MISIÓN
==================================================

Revisar:

docs/gameplay/MISION.md

Actualmente las piezas de misión existen.

Comprobar si sigue pendiente integrar:

createRepeaterObjective(...)
createMission(FIRST_ROUTE)

en el runtime principal.

Completar el loop:

SPAWN
→ entrar al 4x4
→ misión ACTIVE
→ conducir al repetidor
→ TARGET_REACHED
→ bajar del coche
→ mantener E
→ REPAIRED
→ volver al vehículo
→ RETURNING
→ regresar a Villafranca
→ COMPLETED

Añadir feedback visual y UI mínimos.

Debe poder jugarse de inicio a fin sin consola.

==================================================
PRIORIDAD P1 — DESACOPLAR MAIN.TS
==================================================

src/main.ts ha crecido demasiado.

NO hacer big rewrite.

Extraer gradualmente responsabilidades.

Objetivo aproximado:

main.ts
 ├ GameBootstrap
 ├ WorldRuntime
 ├ RenderingRuntime
 ├ VehicleRuntime
 ├ CharacterRuntime
 ├ MissionRuntime
 ├ UiRuntime
 └ InputRuntime

Mantener comportamiento.

Cada extracción debe pasar tests antes de continuar.

==================================================
PRIORIDAD P1 — CHARACTER SYSTEM
==================================================

Ya existen assets humanos.

Audita:

assets/characters/

Incluye:

Kenney Animated Characters
Quaternius Universal Animation Library

Integrar un personaje humano riggeado real.

Debe soportar:

IDLE
WALK
RUN

Usar:

Skeleton
AnimationGroup
blending

Separar:

visual mesh
collider
state machine

Añadir:

ground alignment
heading
speed sync

Evitar foot sliding.

==================================================
NPC DE VILLAFRANCA
==================================================

Usar humanos reales, no placeholders.

Crear NPC ligeros.

Estados iniciales:

IDLE
WALK

Variar:

skin
speed
idle duration
route

Niveles de simulación:

NEAR:
animación completa

MID:
actualización reducida

FAR:
sleep

No introducir cientos todavía.

Crear primero 10-30 NPC convincentes.

==================================================
PRIORIDAD P1 — OFFROAD PHYSICS
==================================================

Auditar completamente el sistema actual de conducción.

Comprobar específicamente si persisten:

- física fundamentalmente 2D;
- grip casi constante;
- pendiente solo visual;
- superficie solo visual/audio.

Si sigue ocurriendo:

mejorarlo.

Introducir modelo simplificado pero perceptible:

surfaceGrip
rollingResistance
slopeForce
lateralGrip
brakeGrip
wheelSlip

Superficies:

ROAD
TRACK
PATH
GRASS
MUD
ROCK

El vehículo debe comportarse claramente diferente.

No buscar simulación extrema.

Buscar sensación off-road.

==================================================
SUSPENSIÓN VISUAL
==================================================

Calcular altura del terreno bajo cada rueda.

Usar cuatro muestras:

FL
FR
RL
RR

Derivar:

bodyHeight
pitch
roll
wheelCompression

Suavizar con damping.

Evitar vibración.

No mover visualmente el coche con senoides artificiales si puede derivarse del terreno real.

==================================================
VEHÍCULOS
==================================================

Los ocho modelos actuales ya existen.

NO crear más modelos hasta mejorar calidad de uso.

Auditar:

- escala;
- pivotes;
- materiales;
- ruedas;
- luces;
- brake lights;
- steering;
- rotation;
- suspensión;
- shadow.

Añadir efectos:

polvo
grava
hierba

solo ligados a superficie y velocidad.

==================================================
PISTAS OFFROAD
==================================================

Mejorar TRACK y PATH.

Actualmente la red real existe.

Añadir visualmente cuando sea seguro:

- rodadas;
- tierra;
- gravel;
- roughness variation;
- bordes irregulares;
- vegetación lateral;
- puddle/mud zones puntuales.

No modificar topología OSM.

==================================================
VEGETACIÓN 2.0
==================================================

La base actual de 33k instancias se conserva.

NO aumentar cantidad indiscriminadamente.

Mejorar distribución.

Añadir:

clustering por especie;
forest edge;
clearings;
river vegetation;
roadside vegetation;
village vegetation.

Evitar patrón procedural evidente.

Mantener thin instances.

Medir impacto.

==================================================
PUEBLO
==================================================

El pueblo ya tiene cantidad suficiente.

No generar más edificios por defecto.

Mejorar IDENTIDAD.

Priorizar landmarks:

- iglesia;
- plaza;
- edificios singulares;
- entrada de Villafranca;
- fuente;
- señales;
- mobiliario;
- ermita cuando corresponda.

Usar evidencia real siempre que exista.

No copiar geometría de Google Maps/Earth.

==================================================
RENDERING PASS
==================================================

Auditar:

PBR
environment
DirectionalLight
shadows
fog
tone mapping
exposure

Objetivo:

mejor separación:

FOREGROUND
MIDGROUND
BACKGROUND

Evaluar:

CSM
SSAO2
fog

solo si mejoran la escena.

Evitar bloom agresivo.

==================================================
STREAMING
==================================================

Verificar si los tiles:

se descargan realmente

o

solo se ocultan.

Medir memoria.

Si permanecen residentes innecesariamente:

implementar lifecycle:

LOAD_RADIUS
KEEP_RADIUS
UNLOAD_RADIUS

con hysteresis.

Evitar thrashing.

==================================================
AUDIO
==================================================

Crear primera pasada seria.

Vehicle:

engine rpm
load
gravel
dirt
grass
braking
impacts

Environment:

wind
birds
water
village ambience

Usar audio espacial donde tenga sentido.

==================================================
UI
==================================================

Conservar minimapa.

Añadir únicamente:

mission objective
distance
interaction prompt
repair progress
mission completion

HUD mínimo.

No saturar pantalla.

==================================================
PERFORMANCE
==================================================

Hardware target:

Ryzen 9 5900X
RTX 2070 8 GB
32 GB RAM

Objetivo HIGH:

60 FPS razonablemente estable a 1080p/1440p.

4K puede usar:

render scale
reduced shadows
LOD bias

Crear o revisar:

LOW
MEDIUM
HIGH
ULTRA

## Coordinación del trabajo

Divide una tarea solo cuando existan partes independientes y ownership claro. Mantén explícitos los archivos afectados, las restricciones, el resultado esperado y cómo se comprobará. Integra los cambios después de revisar su compatibilidad con el runtime y las reglas de `AGENTS.md`.

## Límites del proyecto

- No reescribas el terreno ni cambies la proyección sin una necesidad demostrada.
- No sustituyas datos reales por datos procedurales ni rehagas la topología OSM.
- No añadas sistemas, casas o vegetación sin una mejora clara y medible.
- No infles `src/main.ts` ni declares mejoras visuales o cifras de rendimiento sin verificarlas.
- Protege jugabilidad, controles, accesibilidad y coherencia del mundo.

## Criterio de finalización

Completa el flujo pertinente hasta donde permita el entorno: ejecuta el juego cuando sea posible, inspecciona el resultado desde vistas comparables y corre las comprobaciones del repositorio que correspondan. Informa de cambios, validaciones, evidencia visual o de rendimiento disponible y limitaciones concretas. Si una prioridad del backlog ya está resuelta, márcala como tal en vez de implementarla de nuevo.

## Orden orientativo para revisar el backlog

Tras comprobar qué sigue pendiente en HEAD, prioriza en este orden: integración del loop de misión; personajes y NPC; sensación de conducción y suspensión; superficies de pistas; distribución de vegetación; identidad del pueblo; renderizado; audio; y ciclo de vida de tiles. Cambia el orden cuando la evidencia o una dependencia lo justifique.

## Formato de entrega

Resume qué se implementó, el efecto observado en jugabilidad y presentación, las métricas disponibles, las pruebas ejecutadas, las regresiones y los siguientes pasos útiles. Separa resultados medidos de estimaciones y no afirmes verificaciones que no ejecutaste.

Cuando el trabajo sea una iteración de juego, organiza el informe bajo: IMPLEMENTADO, MEJORA VISUAL, MEJORA JUGABLE, RENDIMIENTO, TESTS, REGRESIONES, COMMITS y SIGUIENTES 3 PRIORIDADES. Omite afirmaciones para las que no haya evidencia.
