/**
 * Fachada del JUGADOR (FASE F de la milestone 1): un único actor que puede estar
 * a pie o al volante del 4x4. Junta el movimiento puro (`movement.ts`), los
 * controles de teclado (`controls.ts`) y el actor visual del jugador.
 *
 * Decisión clave: HAY UN SOLO JUGADOR. En `driving` el `root` del personaje se
 * oculta y se pega al vehículo; la posición del jugador pasa a ser la del 4x4.
 * No hay dos entidades (personaje + coche) sincronizadas a mano, que es de donde
 * salen los bugs de "el jugador quedó atrás".
 *
 * El GLB humanoide sustituye al maniquí procedural cuando termina de cargar;
 * el fallback mantiene al jugador visible si el asset no está disponible.
 *
 * LIMITACIÓN CONOCIDA: no hay colisión con edificios en esta milestone.
 */

import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder';
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import '@babylonjs/loaders/glTF';
import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { publicUrl } from '../public-url';
import type { VehicleActor } from '../vehicle/types';
import type { VehicleRef } from '../vehicle/switch';
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
  /** Referencia única al vehículo activo: el personaje la lee en cada paso. */
  readonly vehicleRef: VehicleRef;
  readonly spawn: { readonly x: number; readonly z: number; readonly yaw?: number };
  readonly controls?: PlayerControls;
  /** Distancia máxima al 4x4 para poder entrar, en metros. Por defecto 4,5. */
  readonly enterRadiusM?: number;
}

const DEFAULT_ENTER_RADIUS_M = 4.5;
/** Altura del centro del cuerpo sobre los pies (m). Cadera más alta = más pierna visible. */
const BODY_CENTER_Y_M = 1.0;
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
 * Actor visual con origen del `root` en los PIES. El GLB humanoide reemplaza la
 * figura de respaldo al cargar; el anclaje del root mantiene `state.y` sobre el
 * terreno independientemente de la jerarquía interna del asset.
 */
function createCharacterModel(scene: Scene): {
  root: TransformNode;
  setEnabled(enabled: boolean): void;
  advanceGait(distanceM: number, moving: boolean, running: boolean, dt: number): void;
  dispose(): void;
} {
  const root = new TransformNode('player:root', scene);
  const placeholderRoot = new TransformNode('player:placeholder', scene);
  placeholderRoot.parent = root;

  const torsoMat = makeMaterial(scene, 'player:torso', new Color3(0.2, 0.34, 0.5));
  const headMat = makeMaterial(scene, 'player:head', new Color3(0.82, 0.66, 0.52));
  const legMat = makeMaterial(scene, 'player:leg', new Color3(0.22, 0.23, 0.27), 0.08);
  // Material propio para el calzado: botas y pantalón dejan de leerse como un solo bloque oscuro.
  const bootMat = makeMaterial(scene, 'player:boot', new Color3(0.16, 0.12, 0.1), 0.06);
  const vestMat = makeMaterial(scene, 'player:vest', new Color3(0.9, 0.72, 0.12));
  const gearMat = makeMaterial(scene, 'player:gear', new Color3(0.25, 0.31, 0.22));
  // Cabello: material propio y oscuro. Sin él la cabeza es una esfera de piel lisa y
  // el personaje lee como maniquí desde la cámara de juego, que ve la espalda.
  const hairMat = makeMaterial(scene, 'player:hair', new Color3(0.17, 0.12, 0.08), 0.05);

  const detail = (name: string, mat: StandardMaterial, width: number, height: number, depth: number, x: number, y: number, z: number): void => {
    const mesh = CreateBox(name, { width, height, depth }, scene);
    mesh.material = mat;
    mesh.position.set(x, y, z);
    mesh.parent = placeholderRoot;
    mesh.isPickable = false;
  };

  // Hombros algo más anchos que la cintura, con una silueta angular sencilla.
  const torso = CreateCylinder('player:torso', { height: 0.72, diameterTop: 0.54, diameterBottom: 0.44, tessellation: 6 }, scene);
  torso.material = torsoMat;
  torso.position.set(0, BODY_CENTER_Y_M, 0);
  torso.scaling.z = 0.65;
  torso.parent = placeholderRoot;
  torso.isPickable = false;

  // Front is +Z. The vest and field pack make the role legible from either side.
  detail('player:vest-front', vestMat, 0.42, 0.58, 0.05, 0, BODY_CENTER_Y_M, 0.19);
  detail('player:field-pack', gearMat, 0.38, 0.53, 0.17, 0, BODY_CENTER_Y_M + 0.02, -0.23);
  // La cámara habitual ve la espalda: esta banda recupera la lectura del chaleco
  // aunque la mochila tape el panel delantero desde ese ángulo.
  detail('player:vest-back-reflective', vestMat, 0.31, 0.1, 0.012, 0, BODY_CENTER_Y_M + 0.02, -0.322);
  // Tira reflectante alta del chaleco: fina y apoyada sobre la mochila, suma lectura
  // de chaleco desde atrás sin quedar como una placa suelta.
  detail('player:vest-yoke', vestMat, 0.39, 0.06, 0.018, 0, BODY_CENTER_Y_M + 0.24, -0.326);
  detail('player:field-radio', gearMat, 0.11, 0.17, 0.07, 0.16, BODY_CENTER_Y_M + 0.26, 0.22);
  for (const side of [-1, 1] as const) {
    const sleeve = CreateCylinder(`player:sleeve-${side}`, { height: 0.58, diameterTop: 0.2, diameterBottom: 0.15, tessellation: 6 }, scene);
    sleeve.material = torsoMat;
    sleeve.position.set(side * 0.33, BODY_CENTER_Y_M + 0.02, 0);
    sleeve.rotation.z = side * 0.12;
    sleeve.parent = placeholderRoot;
    sleeve.isPickable = false;

    const hand = CreateSphere(`player:hand-${side}`, { diameter: 0.12, segments: 6 }, scene);
    hand.material = headMat;
    hand.position.set(side * 0.37, 0.7, 0);
    hand.parent = placeholderRoot;
    hand.isPickable = false;
  }

  const head = CreateSphere('player:head', { diameter: 0.28, segments: 8 }, scene);
  head.material = headMat;
  head.position.set(0, 1.55, 0);
  head.parent = placeholderRoot;
  head.isPickable = false;
  // Pelo corto en la nuca: una pieza redondeada bajo la gorra, sin cubrir la cara.
  const hairBack = CreateSphere('player:hair-back', { diameter: 0.2, segments: 8 }, scene);
  hairBack.material = hairMat;
  hairBack.position.set(0, 1.52, -0.14);
  hairBack.scaling.set(1, 0.48, 0.4);
  hairBack.parent = placeholderRoot;
  hairBack.isPickable = false;
  const capBrim = CreateCylinder('player:cap-brim', {
    height: 0.035,
    diameterTop: 0.39,
    diameterBottom: 0.39,
    tessellation: 10,
  }, scene);
  capBrim.material = gearMat;
  capBrim.position.set(0, 1.68, 0.025);
  capBrim.parent = placeholderRoot;
  capBrim.isPickable = false;
  const capCrown = CreateCylinder('player:field-cap', {
    height: 0.14,
    diameterTop: 0.27,
    diameterBottom: 0.31,
    tessellation: 8,
  }, scene);
  capCrown.material = gearMat;
  capCrown.position.set(0, 1.755, 0.025);
  capCrown.parent = placeholderRoot;
  capCrown.isPickable = false;

  // Piernas: cada pieza cuelga de la cadera. `rotation.x` la balancea. Babylon rota
  // alrededor del CENTRO del mesh, así que el centro va a media pierna bajo el
  // origen de la cadera (y = LEG/2) para que el pie quede a la altura del suelo.
  const makeLeg = (name: string, x: number): Mesh => {
    const leg = CreateCylinder(name, { height: LEG_LENGTH_M, diameterTop: 0.18, diameterBottom: 0.15, tessellation: 6 }, scene);
    leg.material = legMat;
    leg.position.set(x, LEG_LENGTH_M / 2, 0);
    // Keep the procedural legs inside the disposable fallback hierarchy. When the
    // skinned GLB replaces the placeholder, none of its standalone parts may leak
    // into the final character or keep receiving the fallback gait.
    leg.parent = placeholderRoot;
    leg.isPickable = false;

    const boot = CreateBox(`${name}-boot`, { width: 0.23, height: 0.14, depth: 0.34 }, scene);
    boot.material = bootMat;
    boot.position.set(0, -LEG_LENGTH_M / 2 + 0.07, 0.07);
    boot.parent = leg;
    boot.isPickable = false;
    return leg;
  };
  const legRight = makeLeg('player:leg-right', 0.14);
  const legLeft = makeLeg('player:leg-left', -0.14);

  let gait = 0;
  let disposed = false;
  let assetContainer: Awaited<ReturnType<typeof SceneLoader.LoadAssetContainerAsync>> | null = null;
  let idleAnimation: AnimationGroup | undefined;
  let walkAnimation: AnimationGroup | undefined;
  let runAnimation: AnimationGroup | undefined;
  let activeAnimation: AnimationGroup | undefined;
  let previousAnimation: AnimationGroup | undefined;
  let transitionElapsedS = 0;
  const transitionDurationS = 0.2;
  let isMoving = false;
  let isRunning = false;

  const updateAnimation = (dt = 0): void => {
    if (!idleAnimation || !walkAnimation || !runAnimation) return;
    const next = !isMoving ? idleAnimation : isRunning ? runAnimation : walkAnimation;
    // The authored 32-frame walk is a measured 1.07 s cycle at 30 fps. A 1.7x
    // playback rate matches the game's brisk 3.4 m/s on-foot pace more closely
    // than slowing the Run clip, while keeping the feet visibly cycling.
    const speedRatio = next === walkAnimation ? 1.7 : 1;
    if (activeAnimation !== next) {
      next.start(true, speedRatio);
      if (activeAnimation) {
        previousAnimation?.stop();
        previousAnimation = activeAnimation;
        previousAnimation.setWeightForAllAnimatables(1);
        next.setWeightForAllAnimatables(0);
        transitionElapsedS = 0;
      } else {
        next.setWeightForAllAnimatables(1);
      }
      activeAnimation = next;
    } else {
      next.speedRatio = speedRatio;
    }
    if (previousAnimation) {
      transitionElapsedS = Math.min(transitionDurationS, transitionElapsedS + Math.max(0, Math.min(dt, 0.1)));
      const blend = transitionElapsedS / transitionDurationS;
      previousAnimation.setWeightForAllAnimatables(1 - blend);
      activeAnimation.setWeightForAllAnimatables(blend);
      if (blend >= 1) {
        previousAnimation.stop();
        previousAnimation = undefined;
      }
    }
  };

  const assetUrl = publicUrl('/characters/field-player.glb');
  void SceneLoader.LoadAssetContainerAsync('', assetUrl, scene)
    .then((container) => {
      if (disposed) {
        container.dispose();
        return;
      }
      const glbMeshes = container.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
      idleAnimation = container.animationGroups.find((group) => group.name.toLowerCase().includes('idle'));
      walkAnimation = container.animationGroups.find((group) => group.name.toLowerCase().includes('walk'));
      runAnimation = container.animationGroups.find((group) => group.name.toLowerCase().includes('run'));
      if (glbMeshes.length === 0 || !idleAnimation || !walkAnimation || !runAnimation) {
        container.dispose();
        throw new Error('The player GLB must contain a skinned mesh plus Idle, Walk, and Run animation groups');
      }

      container.addAllToScene();
      const transformRoots = container.rootNodes.filter((node): node is TransformNode => node instanceof TransformNode);
      for (const node of transformRoots) node.parent = root;
      root.computeWorldMatrix(true);
      for (const mesh of glbMeshes) mesh.computeWorldMatrix(true);
      const lowestWorldY = Math.min(...glbMeshes.map((mesh) => mesh.getBoundingInfo().boundingBox.minimumWorld.y));
      const rootWorldY = root.getAbsolutePosition().y;
      if (Number.isFinite(lowestWorldY)) {
        for (const node of transformRoots) node.position.y -= lowestWorldY - rootWorldY;
      }
      placeholderRoot.dispose(false, true);
      torsoMat.dispose();
      headMat.dispose();
      legMat.dispose();
      bootMat.dispose();
      vestMat.dispose();
      gearMat.dispose();
      hairMat.dispose();
      assetContainer = container;
      updateAnimation();
    })
    .catch((error: unknown) => {
      if (!disposed) console.error(`[player] Failed to load ${assetUrl}; retaining the procedural fallback`, error);
    });

  return {
    root,
    setEnabled: (enabled: boolean) => {
      root.setEnabled(enabled);
    },
    advanceGait: (distanceM: number, moving: boolean, running: boolean, dt: number) => {
      // Las piernas se mueven con la DISTANCIA recorrida, no con el reloj: si el
      // jugador está quieto, los pies no patinan.
      gait += distanceM * GAIT_RATE_PER_M;
      const swing = Math.sin(gait) * LEG_GAIT_RAD;
      legLeft.rotation.x = swing;
      legRight.rotation.x = -swing;
      isMoving = moving;
      isRunning = running;
      updateAnimation(dt);
    },
    dispose: () => {
      disposed = true;
      activeAnimation?.stop();
      previousAnimation?.stop();
      assetContainer?.dispose();
      root.dispose(false, true);
    },
  };
}

export function createPlayer(options: CreatePlayerOptions): Player {
  const { scene, terrain, vehicleRef } = options;
  const controls = options.controls;
  const enterRadiusM = options.enterRadiusM ?? DEFAULT_ENTER_RADIUS_M;
  /** El actor activo puede cambiar en caliente: SIEMPRE se lee por la referencia. */
  const vehicle = (): VehicleActor => vehicleRef.current;

  const model = createCharacterModel(scene);

  // Arranca A PIE, al costado del 4x4: nunca dentro del coche. Si el spawn
  // pedido está lejos del coche (p. ej. > radio de entrada), igual aparece al
  // lado del 4x4, sobre el terreno, que es lo que pide el guion.
  const exit = exitPosition(vehicle().state.x, vehicle().state.z, vehicle().state.yaw, terrain);
  const spawnNearVehicle =
    Math.hypot(options.spawn.x - exit.x, options.spawn.z - exit.z) <= enterRadiusM;
  const spawnX = spawnNearVehicle ? options.spawn.x : exit.x;
  const spawnZ = spawnNearVehicle ? options.spawn.z : exit.z;
  const spawnYaw = options.spawn.yaw ?? vehicle().state.yaw;

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
      const dx = state.x - vehicle().state.x;
      const dz = state.z - vehicle().state.z;
      return Math.hypot(dx, dz) <= enterRadiusM;
    },
    toggleVehicle: (): PlayerMode => {
      if (mode === 'driving') {
        // Bajar: siempre se puede. Aparece al costado, sobre el terreno.
        const v = vehicle();
        const p = exitPosition(v.state.x, v.state.z, v.state.yaw, terrain);
        placeOnFoot(p.x, p.z, v.state.yaw);
        // El coche deja de recibir input del jugador al bajar.
        v.setInput(null);
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
        const v = vehicle();
        const input = controls ? controls.readVehicular() : { throttle: 0, steer: 0, handbrake: false, neutral: false };
        v.setInput(input);
        v.step(dt);
        // El jugador sigue al vehículo: una sola posición.
        model.root.position.copyFrom(v.root.position);
        model.root.rotation.set(0, v.state.yaw, 0);
        return;
      }

      const input = controls
        ? controls.readOnFoot()
        : { forward: 0, turn: 0, run: false };
      stepCharacter(state, input, dt, terrain);
      syncOnFootRoot();
      // La marcha avanza con la velocidad REAL del paso (m/s ya saturado).
      model.advanceGait(
        Math.abs(state.speed) * Math.max(0, Math.min(dt, 0.1)),
        state.moving,
        controls?.readOnFoot().run ?? false,
        dt,
      );
    },
    telemetry: (): PlayerTelemetry => {
      const v = vehicle();
      const driving = mode === 'driving';
      const x = driving ? v.state.x : state.x;
      const z = driving ? v.state.z : state.z;
      const y = driving ? v.root.position.y : state.y;
      const yaw = driving ? v.state.yaw : state.yaw;
      const speed = driving ? v.state.speed : state.speed;
      const onFootInput = controls && !driving ? controls.readOnFoot() : null;
      return {
        mode,
        x,
        y,
        z,
        yawDeg: (yaw * 180) / Math.PI,
        speedMps: speed,
        running: onFootInput ? onFootInput.run : false,
        moving: driving ? Math.abs(v.state.speed) > 0.1 : state.moving,
        interact: controls ? controls.interact : false,
        distanceToVehicleM: Math.hypot(x - v.state.x, z - v.state.z),
        canEnter: player.canEnterVehicle(),
      };
    },
    teleport: (x: number, z: number, yaw: number): void => {
      if (mode === 'driving') {
        const v = vehicle();
        v.teleport(x, z, yaw);
        v.setInput(null);
        model.root.position.copyFrom(v.root.position);
        model.root.rotation.set(0, v.state.yaw, 0);
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
