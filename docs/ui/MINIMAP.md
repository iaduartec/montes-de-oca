# Minimap interactivo

El minimapa circular dibuja los ejes de las carreteras OSM ya cargados en la escena, los hitos principales y la posición y orientación del vehículo. El norte permanece arriba; el triángulo de rumbo gira. No descarga teselas ni datos externos.

El jugador puede arrastrar el mapa para explorar, usar la rueda o el gesto de pellizco para cambiar la escala, y pulsar el botón de centrado para volver a seguir el vehículo. Arrastrar desactiva el seguimiento hasta volver a centrar. El dibujo se limita a 10 actualizaciones por segundo y se realiza en un canvas 2D independiente de la escena 3D.

La captura automatizada [`scripts/ui/capture_minimap.mjs`](../../scripts/ui/capture_minimap.mjs) verifica arrastre, zoom, recentrado, pantalla de escritorio y emulación móvil. Los resultados están en [`output/minimap/`](../../output/minimap/). La emulación móvil usa Chrome/SwiftShader, no un dispositivo físico. `npm run test:minimap` comprueba las transformaciones, la orientación, los límites de zoom y el control del intervalo.
