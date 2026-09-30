# Misión: Repetidor sin señal

Loop: Villafranca → 4x4 → pista → objetivo → bajar → E → reparar → volver.
## Estados (`src/gameplay/mission.ts`)
`NOT_STARTED → ACTIVE → TARGET_REACHED → REPAIRED → RETURNING → COMPLETED`
- ACTIVE: entró al 4x4 (`driving`). El reloj (`elapsedS`) arranca acá.
- TARGET_REACHED: a ≤ 25 m del objetivo (`reachRadiusM`).
- REPAIRED: **a pie**, en rango, manteniendo E 2 s (`repairSeconds`). Reparar desde
  el coche NO vale. Soltar E o alejarse RESETEA el progreso (no se congela).
- RETURNING: vuelve a conducir. COMPLETED: a ≤ 25 m del inicio. Terminal.
- `reset()` vuelve a NOT_STARTED con reloj y progreso en 0.
## Piezas
- `interact.ts`: interactuable más cercano dentro de su radio (puro, sin Babylon).
- `mission.ts`: máquina de estados (pura, se testea en Node).
- `objective.ts`: repetidor procedural + baliza roja→verde (`setRepairProgress`).
## Objetivo visual
Mástil de 12 m con 4 riostras, antena que gira, armario y baliza. La base se ancla
en el MÍNIMO `heightAt` de la huella (con patín) para no flotar en pendiente.
Instalación FICTICIA, sin infraestructura real.
## Verificación
- `npm run typecheck` · `npm run build`
- `node scripts/gameplay/test_mission.mjs` (flujo feliz + caminos negativos)
- `node scripts/gameplay/capture_objective.mjs` (capturas CDP; requiere dev server)
## Integración
La misión y el repetidor ya están conectados en `main.ts`: se crean desde
`FIRST_ROUTE`, reciben la telemetría del jugador en cada paso de simulación y el
progreso actualiza la baliza con `objective.setRepairProgress(...)`. El aviso de
acción ofrece `E` solo durante `TARGET_REACHED` y dentro del radio del repetidor;
tras reparar, vuelve a ofrecer `F` para entrar al 4x4. El HUD muestra fase, pista
y distancias. El recorrido completo se verificó en el juego desde Villafranca,
incluida la reparación a pie y el regreso.
