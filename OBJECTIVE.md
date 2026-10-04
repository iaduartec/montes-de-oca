# Objetivo del proyecto — Montes de Oca Offroad

Consolidar un juego off-road jugable en Villafranca Montes de Oca, conservando MDT05, PNOA, EPSG:25830, trazado OSM, controles y sistemas validados. Las reglas permanentes son `AGENTS.md`; las guías activas son `.agents/skills/`. Contrastar siempre este backlog con HEAD.

## Iteración Village Fidelity del 4 de octubre de 2026

Punto de partida real: HEAD `349d98494c1108060e6a0cf7f87f4803701c6a07` más trabajo local previo, preservado en `outputs/village-fidelity-20261004/baseline/local-before.patch`. Rama de integración: `feat/village-fidelity-20261004`. Los gates iniciales y los ocho gates finales de la geometría corregida están verdes; la misión real del build termina en COMPLETED con reparación a pie y retorno, sin errores de consola. También pasan las pruebas del actor de moto (giro, slalom, baja velocidad, frenada con giro, inclinación/recuperación y ROAD→TRACK), del peatón/vehículos en puentes secos y del vado húmedo con barro/drag. Los fixtures puntuales usan teleports explícitos; la misión recorre la polilínea. Evidencia: `outputs/village-fidelity-20261004/final-corrected/` y `gameplay/mission/drive_report.json`.

Se conserva el pueblo de 330 huellas, pilotos GLB, iglesia/plaza y runtime de actores. La auditoría fija veinte estructuras A, 59 B y 251 C, con distancias estimadas y límites explícitos de visibilidad. Se implementan overrides de cubierta para 818885706, 818885708, 474364245 y 474649085, y apariencia cálida de cubierta para el Antiguo Hospital 672017718. Las fuentes PNOA documentan planta/orientación y aspecto; no prueban detalles de fachada ni el ajuste completo de alas compuestas. Se conservan los datos de altura y los máximos de tejado previos. Los test de buffers del renderer comprueban recorte cóncavo, área, uniones con muros y pico.

Los kits compartidos aceptan una selección explícita por edificio/evidencia/arte antes del hash para representación procedural. Facade Kit V2 completo y nuevos GLB hero siguen pendientes de evidencia terrestre. El ledger se amplía conservando los seis bloqueos históricos. Las fotos locales tienen registro por SHA256, OSM/pose/autor/permiso; los valores desconocidos permanecen nulos y los píxeles no se distribuyen como texturas. No se incorporan imágenes ni geometría de Google.

Road V3 se continúa sobre el trabajo local existente con una corrección acotada de ponderación espacial en bordes comprimidos de cruce. La comparación aislada mide ROAD pavimento max grade 5.199446 → 0.703531 y p95 0.140370 → 0.140327. No acredita una corrección global: PATH conserva max 4.908211 y el faldón ROAD aumenta 0,16910 m en su tramo de corte (max grade 23,72929 → 32,42352). Las vistas emparejadas desde carretera no muestran una nueva grieta a 1280×720; el coste geométrico se conserva como límite, sin declarar READY global. Raw/render/contact se registran por separado en `outputs/village-fidelity-20261004/road-pair/`.

Los despachos reales, packets y revisiones constan en `orchestration/phase7/` y `workers.tsv`. OpenCode devuelve HTTP403 por disponibilidad regional; no se identificó una interfaz invocable de WorkBuddy AI. Se delegó mediante GPT-6 Luna, sin presentar esos despachos como trabajo de los proveedores bloqueados. Las capturas comparables del pueblo usan SwiftShader. Una medición separada en Windows Chrome identifica la RTX 2070 vía ANGLE D3D11, pero la comparación FPS de esta iteración queda BLOCKED_COMPARISON: pausas de rAF y deriva de cámara invalidan el par. Las muestras diagnósticas y el rechazo explícito quedan en `outputs/village-fidelity-20261004/gpu/` y `review/gpu-acceptance.md`. Las cámaras libres excluyen actores/NPC y no representan el coste de misión completa. Los ocho gates pasan también desde el commit `4c7d7ac` en un checkout aislado y diez hashes de runtime coinciden con las capturas/gameplay. La aceptación de los cinco objetivos pasa 220 checks; el gate global de estructuras reales falla siete por evidencia histórica pendiente, sin declarar cerrada la Definition of Done.

## Estado histórico comprobado el 1 de octubre de 2026

Baseline: `caef87e`. Babylon core/loaders 8.56.2. Pasaron typecheck, build, npm test, runtime, road-surface, water-contact y motorcycle antes de modificar código.

Ya implementado; conservar y verificar ante cambios:

- Misión integrada: conducir al repetidor, reparar y regresar; HUD y minimapa.
- ROAD/TRACK/PATH/GRASS/MUD/ROCK, respuesta centralizada y física off-road.
- Suspensión de cuatro contactos, presets de calidad, cola cooperativa por frame.
- Lifecycle GPU de tiles con histéresis; datos CPU y atlas compartido conservados.
- Polvo con pool, audio procedural por superficie, ambiente e impactos.
- Personaje Kenney con Idle/Walk/Run y NPC con simulation tiers.
- Catálogo de ocho vehículos, selector y luces de freno; un GLB de vehículo de runtime. El catálogo no demuestra ocho assets finales.
- Agua/vados, contacto 3D, carreteras sobre agua secas, estabilidad y recuperación asistida de moto.

## Iteración Road Geometry V3

La normal de conducción limitada del baseline no probaba la corrección del pavimento. La iteración introduce perfiles por estación, banking por clase, cortes/rellenos locales, transición lateral y reconciliación local de cruces. El renderer sustrae únicamente la huella de calzada/faldones del MDT visible, conservando alturas CPU y los atributos PNOA de los fragmentos exteriores. Son perfiles de diseño sobre el MDT, no rasantes topográficas levantadas. Conservar puentes lineales y las anchuras/recortes OSM.

El diagnóstico distingue RAW TERRAIN, RENDERED ROAD GEOMETRY y DRIVING SURFACE, con percentiles, histogramas y puntos extremos. La evidencia y el estado de aceptación se registran en `outputs/road-v3-20261001/`; no declarar cerrados extremos sin revisar las métricas finales y las capturas.

Mejoras adicionales: detalle artístico por vertex color en TRACK/PATH y extracción pequeña de motor/escena/cámara a `src/runtime/rendering-runtime.ts`. No sustituir la state machine ni ampliar la población o la geometría por defecto.

## Backlog válido

La prioridad actual es continuar la fidelidad de iglesia/plaza/Calle Mayor con fotos terrestres asociadas, resolver las cubiertas compuestas aún aproximadas y cerrar los extremos PATH/faldones con métricas y capturas. El Hospital solo tiene apariencia corregida; su masa compuesta sigue bloqueada. Después:

1. Resolver las discontinuidades y solapes viales que permanezcan en las métricas finales. Revisar pavimento, hombros, contacto y normal por separado; preservar pendientes reales y trazado OSM.
2. Terrain Material V2: evaluar micro-normal, roughness y detalle con fade de distancia sin reemplazar PNOA. Diagnóstico independiente de manchas claras mediante aislamiento de ortofoto, luz, sombras, vías, agua, vegetación y detalle. No corregir sin causa reproducible.
3. Character Art V2: buscar proporciones/ropa humana rural apropiadas en assets legales, manteniendo collider, animaciones y runtime. Kenney funciona; no presentarlo como un upgrade naturalista.
4. Vegetation Distribution V2: reubicar el inventario existente por bosque/borde/seto/campo/ribera/valle/vía/pueblo; comparar vistas aéreas sin aumentar significativamente el conteo.
5. Auditar sombras en HEAD por casters, tiers, distancia y captura concreta. No usar las cifras históricas de 10/65 como presupuesto.
6. Clasificar cada vehículo FINAL / ACCEPTABLE STYLIZED / PLACEHOLDER con evidencia visual y licencia por asset; priorizar vehículos seleccionados por el jugador.
7. Continuar extracciones de `main.ts`, una frontera por iteración. Tras cada una: tipos, pruebas específicas, build, npm test y runtime.
8. Tras varias extracciones, medir bundle/startup y lazy-load solo contenido opcional; no crear chunks artificiales. Baseline initial index: 2,304.06 kB / 592.56 kB gzip (Vite), no tiempo de primera jugabilidad.
9. Completar evidencia geográfica pendiente de estructuras reales, sin geometría ni imágenes de Google.

## GPU objetivo y validación

RTX 2070 8 GB, Ryzen 9 5900X, 32 GB; HIGH a 1920×1080 y 2560×1440 en village/road/track/forest/aerial. Medir frame time p50/p95/p99, FPS, draw calls, triángulos, meshes, texturas y heap. En la iteración histórica del 1 de octubre se registró ANGLE D3D11 sobre la RTX 2070 desde Chrome Windows; esa medición no valida los cambios del 4 de octubre. Las mediciones de cámara libre excluyen actores/NPC por el bootstrap existente: no equivalen al presupuesto de juego completo. SwiftShader solo permite comparar geometría/capturas y costes indirectos.

Gates de cada cambio transversal: `npm run typecheck`, `npm run build`, `npm test`, `npm run test:runtime`, `npm run test:road-surface`, `npm run test:water-contact`, `npm run test:motorcycle`. Añadir misión real, moto/agua y cámaras iguales; revisar imágenes y consola. Los tests de harness no sustituyen un recorrido humano ni medición de GPU real.

## Orquestación de esta fase

Usar `orchestration/ORQUESTADOR-PRINCIPAL.md` como metaprompt activo y `orchestration/MODEL_POOL.md` como política de despacho: GPT-6.1 Sol coordina e integra; GPT-6 Luna analiza y revisa; OpenCode implementa; WorkBuddy AI + DeepSeek V4.1 Flash tiene prioridad para tareas mecánicas y aisladas con acceso gratuito confirmado en la cuenta del usuario. No equiparar esa vía al proveedor de DeepSeek en OpenCode.

Mantener un writer por archivo, packets autocontenidos y despachos reales en `orchestration/workers.tsv`. El backlog válido de este documento sustituye los planes históricos de fases anteriores; comprobar el estado actual antes de asignar trabajo. Los roles no permiten omitir los gates ni cambiar gameplay fuera del alcance autorizado.
