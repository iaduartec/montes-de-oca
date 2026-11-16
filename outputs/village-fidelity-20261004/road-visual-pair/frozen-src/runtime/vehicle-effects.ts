import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { BaseParticleSystem } from '@babylonjs/core/Particles/baseParticleSystem';
import { BoxParticleEmitter } from '@babylonjs/core/Particles/EmitterTypes/boxParticleEmitter';
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem';
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture';
import type { Scene } from '@babylonjs/core/scene';
import type { SurfaceDefinition } from '../world/surfaces';

const DEFAULT_CAPACITY = 96;
const MAX_EMIT_RATE = 48;
const MIN_DUST_SPEED = 1.4;
const DUST_TEXTURE_SIZE = 64;
const DUST_SYSTEM_NAME = 'runtime:vehicle-dust';
const DUST_SURFACES = new Set(['TRACK', 'PATH', 'GRASS']);

export interface VehicleEffectsInput {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly yaw: number;
  readonly speed: number;
  readonly slip: boolean;
  readonly driving: boolean;
  readonly surface: SurfaceDefinition;
}

export interface VehicleEffectsOptions {
  readonly capacity?: number;
  /** Allows CPU tests or a different texture source without changing particle behavior. */
  readonly createTexture?: (scene: Scene) => BaseTexture;
}

export interface VehicleEffectsStats {
  readonly systems: number;
  readonly activeParticles: number;
  readonly capacity: number;
  readonly emitRate: number;
  readonly emitting: boolean;
  /** ParticleSystem uses a Vector3 emitter and does not allocate a scene node. */
  readonly sceneNodeAllocations: 0;
  readonly textures: number;
  readonly disposed: boolean;
}

function createSyntheticDustTexture(scene: Scene): DynamicTexture {
  const texture = new DynamicTexture(DUST_SYSTEM_NAME + ':synthetic-radial', DUST_TEXTURE_SIZE, scene,
    false, Texture.BILINEAR_SAMPLINGMODE);
  const context = texture.getContext() as unknown as CanvasRenderingContext2D;
  if (!context?.createRadialGradient) {
    texture.dispose();
    throw new Error('vehicle dust texture requires a canvas 2D radial gradient');
  }
  const center = DUST_TEXTURE_SIZE / 2;
  const radial = context.createRadialGradient(center, center, 1, center, center, center);
  radial.addColorStop(0, 'rgba(153, 127, 91, 0.54)');
  radial.addColorStop(0.42, 'rgba(132, 105, 71, 0.29)');
  radial.addColorStop(1, 'rgba(119, 93, 64, 0)');
  context.clearRect(0, 0, DUST_TEXTURE_SIZE, DUST_TEXTURE_SIZE);
  context.fillStyle = radial;
  context.fillRect(0, 0, DUST_TEXTURE_SIZE, DUST_TEXTURE_SIZE);
  texture.hasAlpha = true;
  texture.update(false);
  return texture;
}

/**
 * One persistent, bounded native particle pool follows whichever vehicle is
 * active. Vehicle switches update its input pose and never recreate the system.
 */
export function createVehicleEffects(scene: Scene, options: VehicleEffectsOptions = {}) {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('vehicle effects capacity must be a positive integer');
  const texture = (options.createTexture ?? createSyntheticDustTexture)(scene);
  const particleSystem = new ParticleSystem(DUST_SYSTEM_NAME, capacity, scene);
  const emitterPosition = new Vector3();
  const boxEmitter = new BoxParticleEmitter();
  boxEmitter.minEmitBox.set(-0.72, 0.02, -0.22);
  boxEmitter.maxEmitBox.set(0.72, 0.26, 0.22);
  const direction1 = new Vector3();
  const direction2 = new Vector3();
  boxEmitter.direction1 = direction1;
  boxEmitter.direction2 = direction2;

  particleSystem.emitter = emitterPosition;
  particleSystem.particleEmitterType = boxEmitter;
  particleSystem.particleTexture = texture;
  particleSystem.blendMode = BaseParticleSystem.BLENDMODE_STANDARD;
  particleSystem.isBillboardBased = true;
  // Keep opaque world depth; a separate group would clear depth by default.
  particleSystem.renderingGroupId = 0;
  particleSystem.applyFog = true;
  particleSystem.emitRate = 0;
  particleSystem.minLifeTime = 0.55;
  particleSystem.maxLifeTime = 1.3;
  particleSystem.minSize = 0.22;
  particleSystem.maxSize = 0.72;
  particleSystem.minEmitPower = 0.35;
  particleSystem.maxEmitPower = 1.05;
  particleSystem.updateSpeed = 0.01;
  particleSystem.gravity.set(0, 0.22, 0);
  particleSystem.color1 = new Color4(0.59, 0.49, 0.36, 0.48);
  particleSystem.color2 = new Color4(0.44, 0.36, 0.27, 0.31);
  particleSystem.colorDead = new Color4(0.48, 0.4, 0.31, 0);

  let disposed = false;
  let emitting = false;
  let running = false;

  const update = (input: VehicleEffectsInput): void => {
    if (disposed) return;
    const { position, yaw, surface } = input;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const rearX = -sin;
    const rearZ = -cos;
    emitterPosition.set(position.x + rearX * 0.92, position.y + 0.12, position.z + rearZ * 0.92);

    // Rearward, with a lateral fan that rotates with the vehicle's heading.
    const sideX = cos;
    const sideZ = -sin;
    direction1.set(rearX * 0.85 - sideX * 0.48, 0.3, rearZ * 0.85 - sideZ * 0.48);
    direction2.set(rearX * 0.55 + sideX * 0.48, 0.95, rearZ * 0.55 + sideZ * 0.48);

    const speed = Math.abs(input.speed);
    const allowedSurface = DUST_SURFACES.has(surface.type);
    const active = input.driving && allowedSurface && surface.dust > 0 && speed >= MIN_DUST_SPEED;
    if (!active) {
      particleSystem.emitRate = 0;
      emitting = false;
      if (running) {
        particleSystem.stop();
        running = false;
      }
      return;
    }

    const speedFactor = Math.min(1, (speed - MIN_DUST_SPEED) / 11);
    const gripFactor = 0.65 + Math.max(0, 1 - surface.grip) * 0.7;
    const slipFactor = input.slip ? 1.7 : 1;
    particleSystem.emitRate = Math.min(MAX_EMIT_RATE, MAX_EMIT_RATE * surface.dust * speedFactor * gripFactor * slipFactor);
    particleSystem.minSize = input.slip ? 0.3 : 0.22;
    particleSystem.maxSize = input.slip ? 0.94 : 0.72;
    emitting = particleSystem.emitRate > 0;
    if (emitting && !running) {
      particleSystem.start();
      running = true;
    }
  };

  const stats = (): VehicleEffectsStats => ({
    systems: disposed ? 0 : 1,
    activeParticles: disposed ? 0 : particleSystem.getActiveCount(),
    capacity,
    emitRate: disposed ? 0 : particleSystem.emitRate,
    emitting: !disposed && emitting,
    sceneNodeAllocations: 0,
    textures: disposed ? 0 : 1,
    disposed,
  });

  return {
    update,
    stats,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (running) particleSystem.stop();
      particleSystem.dispose(false);
      texture.dispose();
    },
  };
}
