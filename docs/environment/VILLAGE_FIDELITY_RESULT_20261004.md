# Village Fidelity — resultado del 4 de octubre de 2026

Integración local en `feat/village-fidelity-20261004`, desde `349d984` más el trabajo local preservado. Se aceptan cuatro correcciones de cubierta y una mejora de apariencia; la Definition of Done global sigue abierta. No se publica ni se reescribe el historial. El estado previo está conservado en [local-before.patch](../../outputs/village-fidelity-20261004/baseline/local-before.patch).

## IMPLEMENTADO

Overrides tipados antes de heurísticas, cubiertas recortadas dentro de polígonos OSM cóncavos, uniones continuas entre muro y cubierta, conservación del máximo anterior al girar cumbreras, soporte de kits explícitos y pruebas de buffers reales del renderer. Se mantienen pilotos GLB, iglesia/plaza, coordenadas, huellas, alturas y sistemas de actores. Se integra el trabajo Road V3 previo junto con una corrección acotada de cruce. Se añaden inventario, registro de fotos y cámaras reproducibles; se corrige la aceptación prematura de capturas con cero geometría.

## VILLAGE FIDELITY

[Auditoría y ranking](VILLAGE_FIDELITY_AUDIT.md): 330 edificios, veinte TIER A, 59 B y 251 C. La clasificación usa distancia y relevancia de recorrido; no simula una prueba completa de oclusión. Los veinte héroes están clasificados, no veinte modelos específicos terminados. Iglesia y plaza se capturan y conservan; esta entrega no afirma una nueva reconstrucción de sus volúmenes.

## ESTRUCTURAS MEJORADAS

| OSM | Cambio aceptado | Evidencia y límite |
|---|---|---|
| 818885706 | Cubierta a dos aguas, cumbrera N–S y unión continua a muros | PNOA/huella OSM; pendiente aproximada, máximo anterior conservado |
| 818885708 | Cubierta a cuatro aguas | Extremos observados en PNOA; ajuste completo de volúmenes secundarios probable |
| 474364245 | Cubierta a cuatro aguas | PNOA/OSM; alas compuestas aún aproximadas |
| 474649085 | Cumbrera N–S, cubierta recortada y pico conservado | PNOA/OSM; no medición nueva de altura absoluta |
| 672017718, Antiguo Hospital | Aspecto de teja cálida | ACCEPT_APPEARANCE_ONLY: la cubierta compuesta y acristalamiento siguen bloqueados |

310174514 se mantiene como control sin override. El [ledger](../../assets/environment/real-structures/evidence.json) conserva las once entradas anteriores, registra estas cinco y mantiene seis bloqueos históricos. La precedencia edificio → evidencia → artístico → hash está disponible para el renderer procedural; no se ha inventado un registro terrestre de fachadas ni completado Facade Kit V2.

## FUENTES / LICENCIAS

OSM, ODbL 1.0, snapshot del 25 de septiembre de 2026; PNOA/IGN-CNIG WMS, CC BY 4.0 según sus capacidades; alturas IGN MDSnE existentes conservadas. Fecha de consulta PNOA: 4 de octubre; año de vuelo desconocido. Referencias y parámetros quedan en [references](../../outputs/village-fidelity-20261004/references/). No se incorporan imágenes, geometría ni texturas de Google.

Nueve fotos locales válidas están registradas por SHA256 en [user-photos.json](../../assets/environment/real-structures/user-photos.json); ocho aún sin localizar y la foto de iglesia asociada a 90614388. Autor, permiso, fecha y pose desconocidos permanecen nulos. Un JPEG inválido se rechaza sin borrar el original. [Flujo de asociación](USER_PHOTOS.md). No se entregan nuevos GLB ni nuevos assets de terceros.

## MEJORA VISUAL

Veintiuna vistas BEFORE/AFTER con HIGH, FOV 0,8, 1280×720 y posición/objetivo iguales: spawn, dos Calle Mayor, plaza, iglesia, entradas, pilotos, carretera, pista, bosque, río, actor/NPC, aérea, cinco objetivos y control. El [informe de comparación](../../outputs/village-fidelity-20261004/review/village-comparison.json) registra origen por vista y hashes de fuente; [revisión independiente](../../outputs/village-fidelity-20261004/review/village-final-review.md).

Las capturas fallidas quedan fuera de la aceptación. Las cámaras libres excluyen al jugador/vehículo; spawn nativo y el catálogo sí prueban esos actores. La corrección elimina huecos de unión y mejora las siluetas indicadas; no demuestra fidelidad completa de todas las fachadas ni del Hospital.

## ROAD GEOMETRY

La comparación aislada mantiene idénticos datos y helpers y cambia solo `road-draping.ts`. Se miden RAW TERRAIN, pavimento/faldón renderizados y contacto por separado, con p50/p90/p95/p99/max, histogramas y puntos extremos: [métricas](../../outputs/village-fidelity-20261004/road-pair/review.md), [capturas](../../outputs/village-fidelity-20261004/road-visual-pair/review.md).

ROAD pavimento max grade: **5,199446 → 0,703531**; p95 **0,140370 → 0,140327**; p99 0,211310 → 0,211650. CrossSlope p95 0,079961 → 0,079964, max 0,265694 sin cambio. TRACK max 0,764083 y PATH max 4,908211 permanecen. No se limita solo la normal física: cambian alturas Y del mesh en bordes comprimidos del cruce 548355745, con XZ y puentes conservados.

Coste explícito: el faldón vecino aumenta 0,16910 m de altura de corte; su max grade pasa de 23,729290 a 32,423515. Dos cámaras comparables muestran el pavimento y borde, sin grieta nueva discernible a 1280×720; una vista oblicua tapada se rechaza. **ACCEPT acotado al pavimento del cruce; red completa sin READY.**

## MOTOS

Sin reimplementación. Build real: giro suave/fuerte, slalom, baja velocidad, frenada con giro, ROAD→TRACK y puentes secos pasan, sin caída normal y con recuperación de verticalidad. El catálogo conduce las dos motos con inclinaciones 0,646/0,623 rad y parada vertical; las pruebas unitarias mantienen recuperación tras caída. [Gameplay](../../outputs/village-fidelity-20261004/gameplay/road-v3/extended-gameplay.json).

## AGUA

Puentes DRY para peatón/coche/moto; vado WET/MUD con drag; ocho contactos de puente correctos, alturas y borde comprobados. El deck superior no recibe drag de agua. [Contacto](../../outputs/village-fidelity-20261004/gameplay/water-contacts/water_contacts_report.json), [recorrido](../../outputs/village-fidelity-20261004/gameplay/water-gameplay/water_gameplay_report.json).

## RENDIMIENTO

Mismas draw calls, meshes activos y texturas en las veintiuna vistas. Spawn nativo: 196 draw calls, 101 meshes, 42 texturas antes/después; triángulos 1.931.470 → 1.933.730 y vértices 1.311.573 → 1.314.179. Diecinueve cámaras diagnósticas y NPC: +1.130 triángulos y +2.606 vértices. Incluye la nueva teselación general de cubiertas, no solo cinco overrides. El cruce cambia Y sin aumentar triángulos. No se presentan FPS de SwiftShader como rendimiento hardware.

RTX 2070 confirmada mediante ANGLE D3D11 en Windows Chrome, pero la comparación queda **BLOCKED_COMPARISON**. El AFTER 1080p del intento emparejado tiene 71 frames en unos 84,6 s y una pausa enorme; el AFTER 1440p tiene rAF positivo pero la imagen apunta hacia abajo, con 44 draw calls/40 meshes frente a 53/51 del BEFORE. La cámara real cambió aunque el metadata repetía la pose esperada. Se rechazan ambos pares; otras muestras son diagnósticas, sin afirmar delta FPS ni ausencia de regresión GPU. [Revisión de aceptación](../../outputs/village-fidelity-20261004/review/gpu-acceptance.md). Las cámaras libres sin actores/NPC no equivalen a misión completa.

## TESTS

Ocho gates del working tree final pasan: typecheck, build, npm test, runtime, road-surface, water-contact, motorcycle y village-fidelity. [Resultados](../../outputs/village-fidelity-20261004/final-corrected/gates.tsv). El validador de aceptación de esta fase pasa 220 checks. Misión del build: COMPLETED, 28/28, 175,5 s simulados, reparación a pie y regreso, siete capturas, cero errores de consola; [reporte](../../outputs/village-fidelity-20261004/gameplay/mission/drive_report.json). Es recorrido automatizado del actor real, no una sesión humana ni benchmark FPS.

Los mismos siete gates principales y `test:village-fidelity:final` pasan también desde el commit `4c7d7ac` en un worktree aislado: [gates de HEAD](../../outputs/village-fidelity-20261004/final-corrected/committed-gates.tsv). Diez hashes de runtime coinciden exactamente con las capturas/gameplay y el HEAD integrado: [manifest](../../outputs/village-fidelity-20261004/final-corrected/committed-source-manifest.json). El gate global `test:real-structures:final` **falla siete checks** por capturas históricas ausentes y seis bloqueos previos: [estado](../../outputs/village-fidelity-20261004/final-corrected/global-evidence-final.tsv). No se elimina ese gate ni se declara release completa.

## REGRESIONES

Misión, moto, agua y catálogo sin regresión detectada en sus fixtures. El catálogo usa los ocho vehículos y vuelve a los mismos recursos tras switches; [resultado](../../outputs/village-fidelity-20261004/vehicle-catalog-final/vehicle_catalog.json). Un vehículo ACCEPTABLE STYLIZED, siete PLACEHOLDER, ninguno FINAL; el GLB genérico compartido no prueba marca real ni ocho assets distintos. NPC conserva placeholder/animaciones y runtime existente.

Límites abiertos: faldón más alto y PATH discontinuo, Hospital compuesto, Facade Kit V2 completo, GLB específicos y evidencia histórica. Se preservan los cambios locales ajenos al alcance; no se borran ni se añaden automáticamente al commit.

## COMMITS

- `ea5b4cb` — overrides y geometría de cubiertas con pruebas.
- `f234cbc` — readiness de captura y contrato de giro normal de moto.
- `9999063` — integración del trabajo Road V3 previo y corrección acotada del cruce.
- `67502e6` — evidence, auditoría, fotos y tooling reproducible.
- `4c7d7ac` — capturas comparables y evidencia de aceptación.
- `92054d4` — harnesses reproducibles de moto, agua y Road V3, conservando checks existentes.

El cierre documental y la comparación GPU se incorporan después de esta lista; consultar `git log` para sus hashes.

## SUBAGENTES

GPT-6 Luna realizó auditoría de pueblo/vías, implementación acotada, revisión cruzada, capturas, correcciones y validación de gameplay/GPU. Ownership y packets: [workers.tsv](../../orchestration/workers.tsv), [phase7](../../orchestration/phase7/). Sol coordina, decide e integra. OpenCode devolvió HTTP403 por disponibilidad regional; WorkBuddy no tuvo interfaz invocable. Estos proveedores quedan bloqueados, sin despachos ficticios ni fallback externo de pago.

## SIGUIENTES 3 PRIORIDADES

1. Resolver cubierta compuesta del Hospital y volúmenes de iglesia/Calle Mayor con evidencia terrestre asociada y PNOA; cerrar huecos del ledger histórico.
2. Resolver discontinuidad PATH y faldón del cruce con medición directa y cámaras iguales, conservando trazado OSM/contactos/agua; cerrar benchmark RTX con pose real y rAF verificados.
3. Conectar overrides de fachada respaldados por fotos y completar Facade Kit V2; después elegir GLB hero y assets humanos/vehículos con procedencia verificable.
