# TAREA v3-mision — FASES G + H de la milestone 1

**Modelo**: `opencode-go/deepseek-v4.1-flash`
**Proyecto**: `/home/kiri_/projects/montes-de-oca-offroad`
**Referencia (SOLO LECTURA, jamás escribir)**: `/home/kiri_/projects/montes-de-oca`

## Contexto: la milestone

El juego ya tiene terreno real (IGN MDT05), red viaria real de OSM drapeada y un 4x4
con física de pendiente. La ruta ya está definida y **verificada**
(`src/gameplay/first-route.ts`). Lo que falta para tener un loop jugable es
**la misión**: llegar a una instalación de telecomunicaciones ficticia al fondo de
una pista, bajarse del coche, restablecer el enlace y volver.

**Nombre de la misión: `REPETIDOR SIN SEÑAL`.**
Estados: `NOT_STARTED → ACTIVE → TARGET_REACHED → REPAIRED → RETURNING → COMPLETED`.

Flujo (del guion del usuario, no lo cambies):
1. empezar en Villafranca · 2. entrar en el 4x4 · 3. seguir la ruta ·
4. llegar al objetivo · 5. bajar · 6. interactuar (E) · 7. reparar ·
8. regresar · 9. completar.

## Tus archivos (ÚNICOS, sos el único escritor)

- `src/gameplay/interact.ts`
- `src/gameplay/mission.ts`
- `src/gameplay/objective.ts`
- `scripts/gameplay/test_mission.mjs`
- `docs/gameplay/MISION.md` — **máximo 30 líneas**.

**PROHIBIDO tocar**: `src/main.ts`, `index.html`, `package.json`, `src/terrain.ts`,
`src/heightfield.ts`, `src/config.ts`, `src/road-draping.ts`, `src/vehicle/**`,
`src/gameplay/route-types.ts`, `src/gameplay/first-route.ts`,
`src/environment/**`, `scripts/environment/**`, `scripts/roads/**`,
`scripts/terrain/**`, `scripts/gameplay/build_first_route.mjs`.

## Convenciones del proyecto (no inventar otras)

- `worldX = E − 471500`, `worldZ = N − 4689000`. Ventana 6000 × 6000 m.
- `y` de mundo = absoluto − 870. La altura se pide SIEMPRE a `terrain.heightAt(x, z)`.
  **NUNCA reimplementes la interpolación** (la malla usa la diagonal SO→NE,
  `src/terrain.ts:167-180`; una bilineal da hasta 0,29 m de error).
- `terrain.heightAt` **fuera de la ventana devuelve 0**. Recortá al dominio.
- **Convención de guiñada**: `yaw` en rad, 0 = mirando hacia +Z. Adelante =
  `(sin(yaw), cos(yaw))`, y `yaw = atan2(dx, dz)` para mirar en la dirección (dx, dz).
  Es la de `src/main.ts` y la de la física. **No inventes otra.**
- Solo `@babylonjs/core`. **Imports profundos** (`@babylonjs/core/Meshes/mesh`, …),
  nunca `from '@babylonjs/core'`. **Cero dependencias nuevas.**
- Comentarios en español, explicando **por qué**.

## La ruta (leela de `src/gameplay/first-route.ts`, NO la edites)

```
inicio     (3087.53, 3935.05) yaw -3.037  cota 75 m   — Villafranca, sobre el asfalto
entrada pista (3269.04, 3371.58) a 661 m
objetivo   (4178.26, 2060.45) yaw -0.527  cota 239 m  — fondo de pista, +164 m
targetClearRadiusM = 18
returnPoint = start
```

## Contratos que tenés que cumplir EXACTAMENTE

### `src/gameplay/interact.ts` — PURO, sin Babylon

```ts
export interface Interactable {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly z: number;
  readonly radiusM: number;
}
export interface InteractionQuery {
  /** El interactuable alcanzable más cercano, o null. */
  readonly available: Interactable | null;
  readonly distanceM: number;
}
export interface Interactor {
  readonly targets: readonly Interactable[];
  query(x: number, z: number): InteractionQuery;
}
export function createInteractor(targets: readonly Interactable[]): Interactor;
```

### `src/gameplay/mission.ts` — PURO, sin Babylon (se testea en Node)

```ts
import type { FirstRoute } from './first-route';

export type MissionState =
  | 'NOT_STARTED' | 'ACTIVE' | 'TARGET_REACHED' | 'REPAIRED' | 'RETURNING' | 'COMPLETED';

export interface MissionContext {
  readonly x: number;
  readonly z: number;
  /** Conduciendo el 4x4. */
  readonly driving: boolean;
  /** A pie. Exactamente uno de `driving`/`onFoot` es true. */
  readonly onFoot: boolean;
  /** NIVEL de la tecla de interacción (E), no flanco. */
  readonly interact: boolean;
  readonly dt: number;
}

export interface MissionSnapshot {
  readonly name: string;
  readonly state: MissionState;
  readonly objective: string;
  /** Qué tiene que hacer el jugador AHORA. Se muestra en el HUD. */
  readonly hint: string;
  readonly distanceToTargetM: number;
  readonly distanceToReturnM: number;
  /** 0..1 mientras mantiene E. */
  readonly repairProgress: number;
  readonly repaired: boolean;
  readonly elapsedS: number;
  readonly completed: boolean;
}

export interface Mission {
  readonly route: FirstRoute;
  readonly snapshot: MissionSnapshot;
  update(ctx: MissionContext): MissionSnapshot;
  reset(): void;
}

export interface MissionOptions {
  readonly reachRadiusM?: number;     // por defecto 25
  readonly repairSeconds?: number;    // por defecto 2
}

export function createMission(route: FirstRoute, options?: MissionOptions): Mission;
```

Transiciones, exactas:
- `NOT_STARTED → ACTIVE` cuando `driving` pasa a true (entró al 4x4).
- `ACTIVE → TARGET_REACHED` cuando la distancia al objetivo ≤ `reachRadiusM`.
- `TARGET_REACHED → REPAIRED` cuando **está a pie**, dentro del radio, y mantiene
  `interact` durante `repairSeconds` acumulados. Si suelta E o se aleja, el progreso
  **se resetea** (no se congela). Reparar **desde el coche NO vale**.
- `REPAIRED → RETURNING` cuando vuelve a estar `driving`.
- `RETURNING → COMPLETED` cuando la distancia a `returnPoint` ≤ `reachRadiusM`.
- `COMPLETED` es terminal. `reset()` vuelve a `NOT_STARTED` con el reloj a 0.
- `hint` por estado, en español rioplatense y corto. Ej.: ACTIVE → "Seguí la pista
  hasta el repetidor"; TARGET_REACHED (conduciendo) → "Bajá del 4x4 (F) y acercate";
  TARGET_REACHED (a pie, en rango) → "Mantené E para restablecer el enlace";
  REPAIRED → "Volvé a Villafranca"; RETURNING → "Volvé a Villafranca".
- `elapsedS` suma `dt` desde que pasa a `ACTIVE`.

### `src/gameplay/objective.ts` — ACÁ SÍ usás Babylon

```ts
import type { Scene } from '@babylonjs/core/scene';
import type { WorldTerrain } from '../terrain';
import type { Interactable } from './interact';

export interface Objective {
  readonly root: TransformNode;
  readonly interactable: Interactable;
  /** 0..1: retroalimentación visual del progreso de reparación. */
  setRepairProgress(progress: number): void;
  dispose(): void;
}

export interface CreateObjectiveOptions {
  readonly at: { readonly x: number; readonly z: number; readonly yaw: number };
  readonly clearRadiusM: number;
}

export function createRepeaterObjective(
  scene: Scene,
  terrain: WorldTerrain,
  options: CreateObjectiveOptions,
): Objective;
```

La instalación es **FICTICIA** (nada de infraestructura real sensible): una torre
liviana de celosía (~12 m) o un mástil con riostras, un armario técnico, una antena
y una **baliza**: apagada/roja hasta que se repara, verde al reparar. Procedural, sin
texturas, `StandardMaterial` plano. **La base tiene que tocar el terreno**: usá el
mínimo `heightAt` de la huella y agregá una losa/patín para que en pendiente no
quede flotando. `interactable.radiusM` ≈ 6 m, y `clearRadiusM` = 18 m.
`setyRepairProgress` tiene que ser visible (baliza que se enciende gradualmente,
antena que gira o sube).

## Verificación (obligatoria, y honesta)

- `npm run typecheck` y `npm run build` limpios.
- **`node scripts/gameplay/test_mission.mjs`** — el test que más vale en esta tarea.
  Transpilá `mission.ts` con `typescript` y hacelo correr en Node **sin Babylon**
  (patrón exacto: `scripts/terrain/validate_terrain.mjs`, que transpila
  `src/heightfield.ts`). Corré el flujo COMPLETO y comprobá cada transición, y
  además los caminos negativos:
  - el flujo feliz llega a `COMPLETED` y `elapsedS` > 0
  - **reparar desde el coche NO repara** (mantener E con `driving: true` no pasa de
    `TARGET_REACHED`)
  - soltar E **resetea** `repairProgress` a 0
  - alejarse del objetivo en `RETURNING` no completa
  - `reset()` vuelve a `NOT_STARTED` con `repairProgress` 0
  - un `dt` de 0 no rompe nada
  Imprimí el estado tras cada paso (no solo "OK": quiero ver la secuencia).
- Verificá el **objetivo visualmente**: `npm run dev`/`preview` + Chrome headless con
  CDP (patrón: `scripts/vehicle/capture_vehicle.mjs`;
  `scripts/roads/draping/capture_draping.mjs`). **Sin Playwright, cero dependencias
  nuevas.** Capturas en `output/milestone1/` con estos nombres exactos:
  `12_objective_approach.png` (el objetivo visto desde la pista),
  `13_objective_repaired.png` (con la baliza verde).
  Para eso podés usar la API de depuración `window.__game` (te va a hacer falta que
  el orquestador la exponga: **no la cambies vos**, y si no está todavía, describí
  qué necesitás).
- **No declares éxito por compilar.**

## Al terminar

Guardá en Engram (`mem_save`, `project: "montes-de-oca"`) las decisiones no obvias.
Después respondé, corto:

```
FILES: <archivos>
WHAT: <qué hiciste, 3-6 líneas>
VERIFY: <comandos exactos y su resultado real; qué captura mirás y qué se ve>
STATE TRACE: <la secuencia de estados que imprimió el test>
RISKS: <lo que no está probado>
```
