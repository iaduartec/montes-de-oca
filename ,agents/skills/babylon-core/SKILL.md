---
name: babylon-core
description: Úsala al inspeccionar o cambiar el motor, ciclo de vida de escenas, arquitectura, entrada, cámaras o API de una versión de Babylon.js.
---

# Fundamentos y arquitectura de Babylon.js

1. Inspecciona `package.json`, el lockfile, puntos de entrada, creación/liberación del motor y escenas, bucle de renderizado, imports, entrada, cámaras y versión instalada. Respeta los límites cliente/servidor y módulos del proyecto.
2. Sigue el flujo afectado desde el arranque hasta la destrucción de la escena. Conserva controles, resize, carga de assets, compatibilidad de navegador y jugabilidad.
3. Contrasta API y versión con la [documentación de Babylon.js](https://doc.babylonjs.com/), en especial [escenas](https://doc.babylonjs.com/features/featuresDeepDive/scene/) y [cámaras](https://doc.babylonjs.com/features/featuresDeepDive/cameras/).
4. Implementa la mejora arquitectónica coherente más pequeña. Evita motores/escenas duplicadas, estado global innecesario, observers repetidos, listeners sin liberar y recursos que sobrevivan a su escena.
5. Comprueba rutas de error: motor no compatible, carga fallida de escenas/assets, resize y cambio de escena. Muestra errores útiles y libera los recursos propios.
6. Ejecuta las comprobaciones pertinentes y el juego si es posible. Informa qué observaste y qué no pudiste probar.

No migres el renderer, framework, motor de físicas o arquitectura solo porque exista otra opción. Identifica una necesidad real y valora el coste antes.
