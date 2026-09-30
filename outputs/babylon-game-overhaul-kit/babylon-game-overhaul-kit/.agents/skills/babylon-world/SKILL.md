---
name: babylon-world
description: Úsala al mejorar terreno, carreteras, edificios, vegetación, objetos, atmósfera, escala, composición o lectura del mundo Babylon.js.
---

# Mundo de juego coherente

1. Inspecciona la zona jugable, recorridos de cámara, escala, procedencia de assets, colisiones y dirección artística. Identifica los cambios del mundo con mayor impacto visible para el jugador.
2. Compón una escena legible con puntos de referencia, profundidad, escala plausible y contraste útil. Mejora suelo, carreteras, edificios, vegetación y objetos como un entorno coherente, no como una suma de detalles inconexos.
3. Revisa conjuntamente materiales PBR, tiling/UVs, entorno, luces y sombras. Rompe superficies planas grandes con variación creada para ello; evita repetición evidente, z-fighting, objetos flotantes o que se intersecten y exceso de ruido.
4. Conserva transitabilidad, líneas de visión, colisiones y rutas de juego. Comprueba continuidad de terreno/carretera y que la decoración no impida interacciones.
5. Usa instancias para assets estáticos repetidos cuando encaje. Revisa la documentación de [instancias](https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/instances) y valida sombras, picking, colisiones, LOD y variación única tras agrupar.
6. Inspecciona vistas generales, a altura del jugador y lejanas. Ejecuta el juego y compara las mismas ubicaciones antes/después cuando sea posible.

Usa assets reales del proyecto cuando existan. Si falta un asset importante de entorno, describe lo necesario en vez de disimularlo con primitivas genéricas.
