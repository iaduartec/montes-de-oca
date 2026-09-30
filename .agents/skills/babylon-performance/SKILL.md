---
name: babylon-performance
description: Úsala al medir o mejorar tiempo por fotograma, draw calls, costes de mallas/texturas, carga, LOD, instancias o alternativas de dispositivo en Babylon.js.
---

# Rendimiento medido en Babylon.js

1. Reproduce una escena representativa y registra dispositivo/navegador, backend, resolución, cámara, tiempo por fotograma/FPS, draw calls, mallas activas, triángulos y coste de assets/texturas cuando sea observable. Compara condiciones equivalentes.
2. Usa la guía oficial de [optimización de escenas](https://doc.babylonjs.com/features/featuresDeepDive/scene/optimize_your_scene/) y las páginas de la versión actual. Perfila antes de elegir una solución; identifica si el cuello de botella es CPU, GPU, draw calls, memoria, carga o shaders.
3. Prioriza cambios dirigidos: elimina trabajo/overdraw innecesario, comparte materiales/geometría cuando sea seguro, ajusta o comprime texturas con el flujo existente, libera recursos sin uso y difiere o almacena cargas apropiadamente.
4. Aplica [LOD](https://doc.babylonjs.com/features/featuresDeepDive/mesh/LOD/) cuando el detalle geométrico pueda cambiar con la distancia. Ajusta umbrales/transiciones en movimiento y comprueba siluetas, sombras y pop-in a distancias representativas.
5. Considera [instancias y thin instances](https://doc.babylonjs.com/features/featuresDeepDive/mesh/copies/instances) para meshes repetidos compatibles. Valida variación individual, sombras, picking, colisiones, transparencia y reglas LOD. Las instancias no reducen automáticamente todos los costes de CPU/GPU.
6. Vuelve a medir tras cada optimización relevante e inspecciona regresiones visuales. Define alternativas para dispositivos objetivo solo cuando la evidencia las justifique. No des cifras de rendimiento sin mediciones.

Evita congelación especulativa, simplificación excesiva o reducciones generales de calidad que dañen animación, jugabilidad o fidelidad visual.
