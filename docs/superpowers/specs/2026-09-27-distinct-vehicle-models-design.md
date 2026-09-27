# Modelos 3D distintos para los vehículos

## Objetivo

Conservar el selector y las tres afinaciones físicas actuales y hacer que cada opción muestre una carrocería low-poly distinta. La selección existente por teclado/táctil y su persistencia se mantienen.

## Diseño

- Añadir una identidad visual explícita a cada preset (`estandar`, `patrulla`, `carga`) y una capa de generación procedural en `src/vehicle/model.ts`.
- Mantener la carrocería parametrizada para que los tres modelos reutilicen materiales, grupos por material, ruedas, hubs y animación; variar silueta y rasgos principales (carrocería estándar, vehículo de patrulla y carrocería de carga) sin depender de assets externos.
- Al seleccionar un preset, actualizar tanto los parámetros de física actuales como el modelo visual. El vehículo inactivo no queda en escena; la sustitución visual preserva posición, velocidad, dirección, ocupantes y estado de misión.
- Mantener las dimensiones funcionales de rueda y el marco visual compatibles con la física existente. La apariencia no altera colisiones, radio de giro ni reglas de conducción.
- Mantener las tarjetas del selector alineadas con el nombre y las cifras del preset; añadir una descripción breve de carrocería. No hacer cambios de misión ni controles de conducción.

## Rendimiento y robustez

- Las piezas estáticas siguen fusionadas por material; las cuatro ruedas siguen siendo los únicos conjuntos con transformación dinámica.
- Cada carrocería tendrá como máximo 2.500 triángulos. El cambio de modelo no dejará meshes invisibles acumuladas ni añadirá draw calls respecto al modelo actual por más de 2.
- Si una identidad visual no está registrada, mostrar la carrocería estándar manteniendo intacta la selección física válida.

## Validación y aceptación

- Cubrir los tres presets, identidad visual inválida, valores físicos y selección/persistencia existentes con validadores automatizados.
- Capturar el mismo ángulo para cada vehículo, a pie y conduciendo; comprobar visualmente siluetas distintas, ruedas y orientación coherentes.
- Medir draw calls y triángulos del modelo activo y ejecutar build y suite del proyecto.

## Fuera de alcance

Nuevas físicas, vehículos simultáneos, tráfico, sonidos, inventario, misiones, descarga de modelos durante la partida y cambios de controles.
