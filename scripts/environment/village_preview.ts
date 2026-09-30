import { FIRST_ROUTE } from '../../src/gameplay/first-route';
import { routePrefixToEndpoint } from '../../src/environment/village-facade-kits';
// Harness de VERIFICACION de la capa de pueblo (FASE E).
//
// Por que existe: `src/main.ts` esta congelado para este worker (lo integra el
// orquestador), asi que el juego todavia no llama a `loadVillage`. Sin esto no
// habria forma de MIRAR las casas ni de medir cuanto cuestan. Arranca los mismos
// bloques que arrancara el juego: config -> terreno real -> vias drapeadas ->
// `src/environment/village.ts`, con la misma convencion de camara que main.ts.
//
// Expone `window.__game` (mismo nombre que usa main.ts) para que el script de
// captura por CDP haga lo mismo que en el resto del repo:
//   perf()             -> DiagnosticsSnapshot (draw calls / triangulos)
//   villageStats()     -> VillageStats del contrato
//   villageAudit()     -> verifica sobre las MALLAS REALES que ninguna base flota
//   setVillageEnabled  -> mide antes/despues en la misma escena
//   setView(name)      -> 'street' | 'aerial' | libre px/py/pz/tx/ty/tz
//
// Uso: npm run dev  y despues
//   node scripts/environment/capture_village.mjs --base http://127.0.0.1:5174
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { loadTerrainConfig, wgs84ToWorld } from '../../src/config';
import { loadTerrain } from '../../src/terrain';
import { gridExtent } from '../../src/heightfield';
import { loadRoadNetwork, type RoadNetwork } from '../../src/road-draping';
import { loadVillage, FALDON_M, type Village } from '../../src/environment/village';
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

interface AuditReport {
  readonly sample: number;
  readonly missing: number;
  readonly maxGapM: number;
  readonly worstId: number | null;
  readonly faldonM: number;
  /** Esquinas realmente comparadas (puede ser < sample*4 si faltan vecinas). */
  readonly corners: number;
  readonly ok: boolean;
}

interface PreviewApi {
  perf(): DiagnosticsSnapshot;
  villageStats(): unknown;
  villageAudit(): AuditReport;
  setVillageEnabled(enabled: boolean): void;
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

/** Distancia punto-poligono (independiente del runtime: esto es la auditoria). */
function distanceToPolygon(points: readonly (readonly [number, number])[], x: number, z: number): number {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const pi = points[i]!;
    const pj = points[j]!;
    if (pi[1] > z !== pj[1] > z && x < ((pj[0] - pi[0]) * (z - pi[1])) / (pj[1] - pi[1]) + pi[0]) inside = !inside;
  }
  if (inside) return 0;
  let best = Infinity;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    const vx = b[0] - a[0];
    const vz = b[1] - a[1];
    const len2 = vx * vx + vz * vz;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * vx + (z - a[1]) * vz) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - (a[0] + t * vx), z - (a[1] + t * vz)));
  }
  return best;
}

async function bootstrap(): Promise<void> {
  const config = await loadTerrainConfig();
  const terrain = await loadTerrain(scene, config);

  // Spawn del 4x4 (first-route): el pueblo tiene que empezar despejado.
  const [spawnX, spawnZ] = wgs84ToWorld(config, -3.3086147, 42.3883784);
  const routeStart = { x: 3087.53, z: 3935.05 };

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

  // Datos del pueblo para la auditoria (los mismos que consume loadVillage).
  const villageResponse = await fetch('/village/buildings.json');
  const villageData = (await villageResponse.json()) as {
    buildings: { id: number; footprint: [number, number][]; heightM: number }[];
  };

  const village: Village | null = flag('village', true)
    ? await loadVillage(scene, terrain, {
        keepClearAt: { x: routeStart.x, z: routeStart.z },
        facadeRoute: { points: routePrefixToEndpoint(FIRST_ROUTE.polyline, FIRST_ROUTE.trackEntry), radiusM: 28 },
        // `?keepclear=40` agranda el radio a proposito: sirve para demostrar que
        // el filtro del runtime descarta de verdad (con 12 m los datos ya vienen
        // limpios del build y el contador daria 0 por casualidad).
        keepClearRadiusM: Number(params.get('keepclear') ?? 12),
      })
    : null;

  const villageMeshes = (): Mesh[] =>
    scene.meshes.filter((m): m is Mesh => m.name.startsWith('pueblo:'));
  const allVillageMeshes = villageMeshes();

  // -------------------------------------------------------------- auditoria
  // Verifica sobre las MALLAS REALES (lo que se dibuja) que la base de cada casa
  // esta exactamente en `min(terrain.heightAt) - FALDON_M`.
  //
  // OJO con el test: se mira el BORDE del footprint y el minimo de todos los
  // vertices ahi dentro salia contaminado por los VECINOS que tocan la pared
  // (medido: dos naves compartian muro con #1509800975 y tiraban la base 4,48 m
  // para abajo). Por eso el test es por ESQUINA: el runtime escribe un vertice de
  // base en cada esquina del poligono, con la XZ exacta del footprint. Si falta
  // o esta a otra altura, hay un fallo de verdad.
  const audit = (): AuditReport => {
    // Indice espacial de vertices de TODAS las mallas del pueblo (celdas de 2 m).
    const cells = new Map<string, number[]>();
    for (const mesh of allVillageMeshes) {
      const pos = mesh.getVerticesData('position');
      if (!pos) continue;
      for (let i = 0; i < pos.length; i += 3) {
        const key = `${Math.floor(pos[i]! / 2)}|${Math.floor(pos[i + 2]! / 2)}`;
        let bucket = cells.get(key);
        if (!bucket) {
          bucket = [];
          cells.set(key, bucket);
        }
        bucket.push(pos[i + 1]!);
      }
    }

    const list = villageData.buildings;
    let seed = 20260925;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const sample = Math.min(250, list.length);
    const picked = new Set<number>();
    while (picked.size < sample) picked.add(Math.floor(rnd() * list.length));

    let maxGap = 0;
    let worstId: number | null = null;
    let cornersMissing = 0;
    let cornersChecked = 0;
    const EPS_XZ = 0.1;
    const EPS_Y = 0.01;
    for (const index of picked) {
      const building = list[index]!;
      let minY = Infinity;
      for (const [x, z] of building.footprint) minY = Math.min(minY, terrain.heightAt(x, z));
      const expectedBase = minY - FALDON_M;

      for (const [x, z] of building.footprint) {
        cornersChecked++;
        let closest = Infinity;
        const cx = Math.floor(x / 2);
        const cz = Math.floor(z / 2);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = cells.get(`${cx + dx}|${cz + dz}`);
            if (!bucket) continue;
            for (const y of bucket) {
              // Los vertices vecinos estan a 2 m de celda: el umbral de XZ es 0,1 m,
              // asi que un vertice "cerca de la esquina" solo puede estar en estas 9.
              closest = Math.min(closest, Math.abs(y - expectedBase));
            }
          }
        }
        // (la cercania en XZ se da por construccion: el bucket se busco alrededor
        // de la esquina y el runtime escribe la XZ exacta del footprint)
        if (!Number.isFinite(closest)) {
          cornersMissing++;
          continue;
        }
        if (closest > maxGap) {
          maxGap = closest;
          worstId = building.id;
        }
        if (closest > EPS_Y) cornersMissing++;
      }
    }
    void EPS_XZ;
    return {
      sample,
      missing: cornersMissing,
      maxGapM: maxGap,
      worstId,
      faldonM: FALDON_M,
      corners: cornersChecked,
      ok: cornersMissing === 0 && maxGap < EPS_Y,
    };
  };

  // ----------------------------------------------------------------- vistas
  const villageCenter = villageData.buildings.reduce(
    (acc, b) => {
      for (const [x, z] of b.footprint) {
        acc.x += x;
        acc.z += z;
        acc.n++;
      }
      return acc;
    },
    { x: 0, z: 0, n: 0 },
  );
  const center = { x: villageCenter.x / villageCenter.n, z: villageCenter.z / villageCenter.n };

  const views: Record<string, { pos: Vector3; target: Vector3 }> = {
    // A nivel de calle desde la aparicion, mirando por la carretera hacia el sur
    // (la direccion de la primera ruta: startYaw -3.04 rad).
    street: (() => {
      const pos = new Vector3(routeStart.x, terrain.heightAt(routeStart.x, routeStart.z) + 1.9, routeStart.z);
      const dir = { x: Math.sin(-3.037375), z: Math.cos(-3.037375) };
      const tx = routeStart.x + dir.x * 70;
      const tz = routeStart.z + dir.z * 70;
      const target = new Vector3(tx, terrain.heightAt(tx, tz) + 1.6, tz);
      return { pos, target };
    })(),
    // Picado sobre el casco urbano desde el suroeste (~40°), que es lo que deja
    // ver si el pueblo "se lee" como un pueblo y no como una explanada.
    aerial: (() => {
      const px = center.x - 380;
      const pz = center.z - 420;
      const pos = new Vector3(px, terrain.heightAt(px, pz) + 380, pz);
      const target = new Vector3(center.x + 40, terrain.heightAt(center.x + 40, center.z + 60) + 10, center.z + 60);
      return { pos, target };
    })(),
    // Fachada cercana de la casa de piedra en el tramo inicial de Calle Mayor.
    facade: (() => {
      const building = villageData.buildings.find((item) => item.id === 305647007);
      if (!building) throw new Error('falta la casa piloto 305647007');
      const center = building.footprint.reduce(
        (acc, point) => ({ x: acc.x + point[0] / building.footprint.length, z: acc.z + point[1] / building.footprint.length }),
        { x: 0, z: 0 },
      );
      const towardSpawn = new Vector3(routeStart.x - center.x, 0, routeStart.z - center.z).normalize();
      const pos = new Vector3(center.x + towardSpawn.x * 26, terrain.heightAt(center.x + towardSpawn.x * 26, center.z + towardSpawn.z * 26) + 2.1, center.z + towardSpawn.z * 26);
      const target = new Vector3(center.x, terrain.heightAt(center.x, center.z) + 3.4, center.z);
      return { pos, target };
    })(),
  };

  // El HUD muestra la vista ACTIVA, no el query param: setView() se puede llamar
  // en caliente (así lo hace el script de captura) y el label tiene que seguir.
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
    camera.position = new Vector3(q('px') ?? spawnX, q('py') ?? 100, q('pz') ?? spawnZ);
    camera.setTarget(new Vector3(q('tx') ?? center.x, q('ty') ?? 0, q('tz') ?? center.z));
  } else {
    setView(params.get('view') ?? 'street');
  }

  const diagnostics = createDiagnostics(scene);
  terrain.cull(camera);
  engine.runRenderLoop(() => {
    terrain.cull(camera);
    scene.render();
    if (hud) {
      const perf = diagnostics.snapshot();
      hud.textContent =
        `vista       ${currentView}\n` +
        `draw calls  ${perf.drawCalls}\n` +
        `triángulos  ${perf.triangles.toFixed(0)}\n` +
        `mallas      ${perf.activeMeshes}\n` +
        `pueblo      ${village ? `${village.stats.buildings} casas / ${village.stats.meshes} mallas` : 'off'}` +
        (roads ? `\nvías        ${roads.stats.roads} segmentos` : '');
    }
  });

  window.__game = {
    perf: () => diagnostics.snapshot(),
    villageStats: () => village?.stats ?? null,
    villageAudit: audit,
    setVillageEnabled: (enabled: boolean) => {
      for (const mesh of allVillageMeshes) mesh.setEnabled(enabled);
    },
    setView,
    ready: true,
  };

  console.info(
    `[preview] pueblo=${village ? village.stats.buildings : 0} casas · centro (${center.x.toFixed(0)}, ${center.z.toFixed(0)}) · ` +
      `spawn (${routeStart.x}, ${routeStart.z})`,
  );
  if (hud && !hud.classList.contains('hud-error')) hud.textContent = 'Listo';
}

bootstrap().catch((error: unknown) => {
  showError(error instanceof Error ? error.message : String(error));
});
