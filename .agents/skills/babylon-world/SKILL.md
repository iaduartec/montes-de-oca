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

## Decisión visual estable: pistas de tierra

- **DECISIÓN:** TRACK puede llevar parches oscuros de humedad y variación cromática de grava procedural; PATH conserva una variación más leve. Son detalle artístico de color por vértice, no una afirmación de geología o humedad medida.
- **WHY:** la geometría existente de rodadas ya define la lectura principal de la pista; el color añade escala y ruptura local sin reemplazar esa señal ni añadir mallas.
- **INVARIANTE:** ROAD mantiene exactamente su sombreado neutro. Esta capa no cambia perfiles, elevaciones, secciones, topología, tránsito ni helpers de carretera.
- **VALIDACIÓN:** `node scripts/roads/test_track_art.mjs` muestrea una cuadrícula espacial amplia, acota sombreado/croma, comprueba que los parches sean localizados y compara ROAD con su paleta establecida.
- **ANTI-PATTERN:** no uses ondas periódicas grandes como único detalle, no oscurezcas una pista entera para simular humedad y no alteres elevación o geometría para fingir datos ambientales sin fuente.
