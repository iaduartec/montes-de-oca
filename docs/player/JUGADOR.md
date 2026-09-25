# Jugador — FASE F (milestone 1)

Un único actor: **a pie** o **al volante** del 4x4. En `driving` el `root` del
personaje se oculta y se pega al vehículo: no hay dos entidades.
Teclas: `WASD`/flechas · `Shift` correr · `E` interactuar (nivel) · `F`
entrar/salir (flanco) · `Espacio` freno de mano · `N` punto muerto · `R` reset.

## Archivos

- `src/player/movement.ts` — PURO, sin Babylon. Integra el paso a pie y resuelve
  `y` con `terrain.heightAt`. Se testea en Node.
- `src/player/controls.ts` — ÚNICO lector de teclado: `readVehicular()`,
  `readOnFoot()`, `interact` (nivel), `consumeToggle()` (flanco de F).
- `src/player/index.ts` — fachada Babylon: modelo procedural (torso, cabeza, dos
  piernas que oscilan) y el toggle entrar/salir.

## Decisiones no obvias

- **Input a pie relativo al MUNDO** (W=+Z, D=+X). Relativo al cuerpo, mantener D
  pediría siempre 90° a la derecha del rumbo nuevo: giro infinito. La guiñada
  **persigue** la dirección de movimiento.
- Guiñada con tope angular (9 rad/s) y velocidad con rampa (12/20 m/s²): ni patín
  ni saltos. Diagonal normalizada: W+D == W.
- **Recorte a [0,6000]²** antes de muestrear: fuera, `heightAt` da 0 y el
  personaje cae al vacío. `dt` saturado a 0,1 s.
- `exitPosition`: costado derecho (2 m), `y` del terreno. Entrar sólo a ≤4,5 m.

## Límites

`node scripts/player/test_movement.mjs` (20 checks). Sin colisión con edificios.
