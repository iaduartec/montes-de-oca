/**
 * Fachada del JUGADOR (FASE F de la milestone 1): un único actor que puede estar
 * a pie o al volante del 4x4. Junta el movimiento puro (`movement.ts`), los
 * controles de teclado (`controls.ts`) y un modelo procedural de Babylon.
 *
 * Decisión clave: HAY UN SOLO JUGADOR. En `driving` el `root` del personaje se
 * oculta y se pega al vehículo; la posición del jugador pasa a ser la del 4x4.
 * No hay dos entidades (personaje + coche) sincronizadas a mano, que es de donde
 * salen los bugs de "el jugador quedó atrás".
 *
 * El modelo es procedural y barato: cuerpo, cabeza, equipo de campo y dos
 * piernas que oscilan con la velocidad. Sin GLTF, texturas ni huesos.
 *
 * LIMITACIÓN CONOCIDA: no hay colisión con edificios en esta milestone.
 */

import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import type { Vehicle } from '../vehicle/index';
import {
  createCharacterState,
  exitPosition,
  stepCharacter,
  type CharacterState,
  type MovementTerrain,
} from './movement';
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

const DEFAULT_ENTER_RADIUS_M = 4.5;
/** Altura del centro del cuerpo sobre los pies (m). */
const BODY_CENTER_Y_M = 0.95;
/** Longitud de la pierna (m). */
const LEG_LENGTH_M = 1.0;
/** Amplitud de la oscilación de las piernas (rad). */
const LEG_GAIT_RAD = 0.6;
/** Frecuencia de zancada por (m/s): mueve las piernas con el avance real. */
const GAIT_RATE_PER_M = 1.6;

function makeMaterial(scene: Scene, name: string, color: Color3, specular = 0.12): StandardMaterial {
  const mat = new StandardMaterial(name, scene);
  mat.diffuseColor = color;
  mat.specularColor = new Color3(specular, specular, specular);
  mat.ambientColor = new Color3(0.2, 0.2, 0.2);
  return mat;
}

/**
 * Modelo procedural del personaje. Origen del `root` en los PIES: así
 * `root.position.y = state.y` (terreno) planta al personaje directo, sin offsets.
 * Jerarquía:
 *   root
 *     ├─ cuerpo (cápsula/torso)   ├─ cabeza   ├─ pierna izq / der (pivote arriba)
 */
function createCharacterModel(scene: Scene): {
  root: TransformNode;
  legs: readonly [Mesh, Mesh];
  setEnabled(enabled: boolean): void;
  advanceGait(distanceM: number): void;
  dispose(): void;
} {
  const root = new TransformNode('player:root', scene);

  const torsoMat = makeMaterial(scene, 'player:torso', new Color3(0.2, 0.34, 0.5));
  const headMat = makeMaterial(scene, 'player:head', new Color3(0.82, 0.66, 0.52));
  const legMat = makeMaterial(scene, 'player:leg', new Color3(0.22, 0.23, 0.27), 0.08);
  const vestMat = makeMaterial(scene, 'player:vest', new Color3(0.78, 0.63, 0.15));
  const gearMat = makeMaterial(scene, 'player:gear', new Color3(0.25, 0.31, 0.22));

  const detail = (name: string, mat: StandardMaterial, width: number, height: number, depth: number, x: number, y: number, z: number): void => {
    const mesh = CreateBox(name, { width, height, depth }, scene);
    mesh.material = mat;
    mesh.position.set(x, y, z);
    mesh.parent = root;
    mesh.isPickable = false;
  };

  // Hombros algo más anchos que la cintura, con una silueta angular sencilla.
  const torso = CreateCylinder('player:torso', { height: 0.8, diameterTop: 0.54, diameterBottom: 0.44, tessellation: 6 }, scene);
  torso.material = torsoMat;
  torso.position.set(0, BODY_CENTER_Y_M, 0);
  torso.scaling.z = 0.65;
  torso.parent = root;
  torso.isPickable = false;

  // Front is +Z. The vest and field pack make the role legible from either side.
  detail('player:vest-front', vestMat, 0.42, 0.58, 0.05, 0, BODY_CENTER_Y_M, 0.19);
  detail('player:field-pack', gearMat, 0.38, 0.53, 0.17, 0, BODY_CENTER_Y_M + 0.02, -0.23);
  detail('player:field-radio', gearMat, 0.11, 0.17, 0.07, 0.16, BODY_CENTER_Y_M + 0.26, 0.22);
  for (const side of [-1, 1] as const) {
    const sleeve = CreateCylinder(`player:sleeve-${side}`, { height: 0.58, diameterTop: 0.2, diameterBottom: 0.15, tessellation: 6 }, scene);
    sleeve.material = torsoMat;
    sleeve.position.set(side * 0.33, BODY_CENTER_Y_M + 0.02, 0);
    sleeve.rotation.z = side * 0.12;
    sleeve.parent = root;
    sleeve.isPickable = false;

    const hand = CreateSphere(`player:hand-${side}`, { diameter: 0.12, segments: 6 }, scene);
    hand.material = headMat;
    hand.position.set(side * 0.37, 0.64, 0);
    hand.parent = root;
    hand.isPickable = false;
  }

  const head = CreateSphere('player:head', { diameter: 0.28, segments: 8 }, scene);
  head.material = headMat;
  head.position.set(0, 1.55, 0);
  head.parent = root;
  head.isPickable = false;
  const capBrim = CreateCylinder('player:cap-brim', {
    height: 0.035,
    diameterTop: 0.39,
    diameterBottom: 0.39,
    tessellation: 10,
  }, scene);
  capBrim.material = gearMat;
  capBrim.position.set(0, 1.68, 0.025);
  capBrim.parent = root;
  capBrim.isPickable = false;
  const capCrown = CreateCylinder('player:field-cap', {
    height: 0.14,
    diameterTop: 0.27,
    diameterBottom: 0.31,
    tessellation: 8,
  }, scene);
  capCrown.material = gearMat;
  capCrown.position.set(0, 1.755, 0.025);
  capCrown.parent = root;
  capCrown.isPickable = false;

  // Piernas: cada pieza cuelga de la cadera. `rotation.x` la balancea. Babylon rota
  // alrededor del CENTRO del mesh, así que el centro va a media pierna bajo el
  // origen de la cadera (y = LEG/2) para que el pie quede a la altura del suelo.
  const makeLeg = (name: string, x: number): Mesh => {
    const leg = CreateCylinder(name, { height: LEG_LENGTH_M, diameterTop: 0.18, diameterBottom: 0.15, tessellation: 6 }, scene);
    leg.material = legMat;
    leg.position.set(x, LEG_LENGTH_M / 2, 0);
    leg.parent = root;
    leg.isPickable = false;
    return leg;
  };
  const legRight = makeLeg('player:leg-right', 0.14);
  const legLeft = makeLeg('player:leg-left', -0.14);

  let gait = 0;

  return {
    root,
    legs: [legLeft, legRight],
    setEnabled: (enabled: boolean) => {
      root.setEnabled(enabled);
    },
    advanceGait: (distanceM: number) => {
      // Las piernas se mueven con la DISTANCIA recorrida, no con el reloj: si el
      // jugador está quieto, los pies no patinan.
      gait += distanceM * GAIT_RATE_PER_M;
      const swing = Math.sin(gait) * LEG_GAIT_RAD;
      legLeft.rotation.x = swing;
      legRight.rotation.x = -swing;
    },
    dispose: () => {
      root.dispose(false, true);
      torsoMat.dispose();
      headMat.dispose();
      legMat.dispose();
      vestMat.dispose();
      gearMat.dispose();
    },
  };
}

export function createPlayer(options: CreatePlayerOptions): Player {
  const { scene, terrain, vehicle } = options;
  const controls = options.controls;
  const enterRadiusM = options.enterRadiusM ?? DEFAULT_ENTER_RADIUS_M;

  const model = createCharacterModel(scene);

  // Arranca A PIE, al costado del 4x4: nunca dentro del coche. Si el spawn
  // pedido está lejos del coche (p. ej. > radio de entrada), igual aparece al
  // lado del 4x4, sobre el terreno, que es lo que pide el guion.
  const exit = exitPosition(vehicle.state.x, vehicle.state.z, vehicle.state.yaw, terrain);
  const spawnNearVehicle =
    Math.hypot(options.spawn.x - exit.x, options.spawn.z - exit.z) <= enterRadiusM;
  const spawnX = spawnNearVehicle ? options.spawn.x : exit.x;
  const spawnZ = spawnNearVehicle ? options.spawn.z : exit.z;
  const spawnYaw = options.spawn.yaw ?? vehicle.state.yaw;

  let state: CharacterState = createCharacterState(spawnX, spawnZ, spawnYaw, terrain);
  let mode: PlayerMode = 'on-foot';

  const syncOnFootRoot = (): void => {
    model.root.position.set(state.x, state.y, state.z);
    // Babylon rota en orden YXZ por defecto: rotation.y = guiñada (giro). El
    // modelo mira hacia +Z con guiñada 0, igual que la convención del proyecto.
    model.root.rotation.set(0, state.yaw, 0);
    model.root.computeWorldMatrix(true);
  };

  const placeOnFoot = (x: number, z: number, yaw: number): void => {
    state = createCharacterState(x, z, yaw, terrain);
    mode = 'on-foot';
    model.setEnabled(true);
    syncOnFootRoot();
  };

  syncOnFootRoot();

  const player: Player = {
    root: model.root,
    get mode() {
      return mode;
    },
    canEnterVehicle: (): boolean => {
      if (mode !== 'on-foot') return false;
      const dx = state.x - vehicle.state.x;
      const dz = state.z - vehicle.state.z;
      return Math.hypot(dx, dz) <= enterRadiusM;
    },
    toggleVehicle: (): PlayerMode => {
      if (mode === 'driving') {
        // Bajar: siempre se puede. Aparece al costado, sobre el terreno.
        const p = exitPosition(vehicle.state.x, vehicle.state.z, vehicle.state.yaw, terrain);
        placeOnFoot(p.x, p.z, vehicle.state.yaw);
        // El coche deja de recibir input del jugador al bajar.
        vehicle.setInput(null);
        return mode;
      }
      if (player.canEnterVehicle()) {
        mode = 'driving';
        model.setEnabled(false);
        return mode;
      }
      return mode;
    },
    step: (dt: number): void => {
      if (mode === 'driving') {
        const input = controls ? controls.readVehicular() : { throttle: 0, steer: 0, handbrake: false, neutral: false };
        vehicle.setInput(input);
        vehicle.step(dt);
        // El jugador sigue al vehículo: una sola posición.
        model.root.position.copyFrom(vehicle.root.position);
        model.root.rotation.set(0, vehicle.state.yaw, 0);
        return;
      }

      const input = controls
        ? controls.readOnFoot()
        : { forward: 0, strafe: 0, run: false };
      stepCharacter(state, input, dt, terrain);
      syncOnFootRoot();
      // La marcha avanza con la velocidad REAL del paso (m/s ya saturado).
      model.advanceGait(state.speed * Math.max(0, Math.min(dt, 0.1)));
    },
    telemetry: (): PlayerTelemetry => {
      const driving = mode === 'driving';
      const x = driving ? vehicle.state.x : state.x;
      const z = driving ? vehicle.state.z : state.z;
      const y = driving ? vehicle.root.position.y : state.y;
      const yaw = driving ? vehicle.state.yaw : state.yaw;
      const speed = driving ? vehicle.state.speed : state.speed;
      const onFootInput = controls && !driving ? controls.readOnFoot() : null;
      return {
        mode,
        x,
        y,
        z,
        yawDeg: (yaw * 180) / Math.PI,
        speedMps: speed,
        running: onFootInput ? onFootInput.run : false,
        moving: driving ? Math.abs(vehicle.state.speed) > 0.1 : state.moving,
        interact: controls ? controls.interact : false,
        distanceToVehicleM: Math.hypot(x - vehicle.state.x, z - vehicle.state.z),
        canEnter: player.canEnterVehicle(),
      };
    },
    teleport: (x: number, z: number, yaw: number): void => {
      if (mode === 'driving') {
        vehicle.teleport(x, z, yaw);
        vehicle.setInput(null);
        model.root.position.copyFrom(vehicle.root.position);
        model.root.rotation.set(0, vehicle.state.yaw, 0);
        return;
      }
      placeOnFoot(x, z, yaw);
    },
    dispose: (): void => {
      model.dispose();
    },
  };

  return player;
}
