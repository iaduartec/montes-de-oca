---
name: babylon-vehicles
description: Úsala al mejorar modelos, materiales, ruedas, presentación de conducción, cámaras, luces o rendimiento de vehículos en Babylon.js.
---

# Vehículos reconocibles

1. Determina si el problema viene del asset, los materiales, escala, orientación, cámara, luz o movimiento. Registra una vista representativa antes de cambiarlo.
2. Para el resultado final, prioriza un vehículo GLB/glTF bien creado. Comprueba licencia, silueta, cabina/cristales, paneles, ruedas/neumáticos, pasos de rueda, materiales, pivotes y nivel de detalle. Sigue `babylon-assets` al importar o validar.
3. Si solo hay geometría procedural, prioriza silueta y proporciones reconocibles: carrocería, capó/maletero, cabina, pasos de rueda, cuatro ruedas bien colocadas, cristales, luces, parachoques y detalles legibles. No presentes una caja sin rasgos como vehículo terminado.
4. Separa mallas visuales y formas de colisión si la arquitectura de físicas existente lo permite. Conserva manejo, controles, hitboxes y dimensiones de juego, salvo que la tarea los cambie.
5. Asegura que las ruedas giren/giren el volante de forma coherente con el movimiento y la suspensión cuando exista. Evita ruedas que atraviesen la carrocería, floten o se escalen mal y evita clipping de cámara o deslizamiento.
6. Prueba vistas cercanas y de conducción, movimiento, giros, sombras y luces representativas. Compara draw calls, número de mallas/materiales y LOD/instancias antes y después.

Usa los sistemas actuales de vehículos y físicas; no presupongas un plugin concreto de físicas Babylon.

## Road changes and motorcycles

- DECISION: Preserve assisted motorcycle stability and recovery unless a real gameplay regression is reproduced.
- WHY: Road banking, support heights and junctions can affect riders without a motorcycle code defect.
- INVARIANT: Both wheel heights use final road/terrain support; water contact compares actual world Y with water Y.
- VALIDATION: Run `test:motorcycle`, `test:water-contact`, long turns, slalom, low-speed turns, braking turns and ROAD/TRACK transitions in the actual actor.
- ANTI-PATTERN: Rewriting physics to compensate for visible road geometry, or declaring eight finished GLBs from an eight-entry catalog.
