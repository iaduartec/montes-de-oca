# Vertical slice / runtime V2 — 2026-09-30

Baseline: `3260974`, limpio antes del trabajo. Babylon 8.56.2, Vite y TypeScript existentes.

## Revisión de sistemas

- **CONSERVAR**: MDT/EPSG, PNOA, topología OSM, edificios, vegetación (33.119 instancias), misión integrada, vehículos y personaje GLB.
- **MEJORAR**: cuatro apoyos amortiguados, respuesta material compartida, 10 NPC humanos con rutas verificadas y tiers, paleta TRACK/PATH, presets y audio procedural/polvo.
- **REFACTORIZAR**: HUD de misión extraído; lifecycle GPU y cola cooperativa de terreno.
- **CONSERVAR aislado**: POC 3D Tiles. No migración del juego.

## Evidencia del juego real

`before/drive_report.json` y `final/drive_report.json`: 28 comprobaciones, cero fallos y cero errores de consola; misión `COMPLETED`. El arnés conduce la ruta con entrada inyectada y pasos deterministas, sale del vehículo, repara y regresa. No teleporta el recorrido. No equivale a una evaluación humana del tacto con volante/teclado.

Capturas desde la misma cámara y resolución 1280×720: `static-before/` frente a `static-final/`. Pueblo, pista y vista aérea inspeccionados directamente. El ciclo de misión también conserva siete capturas de cada recorrido.

| Vista HIGH | Draw calls antes → después | Triángulos antes → después |
| --- | ---: | ---: |
| Pueblo | 37 → 53 | 887.997 → 913.661 |
| Pista | 24 → 34 | 757.217 → 773.257 |
| Aérea | 28 → 46 | 875.028 → 903.900 |

El coste crece con ocho NPC adicionales y sus sombras. No se afirma reducción de draw calls. La paleta de vías no añade geometría.

En pueblo: 36 → 16 mallas de terreno residentes; payload estimado de buffers 87.092.928 → 38.707.968 bytes (**−55,6%**). Se conserva el payload CPU de alturas (~11,6 MB), sus objetos y el atlas compartido. Esto no es una medición completa de RAM ni VRAM. Se comprueba disposición/reconstrucción GPU, no streaming de red de alturas.

## Gates

- `npm run typecheck`: verde.
- `npm run build`: verde.
- `npm test`: suite completa verde, incluyendo terreno, NPC, vehículos y nuevos checks runtime.
- Suspensión en NullEngine: transición de rampa, plano, resalto y carga tardía del GLB; residual máximo de transición ~0,1 mm dentro de fixtures. No es medición de todos los terrenos reales.
- Navegador: controles de calidad no mueven al jugador; audio activa 9 nodos / 2 fuentes y permite mute. Layout móvil: misión, selector, minimapa, prompt y controles sin solapamiento en la captura. LOW móvil registra renderScale 0,75 y resolución interna 292×633 sobre viewport 390×844. Polvo en pista: 17–38 partículas activas tras arranque, dentro del pool 96; captura por colocación diagnóstica explícita, no recorrido de misión.

## Límites y revisión

Revisión final **ACCEPT** tras corregir descarga inicial de suelo por cámara desactualizada, signo de corrección de ruedas y profundidad de partículas. Cola objetivo 3 ms; construcción final de índices/upload indivisible puede excederlo. Recorrido diagnóstico por teleports hasta (900,900) y regreso: 612 pasos, 56 frames sobre presupuesto, máximo 6,1 ms en este entorno; terreno reconstruido y cola vacía en ambos extremos. No se demuestra todavía una mejora estadística de stutter.

Las capturas usan Chrome headless / SwiftShader. La RTX 2070 es visible en el host, pero el intento de usar ANGLE GL en Chrome no cargó el juego: **60 FPS / 1080p / 1440p en hardware objetivo no validados**. No utilizar los FPS headless como benchmark de esa GPU.

Audio es una primera pasada sintetizada, sin grabaciones ni ambiente espacial completo. NPC tiene Idle/Walk; Run/variación de skin sigue pendiente. Suspensión de cuatro puntos no añade vuelo balístico/vuelco rígido. Vegetación y landmarks se conservan; no se declara rediseño visual de esos sistemas.
