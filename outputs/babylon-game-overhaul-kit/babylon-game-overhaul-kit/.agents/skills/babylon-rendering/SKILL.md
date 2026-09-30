---
name: babylon-rendering
description: Úsala al mejorar materiales, PBR, iluminación de entorno, sombras, postprocesado, tone mapping o composición visual en Babylon.js.
---

# Renderizado y calidad visual

1. Inspecciona el resultado actual e identifica la causa visual antes de cambiar ajustes: geometría/asset, entradas del material, luz, entorno, sombra, cámara, exposición o postprocesado.
2. Comprueba la versión de Babylon.js y la documentación oficial vigente: [materiales](https://doc.babylonjs.com/features/featuresDeepDive/materials/), [luces](https://doc.babylonjs.com/features/featuresDeepDive/lights/) y [sombras](https://doc.babylonjs.com/features/featuresDeepDive/lights/shadows/).
3. Trata geometría, materiales, iluminación, entorno y cámara como un solo flujo. Valida mapas PBR, canales y espacio de color; añade una textura de entorno adecuada si los materiales reflectantes la requieren. Evita valores metálicos arbitrarios, superficies demasiado brillantes y assets sin respuesta a la luz.
4. Ajusta conjuntamente luces directas, contribución ambiental, mapa de sombras, bias, filtrado y exposición. Comprueba la lectura de las formas y que las sombras no se separen, produzcan acne o dominen la escena.
5. Añade postprocesado solo con una mejora visual demostrable. Revisa color, clipping, artefactos, escala de renderizado y coste de GPU; conserva una alternativa para hardware modesto si hace falta.
6. Compara la misma cámara, resolución y escena antes/después. Inspecciona distancias cercanas, medias y lejanas y condiciones de luz relevantes. Indica si no pudiste inspeccionar el juego en ejecución.

Usa la documentación correspondiente a la versión instalada, no pegues ejemplos a ciegas: las API y valores predeterminados pueden cambiar.
