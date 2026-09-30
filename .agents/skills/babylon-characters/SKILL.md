---
name: babylon-characters
description: Úsala al mejorar personajes/NPC, rigs, grupos de animación, locomoción, escala o renderizado de multitudes en Babylon.js.
---

# Personajes y animación convincentes

1. Inspecciona las mallas, rig, grupos de animación, escala, materiales, distancias de cámara y movimiento actual. Distingue un asset ausente/inadecuado de un fallo de renderizado o integración.
2. Prioriza un GLB/glTF riggeado y con licencia adecuada, silueta humana clara, articulaciones, skinning, UV/materiales y clips requeridos. Valídalo solo y dentro del juego. No afirmes que el código puede convertir geometría inadecuada en una persona convincente.
3. Sigue la guía oficial de [personajes animados](https://doc.babylonjs.com/features/featuresDeepDive/animation/animatedCharacter/) y la [documentación de animación](https://doc.babylonjs.com/features/featuresDeepDive/animation/). Inspecciona nombres y rangos reales de `AnimationGroup`, no los supongas.
4. Asigna los clips disponibles a estados del juego (quieto, caminar, correr, girar, interactuar, etc.). Detén grupos incompatibles, mezcla transiciones si es posible y maneja velocidad/dirección sin deslizamiento de pies ni deriva de root. Conserva autoridad de movimiento y físicas del juego.
5. Comprueba proporciones, contacto con el suelo, orientación, transforms de huesos/root, sombras, respuesta de materiales/ropa y lectura a la distancia prevista.
6. Para multitudes, mide primero. Usa instancias/thin instances solo si son compatibles con esqueletos, variación de materiales y necesidades de animación; valida el comportamiento de cada personaje. No congeles la diversidad animada para reducir nominalmente draw calls.

Si faltan modelo o animaciones, detalla el asset necesario y mantén los placeholders identificados.
