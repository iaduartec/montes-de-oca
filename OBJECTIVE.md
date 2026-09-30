# Objetivo para el orquestador: mejorar el juego Babylon.js existente

Trabaja en el juego actual de este repositorio. Sigue `AGENTS.md` y consulta solo las skills pertinentes de `.agents/skills/`. Usa la documentación oficial y actual de Babylon.js en https://doc.babylonjs.com/; comprueba que cada API y ejemplo corresponde a la versión instalada.

## Misión

Eleva la calidad visual y técnica de la implementación existente sin romper la jugabilidad, los controles ni la arquitectura que ya funciona. El cambio debe apreciarse en el juego ejecutándose. No entregues solo una auditoría, hoja de ruta, maqueta o sugerencias: diagnostica, prioriza, implementa las mejoras factibles de mayor impacto y verifícalas.

El objetivo es un videojuego 3D coherente donde los coches se lean como coches, las personas como personajes humanos y el mundo tenga profundidad, iluminación, materiales, escala y movimiento convincentes. Si los modelos actuales no permiten ese resultado, identifica la limitación del asset con precisión e integra uno adecuado que ya esté disponible cuando la licencia y el acceso al repositorio lo permitan. No afirmes que unos retoques de código convierten geometría inadecuada en arte final.

## Secuencia de trabajo

1. **Descubre el proyecto.** Inspecciona estructura, `AGENTS.md`, scripts y lockfile, versión de Babylon.js, motor/backend, arquitectura de escenas y jugabilidad, carpetas y licencias de assets, pruebas, build/CI y documentación actual. No des por supuesto el framework, motor de físicas, estilo artístico o hardware objetivo si el proyecto no lo establece.
2. **Ejecuta y observa el estado inicial.** Arranca el juego con el comando documentado por el repositorio. Juega o recorre la escena afectada. Toma capturas representativas o usa las herramientas de navegador disponibles. Anota dispositivo/navegador, resolución, backend, defectos visibles, errores de consola/red y métricas de rendimiento observables. Si no puedes ejecutar o inspeccionar visualmente el juego, indica exactamente qué lo impide y continúa con la evidencia del código, sin llamar a eso una verificación visual.
3. **Prioriza.** Enumera los defectos más importantes para el jugador junto con su riesgo. Clasifica los sistemas afectados como **CONSERVAR**, **MEJORAR**, **REFACTORIZAR** o **REEMPLAZAR**, con una razón breve. Elige una primera mejora coherente, acotada y comprobable que preserve la jugabilidad existente.
4. **Consulta la documentación adecuada.** Usa las páginas oficiales pertinentes para renderizado/PBR y texturas de entorno; iluminación y sombras; carga GLB/glTF; grupos de animación y personajes; geometría del mundo; LOD e instancias/thin instances; rendimiento e Inspector/depuración. Comprueba que los ejemplos correspondan a la versión instalada. Añade enlaces de referencia a las notas o al informe final cuando ayuden.
5. **Implementa.** Sigue las convenciones del proyecto. Prioriza según el contexto: (a) assets y proporciones reconocibles para vehículos y personajes; (b) mapas PBR e iluminación de entorno correcta; (c) luz, sombras, composición de cámara, escala y profundidad; (d) animación y sensación de movimiento de personajes/vehículos; (e) carreteras, terreno, edificios, vegetación y objetos coherentes; (f) optimización de carga/renderizado basada en mediciones. Integra assets GLB/glTF solo después de comprobar procedencia/licencia, escala, orientación, jerarquía, materiales, texturas, rig/animación y coste en ejecución. Conserva jugabilidad, rutas, controles y colisiones. No añadas dependencias sin necesidad clara.
6. **Mide y optimiza.** Cuando sea posible, registra valores antes y después bajo la misma escena, cámara, dispositivo, backend y resolución: tiempo por fotograma/FPS, draw calls, meshes activos, triángulos, memoria de texturas y tiempo de carga. Considera LOD e instancias/thin instances en assets apropiados; luego comprueba transiciones, sombras, picking, colisiones, animación y variación visual. No afirmes cifras sin medirlas.
7. **Verifica el resultado.** Ejecuta el juego modificado y recorre la jugabilidad afectada. Compara antes/después desde las mismas vistas y revisa distancias cercanas, medias y lejanas, además del movimiento/iluminación pertinentes. Ejecuta los comandos definidos por el repositorio para lint, tipos, pruebas y build que correspondan. Inspecciona errores y corrige las regresiones que causaste. No afirmes comprobaciones que no ejecutaste.
8. **Informa del resultado.** Resume qué mejoras implementaste y qué causas observadas resuelven; enumera archivos modificados; informa comandos y resultados; incluye evidencia visual/de rendimiento y condiciones del dispositivo; identifica assets ausentes, comprobaciones bloqueadas y limitaciones pendientes. Separa los hechos medidos de las estimaciones. Menciona el siguiente problema de mayor impacto solo si resulta útil.

## Resultados prioritarios

- Los coches tienen silueta, proporciones, carrocería, cabina, cristales, ruedas, luces y materiales legibles a las distancias reales de juego.
- Las personas tienen proporciones y silueta humanas, un modelo riggeado adecuado, materiales legibles, contacto con el suelo y animaciones apropiadas. Los clips importados se seleccionan y mezclan según las animaciones que realmente existen.
- Las superficies PBR responden coherentemente a una iluminación de entorno útil. La luz y las sombras revelan las formas sin artefactos graves ni coste desmedido.
- El mundo mantiene escala y variedad consistentes; carreteras, terreno, edificios, vegetación y objetos mejoran navegación y atmósfera.
- La cámara y su movimiento hacen que el juego sea legible y responda bien.
- Las optimizaciones se miden y conservan el comportamiento visual y de juego necesario. LOD, instancias y reducción de texturas se basan en evidencia.

## Criterio de finalización

La tarea termina cuando se han implementado cambios para las mejoras seleccionadas de mayor impacto y se han ejecutado las comprobaciones pertinentes, o cuando un bloqueo externo concreto (por ejemplo, falta un modelo con licencia adecuada o no está disponible el entorno de ejecución) queda documentado junto con el trabajo y la evidencia obtenida. El análisis por sí solo no es completar la tarea.
