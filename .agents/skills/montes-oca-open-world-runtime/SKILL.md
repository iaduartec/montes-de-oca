---
name: montes-oca-open-world-runtime
description: Cambia streaming de terreno, presupuesto por frame, superficies, suspensión, partículas o simulación distante en el runtime de Montes de Oca.
---

# Runtime open-world

- Mantén metros, X este, Z norte y Y relativa al datum; usa `WorldTerrain.heightAt`, nunca la altura absoluta del sampler, para contactos. Verifica `worldScale` también en AABB.
- `terrain.ts` mantiene los 36 heightfields CPU y el atlas compartido. Descarga y reconstruye **mallas**, no datos de elevación ni texturas por tile. La carga inicial sigue siendo síncrona; no la describas como streaming de red completo.
- Lifecycle GPU: `UNLOADED → QUEUED → LOADING → ACTIVE/CACHED → UNLOADED`. Culling por frustum separado de residencia. Precarga a `viewRadius + 0.25 × tileEdge`; descarga a `viewRadius + 0.75 × tileEdge`. Mantén histéresis.
- Refresca las matrices de cámara antes del primer culling y antes de leer `globalPosition`; la posición anterior puede descargar el suelo del spawn. Comprueba cámara movida antes del primer render, avance por bordes, regreso y vista aérea.
- `FrameTaskQueue` procesa pasos cooperativos por prioridad, con 3 ms por frame desde `main.ts`. Cada paso es indivisible: el upload final puede sobrepasar el presupuesto. Usa `residencyStats` para medir tiempo máximo y overshoots; no prometas un límite duro. No encoles movimiento, input ni misión. Cancela tareas al descargar/disponer.
- CPU heights y bytes de geometría son estimaciones de payload, no RAM/VRAM exacta. Mide draw calls/triángulos con cámaras iguales. SwiftShader no demuestra 60 FPS en RTX 2070.
- `world/surfaces.ts` es el contrato compartido. Las bandas reales ROAD/TRACK/PATH vienen de las líneas, anchura y recortes existentes; GRASS fuera de vías es tuning por defecto, no cartografía geológica. MUD usa contacto de agua somera fuera de vías; ROCK se reserva para zonas explícitas.
- La física conserva pendiente/gravedad y promedia las superficies de cuatro contactos. Suspensión amortigua altura/pitch/roll y corrige recorrido contra la pose real actual. `terreno − fondo de neumático > 0` significa penetración: aumenta compresión. Mantén recorrido acotado y mide contactos también durante transiciones y carga GLB tardía. No es una simulación de vuelo/vuelco rígido.
- NPC: FULL ≤80 m, REDUCED ≤250 m, VISUAL ≤900 m, SLEEP después. REDUCED limita muestras del clip; no presupongas ahorro de matrices de skinning. Valida rutas cada 25 cm contra vías, edificios, muros, DEM y agua. Las patrullas son navegación de juego, no aceras levantadas. Detén/libera grupos, clones y contenedor.
- Polvo: un `ParticleSystem` persistente, pool nativo de 96 partículas y textura sintética. Actualiza pose al cambiar vehículo; no recrees emisores por frame. Conserva depth del mundo (grupo 0). ROAD/MUD y vehículo parado no emiten.
- Audio procedural reutiliza sus nodos, requiere gesto, permite mute y se dispone. No lo presentes como grabaciones reales ni audio espacial completo.
- HIGH conserva bandas y sombras originales; LOW/MEDIUM reducen presupuestos y renderScale, ULTRA aumenta sombras. Cambiar preset en la UI reinicia partida, anunciado al jugador.
- Gates: `npm run typecheck`, `npm run build`, `npm test`, `npm run test:runtime`, recorrido real `scripts/milestone/drive_milestone.mjs` y capturas fijas `scripts/runtime/capture_runtime.mjs`. Revisa imágenes directamente y errores de consola. El POC 3D Tiles queda aislado; adopción exige comparación equivalente y jerarquía/LOD útil.
