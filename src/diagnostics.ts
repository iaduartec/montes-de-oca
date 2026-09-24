import { SceneInstrumentation } from '@babylonjs/core/Instrumentation/sceneInstrumentation';
import type { Scene } from '@babylonjs/core/scene';

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
