import type { Camera } from '@babylonjs/core/Cameras/camera.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { Observer } from '@babylonjs/core/Misc/observable.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';

export interface TerrainTilesError {
  tileId: string | null;
  url: string | null;
  message: string;
  cause: unknown;
}

export interface TerrainTilesEvent {
  scene?: TransformNode;
  tile?: { content?: { uri?: string } };
  url?: string | URL;
  error?: unknown;
}

export interface TerrainTilesRenderer {
  group: TransformNode;
  visibleTiles: Set<unknown>;
  activeTiles: Set<unknown>;
  update(): void;
  dispose(): void;
  addEventListener(name: 'load-model' | 'load-error', callback: (event: TerrainTilesEvent) => void): void;
  removeEventListener(name: 'load-model' | 'load-error', callback: (event: TerrainTilesEvent) => void): void;
}

export type TerrainTilesRendererFactory = (url: string, scene: Scene) => TerrainTilesRenderer;

export interface TerrainTilesOptions {
  rendererFactory: TerrainTilesRendererFactory;
  url?: string;
  onError?: (error: TerrainTilesError) => void;
  onModelLoaded?: (event: TerrainTilesEvent) => void;
}

export interface TerrainTilesStats {
  visibleTiles: number;
  activeTiles: number;
  visibleTriangles: number;
  loadedBytes: null;
}

export type TerrainTilesStatus = 'loading' | 'ready' | 'error' | 'disposed';

export function createTerrain3DTiles(scene: Scene, camera: Camera, options: TerrainTilesOptions) {
  if (!scene.useRightHandedSystem) {
    throw new Error('3D Tiles terrain requires a right-handed Babylon scene.');
  }
  if (scene.activeCamera !== camera) {
    throw new Error('3D Tiles terrain camera must be the scene active camera.');
  }

  const url = options.url ?? '/terrain/3d-tiles/tileset.json';
  let renderer: TerrainTilesRenderer | null = null;
  let status: TerrainTilesStatus = 'loading';
  let lastError: TerrainTilesError | null = null;
  try {
    renderer = options.rendererFactory(url, scene);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    lastError = { tileId: null, url, message: `3D Tiles renderer creation failed (${url}): ${reason}`, cause };
    status = 'error';
    console.error(`[terrain-3d-tiles] ${lastError.message}`);
    options.onError?.(lastError);
  }

  const onLoadModel = (event: TerrainTilesEvent) => {
    if (status === 'disposed') return;
    status = 'ready';
    options.onModelLoaded?.(event);
  };
  const onLoadError = (event: TerrainTilesEvent) => {
    if (status === 'disposed') return;
    const tileId = event.tile?.content?.uri ?? null;
    const url = event.url === undefined ? null : String(event.url);
    const reason = event.error instanceof Error ? event.error.message : String(event.error ?? 'unknown error');
    const error: TerrainTilesError = {
      tileId,
      url,
      message: `3D Tiles load failed${tileId ? ` for ${tileId}` : ''}${url ? ` (${url})` : ''}: ${reason}`,
      cause: event.error,
    };
    lastError = error;
    status = 'error';
    console.error(`[terrain-3d-tiles] ${error.message}`);
    options.onError?.(error);
  };
  renderer?.addEventListener('load-model', onLoadModel);
  renderer?.addEventListener('load-error', onLoadError);

  const frameObserver: Observer<Scene> | null = renderer
    ? scene.onBeforeRenderObservable.add(() => renderer?.update())
    : null;
  let disposed = false;

  return {
    update() {
      if (!disposed) renderer?.update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      status = 'disposed';
      if (frameObserver) scene.onBeforeRenderObservable.remove(frameObserver);
      renderer?.removeEventListener('load-model', onLoadModel);
      renderer?.removeEventListener('load-error', onLoadError);
      renderer?.dispose();
    },
    stats(): TerrainTilesStats {
      const visibleTriangles = renderer?.group.getChildMeshes(false)
        .filter((mesh) => mesh.isEnabled() && mesh.isVisible)
        .reduce((total, mesh) => total + Math.floor(mesh.getTotalIndices() / 3), 0) ?? 0;
      return {
        visibleTiles: renderer?.visibleTiles.size ?? 0,
        activeTiles: renderer?.activeTiles.size ?? 0,
        visibleTriangles,
        // The renderer's byte accounting is unimplemented in the supported release.
        loadedBytes: null,
      };
    },
    state() {
      return { status, error: lastError };
    },
  };
}
