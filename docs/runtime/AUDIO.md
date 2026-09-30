# Audio V2 — ambiente e impactos

## Uso

`Sonido: sí/no` controla motor, rodadura, viento, llamadas sintetizadas y agua. Un gesto inicia el audio; al cambiar sonido el foco vuelve al canvas para que F/W respondan. No hay autoplay ni nuevas dependencias/descargas de muestras sonoras.

- `vehicle-audio.ts`: un contexto, 22 nodos reutilizados y cuatro fuentes persistentes. Agua con distancia y panorámica estéreo según posición/dirección del oyente. Transiciones con smoothing; impactos con ataque de 8 ms y decaimiento de 95 ms, cooldown 220 ms.
- `audio-environment.ts`: índices de cintas de agua, árboles y huellas de edificios existentes. Consultas locales a 10 Hz desde main. Agua y pueblo se atenúan entre 80–200 m; bosque usa densidad local de árboles a 100 m. Son perfiles acústicos de juego, no un estudio acústico real.
- `vehicle-impact.ts`: detecta cambios de velocidad vertical de la suspensión mientras se conduce. Suprime teleports, estacionamiento y cambio de vehículo. No inventa detección de colisiones.

## Evidencia

`scripts/runtime/capture_audio.mjs` instrumenta el grafo nativo mediante tee/analyser/MediaRecorder, sin añadir API de grabación al producto. Exporta WebM/Opus y JSON de gesto, mute, niveles ambientales, entrada F/W, señal y estabilidad de nodos. Los nodos del probe se registran separados del grafo de producción.

`outputs/audio-v2/before` contiene el estado anterior de nueve nodos/dos fuentes **a pie**; no utilizarlo como una comparación del motor en conducción. `after` verifica el grafo nuevo y contiene la grabación: 17,82 s, 285.643 bytes, Opus/WebM. Con F/W reales, el jugador llegó a 27,8 m/s; durante la toma cambió ROAD→GRASS y el detector registró un impulso. Cuatro puntos diagnósticos se colocaron sobre datos de bosque, edificios y agua existentes; sus capas midieron bosque=1, pueblo=1 y agua=1 por zona. Al invertir la orientación junto al río, el paneo medido invirtió de −1 a +1.

Mute: RMS medido 1,57e−7; audio activo: 1,32e−3 en la lectura puntual tras reactivar. Durante la grabación activa el RMS osciló entre 0,0207 y 0,0225. No son una comparación antes/después bajo la misma conducción: el baseline histórico permanece a pie.

Los sondeos con teleport a bosque/río se etiquetan como diagnósticos.

Pruebas: tipos, build, suite completa; mocks de audio verifican ciclo de vida, envolventes, chirps y reutilización. Resolver probado contra datos reales, capas ausentes y fallos de carga; detector probado con movimiento suave, impulso, cooldown y teleport.

Perfil aislado Node (1000 consultas de pueblo): mediana 0,030 ms, p95 0,138 ms, máximo 2,163 ms; el muestreo local consultó hasta 379 segmentos de agua, 2 árboles y 135 edificios. No es medición del navegador ni de GPU.

## Límites

Sonidos sintetizados: no grabaciones de campo ni motor real. La panorámica de agua es estéreo, sin oclusión ni propagación 3D completa. Falta valoración auditiva y de conducción humana. Los JSON se vuelven a parsear para el índice acústico al arrancar; reutilizar los datos cargados por el mundo es una mejora posterior que debe medirse.
