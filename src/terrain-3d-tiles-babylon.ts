import { Matrix } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import { TilesRenderer } from '3d-tiles-renderer/babylonjs';

interface BabylonTilesRendererInternals {
  _upRotationMatrix: Matrix;
  loadRootTileset(...args: unknown[]): Promise<unknown>;
}

/**
 * Creates the Babylon renderer for this project's already-Y-up glTF contents.
 *
 * The package applies a 90 degree X rotation for its default `gltfUpAxis: "y"`
 * even though this scene and these GLBs are already Y-up. Clear that adjustment
 * after its root tileset hook has initialized the matrix and before child GLBs
 * load. Keep the workaround at the renderer boundary so source geometry and the
 * standards-based tileset remain unchanged.
 */
export function createBabylonTerrainTilesRenderer(url: string, scene: Scene): TilesRenderer {
  const renderer = new TilesRenderer(url, scene);
  const internals = renderer as unknown as BabylonTilesRendererInternals;
  const loadRootTileset = internals.loadRootTileset.bind(renderer);
  internals.loadRootTileset = (...args) => loadRootTileset(...args).then((root) => {
    internals._upRotationMatrix.copyFrom(Matrix.Identity());
    return root;
  });
  return renderer;
}
