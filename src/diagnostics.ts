import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
import type { Scene } from '@babylonjs/core/scene';
import type { VehicleActor } from './vehicle/types';
import type { MotorcycleTelemetry } from './vehicle/motorcycle';
import type { VehicleTelemetry } from './vehicle/index';

/** Foto instantánea de rendimiento para el overlay. */
export interface DiagnosticsSnapshot {
  readonly fps: number;
  readonly frameTimeMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly vertices: number;
  readonly activeMeshes: number;
}

export interface Diagnostics {
  /** Instrumentación subyacente, expuesta para depuración. */
  readonly instrumentation: SceneInstrumentation;
  snapshot(): DiagnosticsSnapshot;
  dispose(): void;
}

function positiveOrZero(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Métricas de la escena.
 * - FPS y frame time: del engine y de `SceneInstrumentation`.
 * - Draw calls: contador de llamadas GL de `SceneInstrumentation`.
 * - Triángulos/vértices: de las mallas activas de la escena.
 */
export function createDiagnostics(scene: Scene): Diagnostics {
  const instrumentation = new SceneInstrumentation(scene);

  const snapshot = (): DiagnosticsSnapshot => {
    const engine = scene.getEngine();
    // El delta del engine es el tiempo real entre frames (lo que mide el jugador).
    const frameTimeMs = positiveOrZero(engine.getDeltaTime());
    return {
      fps: positiveOrZero(engine.getFps()),
      frameTimeMs,
      drawCalls: positiveOrZero(instrumentation.drawCallsCounter.current),
      triangles: positiveOrZero(scene.getActiveIndices()) / 3,
      vertices: positiveOrZero(scene.getTotalVertices()),
      activeMeshes: scene.getActiveMeshes().length,
    };
  };

  return {
    instrumentation,
    snapshot,
    dispose: () => instrumentation.dispose(),
  };
}

/** Estado de tracción legible para el HUD. */
function tractionLabel(t: VehicleTelemetry): string {
  if (t.slipping) return 'PATINA (rueda recortada por tracción)';
  if (t.skidding) return 'DERRAPA (sin agarre lateral)';
  return 'tracción OK';
}

/**
 * HUD del vehículo. Es el instrumento de medición de la FASE 4: velocidad,
 * pendiente con signo, altura de mundo, posición y estado de tracción.
 */
export function formatVehicleHud(t: VehicleTelemetry): string {
  const mode: string[] = [];
  if (t.neutral) mode.push('punto muerto');
  if (t.handbrake) mode.push('freno de mano');
  return [
    `— VEHÍCULO —`,
    `velocidad  ${t.speedKmh.toFixed(1)} km/h (${t.speed.toFixed(2)} m/s)`,
    `pendiente  ${t.slopeForwardDeg >= 0 ? '+' : ''}${t.slopeForwardDeg.toFixed(1)}° (avance)  |  ${t.slopeRightDeg >= 0 ? '+' : ''}${t.slopeRightDeg.toFixed(1)}° (lateral)`,
    `pend. abs  ${t.slopeMagnitudeDeg.toFixed(1)}°`,
    `actitud    cabeceo ${t.pitchDeg.toFixed(1)}°  alabeo ${t.rollDeg.toFixed(1)}°`,
    `Y mundo    ${t.y.toFixed(3)} m`,
    `posición   x=${t.x.toFixed(1)} z=${t.z.toFixed(1)}  yaw=${t.yawDeg.toFixed(0)}°`,
    `tracción   ${tractionLabel(t)}`,
    `límite μN  ${t.tractionLimitN.toFixed(0)} N  ·  neumático ${t.tireForceN.toFixed(0)} N  ·  gravedad ${t.gravityForceN.toFixed(0)} N`,
    `ruedas     residual máx ${t.wheelResidualMaxM.toFixed(3)} m${t.airborne ? '  ⚠ SIN CONTACTO' : ''}`,
    `modo       ${mode.length > 0 ? mode.join(' + ') : 'marcha'}${t.rolloverRisk ? '  ⚠ RIESGO VUELCO' : ''}`,
    `odómetro   ${t.distance.toFixed(1)} m`,
  ].join('\n');
}

/** HUD de una moto: la inclinación y la caída reemplazan a los campos de 4 ruedas. */
export function formatMotorcycleHud(t: MotorcycleTelemetry): string {
  const grados = (t.leanRad * 180) / Math.PI;
  return [
    `— MOTO —`,
    `velocidad  ${t.speedKmh.toFixed(1)} km/h (${t.speed.toFixed(2)} m/s)`,
    `inclinación ${grados.toFixed(1)}°${t.fallen ? '  ⚠ CAÍDA' : ''}`,
    `guiñada    ${((t.yawRate * 180) / Math.PI).toFixed(1)}°/s`,
    `Y mundo    ${t.y.toFixed(3)} m`,
    `posición   x=${t.x.toFixed(1)} z=${t.z.toFixed(1)}  yaw=${t.yawDeg.toFixed(0)}°`,
    `ruedas     residual máx ${t.wheelResidualMaxM.toFixed(3)} m`,
  ].join('\n');
}

/** HUD del actor activo, sea coche, todoterreno o moto. */
export function formatActorHud(actor: VehicleActor): string {
  if (actor.category === 'moto') return formatMotorcycleHud(actor.telemetry() as MotorcycleTelemetry);
  return formatVehicleHud(actor.telemetry() as VehicleTelemetry);
}
