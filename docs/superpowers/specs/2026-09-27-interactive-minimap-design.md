# Minimap interactivo

## Objetivo

Dar al jugador orientación local sin cambiar la misión ni cargar mapas raster externos. El minimapa sigue al jugador y gira con el rumbo, tal como eligió el usuario.

## Arquitectura

- Implementar el dibujo en un módulo UI Canvas 2D independiente de Babylon.js.
- Renderizar las vías OSM ya cargadas, la ruta/guía de misión existente, el marcador y rumbo del jugador, y los hitos identificados. Reutilizar coordenadas de mundo; no duplicar consultas de mapa.
- Mantener el mapa en el HUD; adaptar tamaño y posición a escritorio y móvil, evitando cubrir controles táctiles o el selector de vehículo.
- Interacciones: arrastrar para desplazar el centro, rueda/pellizco para zoom y un botón para recentrar en el jugador. El mapa sigue centrado automáticamente hasta que el jugador lo desplaza; recentrar restaura el seguimiento.
- El norte queda girado de modo que el rumbo actual del vehículo apunta hacia arriba. Al cambiar a pie, usar orientación del jugador si está disponible; sin rumbo válido, conservar la última orientación estable.

## Robustez y rendimiento

El minimapa desaparece limpiamente si no están disponibles los datos de vías o ruta; el juego continúa. Dibujar únicamente cuando cambie la vista/cámara/posición relevante y limitar seguimiento a 10 actualizaciones por segundo. No usa tiles, servicios de mapas ni mallas Babylon, por lo que no añade draw calls de escena.

## Validación y aceptación

- Probar carga con/ sin ruta, primer render, seguimiento, rotación, arrastre, zoom y recentrado.
- Probar interacción táctil sin interferir con los controles de conducción y legibilidad en resoluciones móvil/escritorio.
- Comparar bytes de bundle, draw calls Babylon (incremento 0) y coste de actualización; realizar capturas de spawn y calle con minimapa.
- Añadir controles accesibles con nombre/estado y funcionamiento por teclado.

## Fuera de alcance

Recalcular rutas, marcar destinos, alterar objetivos/misión, reemplazar el mapa global o incorporar imagery externa.
