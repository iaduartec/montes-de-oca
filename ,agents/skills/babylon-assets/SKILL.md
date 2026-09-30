---
name: babylon-assets
description: Úsala al seleccionar, importar, validar, organizar u optimizar modelos GLB/glTF, texturas y animaciones para Babylon.js.
---

# Assets y flujo GLB/glTF

1. Inventaría los assets disponibles y cómo los carga el proyecto. Comprueba licencia y procedencia antes de añadir o redistribuir assets externos. No afirmes que existe un asset si no lo has comprobado.
2. Revisa la documentación oficial de [importación glTF](https://doc.babylonjs.com/features/featuresDeepDive/importers/glTF) y de [importadores](https://doc.babylonjs.com/features/featuresDeepDive/importers/). Comprueba soporte y API para la versión instalada.
3. Valida en cada GLB/glTF dimensiones/escala, ejes, pivote, transforms, jerarquía, cantidad de meshes/materiales, resolución y formato de texturas, UVs, normales, transparencia, esqueleto, grupos de animación y tamaño. Usa Sandbox/Inspector de Babylon o un visor del proyecto si existe.
4. Integra con el flujo actual. Usa rutas estables/locales si es posible; gestiona progreso, errores, cancelación, caché y liberación de recursos según las convenciones del proyecto. No añadas una dependencia remota en ejecución sin motivo.
5. Prueba el asset en la escena real, con su entorno e iluminación: orientación, escala, aspecto de materiales, clipping, colisiones, animación y rendimiento.
6. Si falta un asset adecuado, especifica qué hace falta crear o adquirir. Mejora encuadre, proporciones, detalle procedural o materiales solo hasta donde lo permita la geometría actual; identifica claramente los placeholders.

Referencia: [importación glTF en Babylon.js](https://doc.babylonjs.com/features/featuresDeepDive/importers/glTF). GLB/glTF no proporciona automáticamente todos los ajustes de escena; verifica y configura la iluminación de entorno en la aplicación.
