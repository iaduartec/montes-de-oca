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
## Integración pendiente (orquestador)
`window.__game` aún NO expone la misión/objetivo: `main.ts` debe instanciar
`createRepeaterObjective(...)` y `createMission(FIRST_ROUTE)`, pasar por frame
`{x,z,driving,onFoot,interact,dt}` y aplicar `objective.setRepairProgress(...)`.
