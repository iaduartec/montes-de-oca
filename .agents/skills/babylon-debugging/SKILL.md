---
name: babylon-debugging
description: Úsala al diagnosticar escenas, renderizado, carga de assets, animación, WebGL/WebGPU o corrección visual en Babylon.js.
---

# Depuración visual y de ejecución

1. Reproduce el problema en el juego. Registra pasos, navegador/dispositivo, backend, escena y errores de consola/red. Compara comportamiento esperado y real.
2. Reduce el caso a la escena o asset más pequeño que conserve el fallo. Revisa versión, registro de importadores/plugins, rutas, sistemas de coordenadas, transforms, mapas de materiales, errores de shaders y ciclo de vida/liberación.
3. Usa el [Inspector de Babylon.js](https://doc.babylonjs.com/) y herramientas de desarrollo del navegador cuando estén disponibles para revisar mallas, materiales, texturas, luces, cámaras, grupos de animación y contadores de rendimiento.
4. Sigue imports asíncronos y cambios de estado hasta su origen. Gestiona explícitamente cargas rechazadas y referencias ausentes de animación/materiales; no ocultes errores ni añadas alternativas silenciosas.
5. Cambia un factor causal cada vez y repite la reproducción. Comprueba vistas cercanas/lejanas y otro navegador/dispositivo representativo si hace falta.
6. Añade o actualiza una comprobación de regresión enfocada con la infraestructura existente cuando sea práctico. Ejecuta las verificaciones de `AGENTS.md` e informa claramente de limitaciones del entorno.

Usa documentación oficial correspondiente a la versión y ejemplos del Playground como evidencia. No supongas que un fallo visual pertenece al motor antes de revisar assets, configuración y código del proyecto.
