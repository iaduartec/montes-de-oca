# Reglas de desarrollo para juegos Babylon.js

Estas reglas se aplican al trabajo en este juego. Conserva la arquitectura, jugabilidad, controles y navegadores compatibles, salvo que la tarea indique lo contrario.

## Fuentes de verdad del proyecto

- `AGENTS.md` define las reglas permanentes de trabajo para este repositorio.
- `OBJECTIVE.md` define el objetivo del proyecto y su backlog; sus prioridades deben contrastarse con HEAD y no pueden contradecir estas reglas.
- `.agents/skills/` contiene las guías especializadas activas. Consulta solo las pertinentes para cada tarea.
- `outputs/babylon-game-overhaul-kit/` es un artefacto histórico de distribución. No lo uses ni lo trates como configuración activa de agentes; la configuración vigente está en los tres elementos anteriores.

## Coordinación de agentes

- La política de roles, modelos y vías de ejecución está en `orchestration/MODEL_POOL.md`; el prompt activo es `orchestration/ORQUESTADOR-PRINCIPAL.md`. Ambos complementan estas reglas, sin revocarlas.
- Un único writer por archivo, incluidos reportes, logs y archivos generados. Cada packet declara rutas exactas, dependencias, restricciones y verificaciones; no se despacha si hay ownership solapado.
- Solo el orquestador escribe el registro `orchestration/workers.tsv`, integra archivos compartidos y realiza commits. Los workers no hacen commit, no limpian el árbol y no revierten cambios ajenos.
- Inspecciona `git status` antes de editar y antes de commit. Si un archivo cambia desde la lectura inicial, detén esa edición y concilia el diff con su dueño; no lo sobrescribas.
- Registra solo despachos reales, conservando el historial. Un packet preparado no prueba que un worker se haya ejecutado. Quien implementa no revisa su propio resultado; el orquestador reproduce la validación antes de ACCEPT / FIX / REVERT.

## Antes de cambiar código

- Inspecciona el repositorio, los scripts del proyecto, la versión instalada de Babylon.js, el motor de renderizado, la gestión de escenas y el flujo de assets. Considera autoritativos la versión instalada y las convenciones del proyecto; contrasta las API actuales con la [documentación oficial de Babylon.js](https://doc.babylonjs.com/).
- Ejecuta el juego e inspecciona la escena real cuando sea posible. Registra el estado inicial de las escenas afectadas para poder comparar los cambios visuales.
- Identifica los problemas de mayor impacto, clasifica cada sistema afectado como **CONSERVAR**, **MEJORAR**, **REFACTORIZAR** o **REEMPLAZAR** y después implementa la mejora elegida. No termines tras una auditoría o una lista de recomendaciones.
- Consulta las skills específicas de `.agents/skills/` cuando sean pertinentes. Lee solo las necesarias para la tarea.

## Criterios de calidad

- Los coches deben reconocerse como vehículos y las personas como personajes humanos, con proporciones, silueta, escala, materiales y animación coherentes. Las formas primitivas sirven para prototipos y colisionadores, pero no deben presentarse como arte final.
- Para modelos complejos, prioriza assets GLB/glTF adecuados y verificados. Comprueba licencia, procedencia, escala, orientación, jerarquía, materiales, texturas, esqueleto, animaciones y coste en ejecución antes de integrarlos. No inventes assets, licencias ni disponibilidad. Si falta un asset adecuado, explica qué hace falta y mejora la presentación dentro de lo que permita el modelo actual sin fingir que las primitivas son arte terminado.
- Usa materiales PBR con mapas apropiados y tratamiento correcto del espacio de color; añade una textura de entorno útil para los materiales reflectantes. Diseña conjuntamente iluminación, sombras, exposición y cámara. Añade postprocesado solo cuando mejore visiblemente el resultado y quepa en el presupuesto de rendimiento.
- Mejora el mundo como una escena coherente: terreno, carreteras, edificios, vegetación, objetos, atmósfera, variedad de superficies, escala, colisiones y puntos de referencia. Evita patrones repetidos evidentes y objetos flotantes o que se atraviesen.
- La animación debe corresponder al movimiento y la intención. Selecciona, mezcla y libera los clips importados deliberadamente; evita el deslizamiento visible de los pies o el desplazamiento involuntario.
- Protege la jugabilidad, la accesibilidad, la lectura de las siluetas y la respuesta de los controles mientras mejoras la calidad visual.

## Rendimiento e implementación

- Mide antes de optimizar. Cuando sea posible, registra tiempo por fotograma, draw calls, meshes activos, triángulos, memoria de texturas, carga y dispositivo objetivo. Compara la misma escena y cámara antes y después.
- Usa LOD, instancias o thin instances solo cuando encajen; comprueba el resultado visual, sombras, picking, colisiones y animación. No sacrifiques detalle cercano ni corrección por una optimización no medida.
- Reutiliza el stack y los componentes compartidos. Evita dependencias nuevas salvo necesidad clara. Carga, almacena y libera assets y recursos según las convenciones existentes.
- Mantén los cambios acotados y tipados. Gestiona con claridad la carga, los assets ausentes y los errores de ejecución; no ocultes fallos con alternativas silenciosas.

## Verificación y entrega

- Usa los comandos definidos por el repositorio y su CI. Tras los cambios, ejecuta los chequeos pertinentes de lint, tipos, pruebas y build; corrige los fallos causados por la tarea.
- Verifica visualmente las escenas modificadas a distancias representativas y en los tamaños de pantalla objetivo cuando sea posible. Compara capturas tomadas desde la misma cámara y con los mismos ajustes. Indica si no se pudo hacer una comprobación visual.
- Resume los cambios implementados, archivos afectados, comprobaciones y resultados, evidencia de rendimiento medido y limitaciones de assets o del entorno. Distingue lo observado de lo estimado. No afirmes resultados visuales, de rendimiento o de ejecución sin evidencia.

## Referencias oficiales

Empieza en la [documentación de Babylon.js](https://doc.babylonjs.com/) y sigue las páginas correspondientes a la versión del proyecto para materiales, texturas de entorno, luces y sombras, importación GLB/glTF, animación, LOD, instancias e Inspector. Las API cambian: no uses ejemplos de memoria si la versión instalada difiere.
