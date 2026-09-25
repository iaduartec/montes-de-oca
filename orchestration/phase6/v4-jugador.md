# TAREA v4-jugador — FASE F de la milestone 1

**Modelo**: `opencode-go/deepseek-v4.1-flash`
**Proyecto**: `/home/kiri_/projects/montes-de-oca-offroad`
**Referencia (SOLO LECTURA, jamás escribir)**: `/home/kiri_/projects/montes-de-oca`

## Contexto: la milestone

El juego ya tiene terreno real (IGN MDT05), red viaria real de OSM drapeada, un 4x4
con física de pendiente y la ruta de la primera misión. El guion del loop pide:
conducir hasta una instalación, **bajarse del coche**, interactuar y volver.

Sin personaje no hay "bajarse". Eso es lo tuyo, y **nada más**.

Fuera de alcance, explícitamente: combate, inventario, ropa, estadísticas, skills,
IA de NPC, animación compleja, colisión con edificios.

## Tus archivos (ÚNICOS, sos el único escritor)

- `src/player/controls.ts`
- `src/player/movement.ts`
- `src/player/index.ts`
- `scripts/player/test_movement.mjs`
- `docs/player/JUGADOR.md` — **máximo 30 líneas**.

**PROHIBIDO tocar**: `src/main.ts`, `index.html`, `package.json`, `src/terrain.ts`,
`src/heightfield.ts`, `src/config.ts`, `src/road-draping.ts`, **`src/vehicle/**`**
(es código validado: lo usás, no lo cambiás), `src/gameplay/**`, `src/environment/**`,
`scripts/**` salvo `scripts/player/test_movement.mjs`.

## Convenciones del proyecto (no inventar otras)

- `worldX = E − 471500`, `worldZ = N − 4689000`. Ventana 6000 × 6000 m.
- **Convención de guiñada**: `yaw` en rad, 0 = mirando hacia +Z. Adelante =
  `(sin(yaw), cos(yaw))`; `yaw = atan2(dx, dz)` para mirar en la dirección (dx, dz).
  Es la de `src/main.ts` y la de la física. **No inventes otra.**
- `y` de mundo = absoluto − 870. La altura se pide SIEMPRE a `terrain.heightAt(x, z)`.
  **NUNCA reimplementes la interpolación** (malla con diagonal SO→NE,
  `src/terrain.ts:167-180`). Fuera de la ventana `heightAt` devuelve 0: recortá.
- Solo `@babylonjs/core`. **Imports profundos** (`@babylonjs/core/Cameras/…`,
  `@babylonjs/core/Meshes/…`), nunca `from '@babylonjs/core'`. **Cero dependencias
  nuevas.**
- Comentarios en español, explicando **por qué**.

## La API del 4x4 que vas a usar (NO la modifiques)

```ts
// src/vehicle/index.ts
export interface Vehicle {
  readonly root: TransformNode;
  readonly state: VehicleState;
  readonly params: VehicleParams;
  readonly layout: WheelLayout;
  step(dt: number): void;
  setInput(input: VehicleInput | null): void;
  teleport(x: number, z: number, yaw: number): void;
  applyPose(): number;
  telemetry(): VehicleTelemetry;   // incluye x, z, y, yawDeg, speedKmh
  dispose(): void;
}
// src/vehicle/index.ts
export function createVehicle(options: CreateVehicleOptions): Vehicle;
// src/vehicle/physics.ts
export interface VehicleInput {
  readonly throttle: number;  // [-1,1] + acelera
  readonly steer: number;     // [-1,1] + derecha
  readonly handbrake: boolean;
  readonly neutral: boolean;
}
```

## Contratos que tenés que cumplir EXACTAMENTE

### `src/player/movement.ts` — PURO, sin Babylon (se testea en Node)

```ts
export interface MovementTerrain {
  heightAt(x: number, z: number): number;
}
export interface OnFootInput {
  /** [-1,1] adelante. */
  readonly forward: number;
  /** [-1,1] derecha. */
  readonly strafe: number;
  readonly run: boolean;
}
export interface CharacterState {
  x: number;
  z: number;
  y: number;
  yaw: number;
  speed: number;
  moving: boolean;
}
export const WALK_SPEED_MPS: number;
export const RUN_SPEED_MPS: number;
export const EYE_HEIGHT_M: number;

export function createCharacterState(x: number, z: number, yaw: number, terrain: MovementTerrain): CharacterState;
/** Integra un paso. `y` sale de `terrain.heightAt`. */
export function stepCharacter(state: CharacterState, input: OnFootInput, dt: number, terrain: MovementTerrain): void;
/** Punto donde aparece el personaje al bajar del vehículo: al costado, sobre el terreno. */
export function exitPosition(
  vehicleX: number,
  vehicleZ: number,
  vehicleYaw: number,
  terrain: MovementTerrain,
  sideM?: number,
): { x: number; z: number; y: number };
```

Reglas de `stepCharacter`:
- La entrada **se normaliza**: apretar W+D no puede ser un 34% más rápido que W.
- Velocidad objetivo `WALK_SPEED_MPS` (≈3,4) o `RUN_SPEED_MPS` (≈6,8) con `run`.
- Aceleración/frenado suaves (nada de cambio instantáneo): el jugador no es un patín.
- Guiñada: el personaje **gira hacia donde se mueve**, interpolando (nada de
  teletransportar el ángulo). Si no se mueve, conserva la guiñada.
- `y = terrain.heightAt(x, z)` y **recortá la coordenada al dominio de la ventana**
  antes de muestrear (fuera de la ventana devuelve 0 y el personaje se cae al vacío).
- `dt` se satura (p. ej. a 0,1 s) para que un tirón no teletransporte al personaje.

### `src/player/controls.ts` — el ÚNICO lector de teclado del jugador

```ts
import type { VehicleInput } from '../vehicle/physics';

export interface PlayerControls {
  /** Input para el 4x4 cuando el jugador conduce. */
  readVehicular(): VehicleInput;
  /** Input a pie cuando el jugador camina. */
  readOnFoot(): OnFootInput;
  /** NIVEL de la tecla E (interacción). No es flanco: se mantiene. */
  readonly interact: boolean;
  /** Consumo de F: true UNA sola vez por pulsación (flanco). */
  consumeToggle(): boolean;
  dispose(): void;
}

export interface PlayerControlsOptions {
  /** Se llama en `keydown` de R (reposicionar). */
  readonly onReset?: () => void;
}

export function createPlayerControls(options?: PlayerControlsOptions): PlayerControls;
```

Teclas: `WASD`/flechas mover (a pie) o conducir · `Shift` correr · `E` interactuar
(nivel) · `F` entrar/salir del 4x4 (flanco) · `Espacio` freno de mano conduciendo ·
`N` punto muerto conduciendo · `R` reposicionar. **Un solo** `keydown`/`keyup`
listener para todo: dos lectores de teclado leyendo la misma tecla es cómo se
desincronizan los estados.

### `src/player/index.ts` — acá sí usás Babylon

```ts
import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Vehicle } from '../vehicle/index';
import type { PlayerControls } from './controls';

export type PlayerMode = 'on-foot' | 'driving';

export interface PlayerTelemetry {
  readonly mode: PlayerMode;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yawDeg: number;
  readonly speedMps: number;
  readonly running: boolean;
  readonly moving: boolean;
  /** Nivel de E, para que la misión sepa si está interactuando. */
  readonly interact: boolean;
  readonly distanceToVehicleM: number;
  readonly canEnter: boolean;
}

export interface Player {
  readonly root: TransformNode;
  readonly mode: PlayerMode;
  /** Entra o sale del 4x4. Devuelve el modo resultante. */
  toggleVehicle(): PlayerMode;
  step(dt: number): void;
  telemetry(): PlayerTelemetry;
  teleport(x: number, z: number, yaw: number): void;
  canEnterVehicle(): boolean;
  dispose(): void;
}

export interface CreatePlayerOptions {
  readonly scene: Scene;
  readonly terrain: MovementTerrain;
  readonly vehicle: Vehicle;
  readonly spawn: { readonly x: number; readonly z: number; readonly yaw?: number };
  readonly controls?: PlayerControls;
  /** Distancia máxima al 4x4 para poder entrar, en metros. Por defecto 4,5. */
  readonly enterRadiusM?: number;
}

export function createPlayer(options: CreatePlayerOptions): Player;
```

Reglas de `createPlayer`:
- **Arranca a pie**, al lado del 4x4 (`exitPosition`), no dentro.
- `step(dt)`: si `mode === 'driving'`, lee `controls.readVehicular()`, lo pasa con
  `vehicle.setInput(...)` y llama a `vehicle.step(dt)`; el `root` del personaje se
  **oculta** y se pega al vehículo (el jugador sigue siendo uno solo, con una sola
  posición). Si `mode === 'on-foot'`, integra `stepCharacter` y el `root` se ve.
  **No te ocupes del input manual de medición**: `main.ts` no llama a `player.step()`
  cuando hay un input manual activo (lo maneja él).
- `toggleVehicle()`: de a pie a conduciendo sólo si `canEnterVehicle()`
  (distancia ≤ `enterRadiusM`); de conduciendo a pie siempre, apareciendo con
  `exitPosition` (al costado del vehículo, sobre el terreno).
- Modelo procedural del personaje: **un mesh de cuerpo** (cápsula o caja),
  cabeza, y dos piernas que oscilan con la velocidad (barato, sin huesos). Sin GLTF,
  sin texturas. `StandardMaterial` plano.
- **Nada de colisión con edificios** en esta milestone: es una limitación conocida,
  declarala en `RISKS`.

## Verificación (obligatoria, y honesta)

- `npm run typecheck` y `npm run build` limpios.
- **`node scripts/player/test_movement.mjs`** — transpilá `movement.ts` con
  `typescript` y corré en Node con un terreno sintético conocido (patrón exacto:
  `scripts/terrain/validate_terrain.mjs`, que transpila `src/heightfield.ts`).
  Comprobá de verdad, no de adorno:
  - apretar W+D da la MISMA velocidad que W (normalización de la diagonal)
  - la velocidad converge a `WALK_SPEED_MPS` y a `RUN_SPEED_MPS` (no la salta)
  - `y` sigue al terreno en un terreno inclinado conocido
  - **nunca** devuelve `y` = 0 estando dentro de la ventana (el 0 de "fuera de
    ventana" es el bug clásico)
  - la guiñada converge a la dirección de movimiento y **no** salta de golpe
  - `dt` grande (1 s) no teletransporta al personaje
  - `exitPosition` da un punto **a un costado** del vehículo y con `y` del terreno
  Imprimí los números, no sólo "OK".
- Verificá el personaje **visualmente**: `npm run dev`/`preview` + Chrome headless
  con CDP (patrón: `scripts/vehicle/capture_vehicle.mjs`). **Sin Playwright, cero
  dependencias nuevas.** Capturas en `output/milestone1/`: `14_on_foot.png` (el
  personaje al lado del 4x4) y `15_enter_exit.png` (después de entrar). Para eso vas
  a necesitar `window.__game.player` (lo expone el orquestador): si todavía no está,
  describí exactamente qué necesitás y no lo inventes.
- **No declares éxito por compilar.** Si el personaje se ve mal, decilo.

## Al terminar

Guardá en Engram (`mem_save`, `project: "montes-de-oca"`) las decisiones no obvias.
Después respondé, corto:

```
FILES: <archivos>
WHAT: <qué hiciste, 3-6 líneas>
VERIFY: <comandos exactos y su resultado real; qué captura mirás y qué se ve>
NUMBERS: velocidades medidas, giro, y de exitPosition
RISKS: <lo que no está probado, incluida la falta de colisión>
```
