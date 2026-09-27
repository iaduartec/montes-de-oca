// Harness de VERIFICACION de la capa de vegetacion (FASE D).
//
// Por que existe: `src/main.ts` ya integra `loadVegetation`, pero este harness
// sigue siendo el lugar donde MIRAR el bosque de forma aislada y medir cuanto
// cuesta (antes/despues en la MISMA escena). Arranca los mismos bloques que el
// juego: config -> terreno real -> vias drapeadas -> `src/environment/vegetation.ts`,
// con la misma convencion de camara que main.ts.
//
// Expone `window.__game` (mismo nombre que usa main.ts) para que el script de
// captura por CDP haga lo mismo que en el resto del repo:
//   perf()                  -> DiagnosticsSnapshot (draw calls / triangulos)
//   vegetationStats()       -> VegetationStats del contrato
//   setVegetationEnabled(b) -> mide antes/despues en la MISMA escena
//   setView(name)           -> 'aerial' | 'ground' | libre px/py/pz/tx/ty/tz
//
// Uso: npm run dev  y despues
//   node scripts/environment/capture_vegetation.mjs --base http://127.0.0.1:5174
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { loadTerrainConfig } from '../../src/config';
import { loadTerrain } from '../../src/terrain';
import { gridExtent } from '../../src/heightfield';
import { loadRoadNetwork, type RoadNetwork } from '../../src/road-draping';
import {
  loadVegetation,
  type LoadVegetationOptions,
  type Vegetation,
} from '../../src/environment/vegetation';
import { FIRST_ROUTE } from '../../src/gameplay/first-route';
import { createDiagnostics, type DiagnosticsSnapshot } from '../../src/diagnostics';

const canvas = document.getElementById('render-canvas');
const hud = document.getElementById('hud');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('falta #render-canvas');

const params = new URLSearchParams(window.location.search);
const flag = (name: string, fallback: boolean): boolean => {
  const raw = params.get(name);
  if (raw === null) return fallback;
  return !(raw === '0' || raw.toLowerCase() === 'false');
};

const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true, antialias: true });
const scene = new Scene(engine);
scene.clearColor = new Color4(0.53, 0.68, 0.82, 1);

// Misma luz que src/main.ts: la captura tiene que parecerse al juego, no a un render aparte.
const ambient = new HemisphericLight('luz-ambiente', new Vector3(0.25, 1, 0.2), scene);
ambient.intensity = 0.65;
ambient.groundColor = new Color3(0.28, 0.3, 0.26);
const sun = new DirectionalLight('sol', new Vector3(-0.45, -1, -0.35), scene);
sun.intensity = 0.95;
sun.diffuse = new Color3(1, 0.97, 0.9);

const camera = new UniversalCamera('camara-preview', new Vector3(0, 80, -160), scene);
camera.minZ = 0.5;
camera.maxZ = 40000;

interface PreviewApi {
  perf(): DiagnosticsSnapshot;
  vegetationStats(): unknown;
  setVegetationEnabled(enabled: boolean): void;
  setView(name: string): void;
  ready: boolean;
}

declare global {
  interface Window {
    __game?: PreviewApi;
  }
}

function showError(message: string): void {
  console.error(message);
  if (hud) {
    hud.textContent = `ERROR\n${message}`;
    hud.classList.add('hud-error');
  }
}

/**
 * Semianchos de despeje. Espejo de `CORRIDOR_HALF_WIDTH` en
 * `scripts/environment/build_vegetation.mjs`: si cambian, cambian en los dos
 * lados (el build descarta en los datos y el runtime filtra en runtime).
 */
const CORRIDOR_HALF_WIDTH: Record<string, number> = { ROAD: 12, TRACK: 8, PATH: 4 };

/** Corredores de TODA la red drapeada, igual que el build. */
async function roadCorridors(): Promise<LoadVegetationOptions['corridors']> {
  try {
    const response = await fetch('/roads/roads.json');
    if (!response.ok) return [];
    const data = (await response.json()) as {
      roads?: { class?: string; points?: [number, number][] }[];
    };
    const out: { points: { x: number; z: number }[]; halfWidthM: number }[] = [];
    for (const road of data.roads ?? []) {
      const points = (road.points ?? []).map(([x, z]) => ({ x, z }));
      if (points.length < 2) continue;
      out.push({ points, halfWidthM: CORRIDOR_HALF_WIDTH[road.class ?? ''] ?? 4 });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Corredores de la primera ruta, partidos por `leg` sobre la polilínea densa.
 * Mismo criterio que el build: los waypoints estan cada ~150 m y la cuerda que
 * unen se despega del trazado, asi que el corte sale de la polilinea.
 */
function routeCorridors(): LoadVegetationOptions['corridors'] {
  const poly = FIRST_ROUTE.polyline;
  const cuts: { atM: number; leg: string }[] = [];
  for (let i = 1; i < FIRST_ROUTE.waypoints.length; i++) {
    const prev = FIRST_ROUTE.waypoints[i - 1]!;
    const cur = FIRST_ROUTE.waypoints[i]!;
    if (cur.leg !== prev.leg) cuts.push({ atM: prev.atM, leg: cur.leg });
  }
  const cum = [0];
  for (let i = 1; i < poly.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(poly[i]!.x - poly[i - 1]!.x, poly[i]!.z - poly[i - 1]!.z));
  }
  const total = cum[cum.length - 1]!;
  const bounds = [0, ...cuts.map((c) => c.atM), total];
  const legs = [FIRST_ROUTE.waypoints[0]?.leg ?? 'ROAD', ...cuts.map((c) => c.leg)];
  const out: { points: { x: number; z: number }[]; halfWidthM: number }[] = [];
  for (let k = 0; k < legs.length; k++) {
    const from = bounds[k]!;
    const to = bounds[k + 1]!;
    if (!(to > from)) continue;
    const points = poly.filter((_, i) => cum[i]! > from && cum[i]! < to);
    if (points.length >= 2) {
      out.push({ points: points.map((p) => ({ x: p.x, z: p.z })), halfWidthM: CORRIDOR_HALF_WIDTH[legs[k]!] ?? 4 });
    }
  }
  return out;
}

async function bootstrap(): Promise<void> {
  const config = await loadTerrainConfig();
  const terrain = await loadTerrain(scene, config);

  // Spawn del 4x4 (first-route): el claro de inicio tiene que empezar despejado.
  const routeStart = FIRST_ROUTE.start;

  let roads: RoadNetwork | null = null;
  if (flag('roads', true)) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const sampler of terrain.samplers) {
      const extent = gridExtent(sampler.grid);
      minX = Math.min(minX, extent.minX);
      maxX = Math.max(maxX, extent.maxX);
      minZ = Math.min(minZ, extent.minZ);
      maxZ = Math.max(maxZ, extent.maxZ);
    }
    roads = await loadRoadNetwork(scene, terrain, { bounds: { minX, maxX, minZ, maxZ } });
  }

  const corridors = [...routeCorridors(), ...(await roadCorridors())];
  const clearings: LoadVegetationOptions['clearings'] = [
    { x: routeStart.x, z: routeStart.z, radiusM: 30 },
    { x: FIRST_ROUTE.target.x, z: FIRST_ROUTE.target.z, radiusM: FIRST_ROUTE.targetClearRadiusM },
  ];

  const vegetation: Vegetation | null = flag('veg', true)
    ? await loadVegetation(scene, terrain, { corridors, clearings })
    : null;

  const vegMeshes = (): Mesh[] => scene.meshes.filter((m): m is Mesh => m.name.startsWith('veg:'));

  // ----------------------------------------------------------------- vistas
  // Aerea: picado sobre la zona mas densa de la ventana (3750-4250 x 1750-2750),
  // que ademas es donde la primera ruta corta el bosque: se ve el corredor
  // despejado serpenteando entre arboles. Altura elegida para que el radio
  // lejano del LOD (900 m = viewRadius) alcance el horizonte marcado del terreno.
  const aerialPos = { x: 3760, z: 2640 };
  const aerialTarget = { x: 4120, z: 2260 };
  // Suelo: parado sobre la pista cerca del objetivo, mirando hacia el claro de
  // 18 m con bosque a los dos lados (es la prueba de "¿flotan? ¿se ve pista?").
  const groundPos = { x: 4085, z: 2245 };
  const groundTarget = { x: 4178, z: 2060 };

  const views: Record<string, { pos: Vector3; target: Vector3 }> = {
    aerial: {
      pos: new Vector3(aerialPos.x, terrain.heightAt(aerialPos.x, aerialPos.z) + 340, aerialPos.z),
      target: new Vector3(
        aerialTarget.x,
        terrain.heightAt(aerialTarget.x, aerialTarget.z) + 20,
        aerialTarget.z,
      ),
    },
    ground: {
      pos: new Vector3(groundPos.x, terrain.heightAt(groundPos.x, groundPos.z) + 1.9, groundPos.z),
      target: new Vector3(
        groundTarget.x,
        terrain.heightAt(groundTarget.x, groundTarget.z) + 2.4,
        groundTarget.z,
      ),
    },
    // Claro de inicio (30 m sin nada) con el bosque de fondo. La camara va del
    // lado OPUESTO al bosque: los arboles empiezan a ~150 m en la direccion
    // (+98, -107) respecto del spawn (centroide de las 287 instancias no-hierba
    // del anillo 150-500 m; en total hay 2598 arboles a menos de 900 m). Apuntando
    // solo al claro, el encuadre quedaba sin UN arbol y la captura parecia
    // demostrar que la capa no cargaba.
    spawn: {
      pos: new Vector3(routeStart.x - 61, terrain.heightAt(routeStart.x - 61, routeStart.z + 66) + 55, routeStart.z + 66),
      target: new Vector3(3186, terrain.heightAt(3186, 3828) + 12, 3828),
    },
  };

  let currentView = 'libre';
  const setView = (name: string): void => {
    const view = views[name];
    if (!view) throw new Error(`vista desconocida: ${name}`);
    camera.position = view.pos;
    camera.setTarget(view.target);
    currentView = name;
  };

  const q = (key: string): number | null => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  if (q('px') !== null || q('py') !== null || q('pz') !== null) {
    camera.position = new Vector3(q('px') ?? 0, q('py') ?? 100, q('pz') ?? 0);
    camera.setTarget(new Vector3(q('tx') ?? 0, q('ty') ?? 0, q('tz') ?? 0));
  } else {
    setView(params.get('view') ?? 'aerial');
  }

  const diagnostics = createDiagnostics(scene);
  terrain.cull(camera);
  engine.runRenderLoop(() => {
    terrain.cull(camera);
    // El LOD depende de la camara: sin esto el buffer quedaria con la ultima
    // banda calculada y la captura mentiria sobre lo que se dibuja.
    vegetation?.update(camera.position);
    scene.render();
    if (hud) {
      const perf = diagnostics.snapshot();
      const stats = vegetation?.stats;
      hud.textContent =
        `vista       ${currentView}\n` +
        `draw calls  ${perf.drawCalls}\n` +
        `triángulos  ${perf.triangles.toFixed(0)}\n` +
        `mallas      ${perf.activeMeshes}\n` +
        `vegetación  ${
          stats
            ? `${stats.instances} inst · ${stats.meshes} mallas · LOD ${stats.near}/${stats.mid}/${stats.far}`
            : 'off'
        }` +
        (roads ? `\nvías        ${roads.stats.roads} segmentos` : '');
    }
  });

  window.__game = {
    perf: () => diagnostics.snapshot(),
    vegetationStats: () => vegetation?.stats ?? null,
    setVegetationEnabled: (enabled: boolean) => {
      for (const mesh of vegMeshes()) mesh.setEnabled(enabled);
    },
    setView,
    ready: true,
  };

  console.info(
    `[preview] vegetación=${vegetation ? vegetation.stats.instances : 0} instancias · ` +
      `${vegetation ? vegetation.stats.meshes : 0} mallas · corredores=${corridors.length}`,
  );
  if (hud && !hud.classList.contains('hud-error')) hud.textContent = 'Listo';
}

bootstrap().catch((error: unknown) => {
  showError(error instanceof Error ? error.message : String(error));
});
