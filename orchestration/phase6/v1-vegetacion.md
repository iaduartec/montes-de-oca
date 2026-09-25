# TAREA v1-vegetacion — FASE D de la milestone 1

**Modelo**: `opencode/mimo-v2.6-flash-free`
**Proyecto**: `/home/kiri_/projects/montes-de-oca-offroad`
**Referencia (SOLO LECTURA, jamás escribir)**: `/home/kiri_/projects/montes-de-oca`

## Contexto: la milestone

El juego ya tiene terreno real (IGN MDT05, 36 tiles de 1 km a 5 m), red viaria real
de OSM drapeada (ROAD/TRACK/PATH), y un 4x4 con física de pendiente. La milestone
en curso es convertir eso en un **primer loop jugable**:
Villafranca → carretera → pista → objetivo → regreso, 5–10 min.

Tú te ocupás de que **el terreno deje de parecer una maqueta topográfica**.

## Tus archivos (ÚNICOS, sos el único escritor)

- `scripts/environment/build_vegetation.mjs`
- `public/vegetation/vegetation.json` (generado por tu script; se versiona)
- `src/environment/vegetation.ts`
- `data/gameplay/raw/osm_landcover_window.json` + `..._manifest.json` (si descargás)
- `docs/environment/VEGETATION.md` — **máximo 30 líneas**. Solo decisiones y cifras.

**PROHIBIDO tocar** (hay otros escritores o está congelado): `src/main.ts`,
`index.html`, `package.json`, `src/terrain.ts`, `src/heightfield.ts`,
`src/config.ts`, `src/road-draping.ts`, `src/vehicle/**`, `src/gameplay/**`,
`src/environment/atmosphere.ts`, `src/environment/village.ts`, `scripts/roads/**`,
`scripts/terrain/**`, `public/terrain/**`.

## Convenciones del proyecto (no inventar otras)

- `worldX = E − 471500`, `worldZ = N − 4689000` (z crece al norte). Ventana 6000 × 6000 m.
- `y` de mundo = altura **absoluta − 870** (`verticalDatum` de `public/terrain/config.json`).
- Lon/lat → mundo: `wgs84ToWorld(config, lon, lat)` de `src/config.ts`. Se puede
  transpilar con `typescript` como hace `scripts/terrain/validate_terrain.mjs`
  (mirá ese archivo, es el patrón del repo).
- **LA TRAMPA DE ESTE PROYECTO**: la altura se pide SIEMPRE a `terrain.heightAt(x, z)`
  (mundo) o al `heightfield` real. **NUNCA reimplementes la interpolación**: la malla
  usa la diagonal SO→NE (`src/terrain.ts:167-180`) y una bilineal da hasta 0,29 m de
  error. Si necesitás altura en un script de Node, transpilá `src/heightfield.ts`
  como hace `validate_terrain.mjs`. Está prohibido duplicar esa matemática.
- `terrain.heightAt` **fuera de la ventana devuelve 0** (el absoluto − datum). Recortá
  la coordenada al dominio antes de muestrear.
- Solo `@babylonjs/core` (ya instalado). **Imports profundos y específicos**
  (`@babylonjs/core/Meshes/mesh`, `@babylonjs/core/Meshes/thinInstanceMesh`, etc.),
  nunca `import { X } from '@babylonjs/core'`: el bundle ya es grande y el usuario
  pidió NO empeorarlo. **Cero dependencias nuevas.**
- Comentarios en español, explicando **por qué**, no qué.

## API que vas a consumir (ya existe, no la cambies)

```ts
// src/terrain.ts
export interface WorldTerrain {
  readonly config: TerrainConfig;
  readonly meshes: readonly Mesh[];
  readonly samplers: readonly HeightfieldSampler[];
  readonly viewRadius: number;
  heightAt(x: number, z: number): number;      // mundo, datum restado
  normalAt(x: number, z: number, out?: Vector3): Vector3;
  sampleHeight(x: number, z: number): TerrainSample;
  cull(camera: Camera): number;
  activeTriangles(): number;
  center(): { x: number; z: number; height: number };
  dispose(): void;
}
export async function loadTerrain(scene: Scene, config: TerrainConfig): Promise<WorldTerrain>;
```

## Contrato que tenés que cumplir EXACTAMENTE

`src/environment/vegetation.ts`:

```ts
import type { Scene } from '@babylonjs/core/scene';
import type { WorldTerrain } from '../terrain';

/** Corredor a despejar: una polilínea y su semiancho. */
export interface VegetationCorridor {
  readonly points: readonly { readonly x: number; readonly z: number }[];
  readonly halfWidthM: number;
}
/** Zona a despejar por completo (aparición, objetivo). */
export interface VegetationClearing {
  readonly x: number;
  readonly z: number;
  readonly radiusM: number;
}

export interface VegetationStats {
  readonly trees: number;
  readonly shrubs: number;
  readonly grassTufts: number;
  readonly meshes: number;
  readonly instances: number;
  readonly near: number;
  readonly mid: number;
  readonly far: number;
  readonly excludedByCorridor: number;
}

export interface Vegetation {
  readonly stats: VegetationStats;
  /** Ajusta el LOD por distancia a la cámara. Se llama cada frame. */
  update(cameraPosition: { readonly x: number; readonly y: number; readonly z: number }): void;
  dispose(): void;
}

export interface LoadVegetationOptions {
  readonly corridors: readonly VegetationCorridor[];
  readonly clearings: readonly VegetationClearing[];
  /** URL base de los datos. Por defecto `/vegetation/vegetation.json`. */
  readonly url?: string;
}

export async function loadVegetation(
  scene: Scene,
  terrain: WorldTerrain,
  options: LoadVegetationOptions,
): Promise<Vegetation>;
```

## Qué tenés que construir

1. **Datos** (`scripts/environment/build_vegetation.mjs`, determinista, con semilla):
   - Parte de landcover real de OSM. Ya tenés `data/geo/raw/osm_landcover_bbox.json`
     y `data/geo/raw/osm_forest_bbox.json`, pero **su bbox es el de las carreteras**:
     descargá landcover para la **ventana completa de 6 × 6 km** con
     `scripts/geo/overpass.sh <query> <salida>` (mirá `data/roads/raw/*_query.txt`
     para el formato). Guardá en `data/gameplay/raw/` con manifiesto (query,
     endpoint, timestamp, bytes, sha256) — esa es la política del repo.
   - Clasificá en **FOREST** (`landuse=forest`, `natural=wood`), **GRASS**
     (`natural=grassland|scrub`, `landuse=meadow`) y **FIELDS** (`landuse=farmland`).
   - Sembrá instancias con una grilla jittereada (semilla fija → reproducible) dentro
     de cada polígono, con densidad por clase. **No** llenes 36 km²: priorizá lo que
     rodea la primera ruta (abajo) y usá menos densidad lejos.
   - Aplicá los corredores y las zonas despejadas **en el script**, no en runtime.
   - Cada instancia: `{ x, z, type, scale, rotation, tier }` con
     `tier ∈ 'near' | 'mid' | 'far'`.
   - Salida `public/vegetation/vegetation.json` con `meta` (fecha, script, sha256 de
     la fuente, semilla, conteos) + `instances`.
   - **`y` no va en los datos**: se pide al terreno en runtime. Una sola verdad.

2. **Runtime** (`src/environment/vegetation.ts`):
   - **2–4 tipos de árbol** + **1–2 de arbusto** + hierba visual, **procedurales**
     (cilindro/tronco + cono o icosaedro de copa). Sin Blender, sin GLB, sin texturas.
   - **Thin instances** obligatorio (`mesh.thinInstanceAdd` / `thinInstanceSetBuffer`).
     Un mesh por tipo y tier. **Prohibido un mesh por árbol.** Es el punto de la tarea.
   - LOD por distancia a la cámara en `update()`: `far` barato (copa sin tronco o
     billboard de pocos tris). Nada de `setEnabled(false)` por instancia: movés los
     buffers de instancias por tier.
   - Materiales planos (`StandardMaterial` con colores rurales, sin `PBRMaterial`
     pesado). Sin sombras proyectadas por la vegetación (caro): sólo el sol del
     `atmosphere` (lo hace otro worker).
   - `dispose()` limpio.

## La primera ruta (te importa para priorizar densidad y corredores)

Sale del grafo real de OSM, está en `src/gameplay/first-route.ts` (leelo, no lo
toques). Resumen: inicio en Villafranca **(3088, 3935)**, carretera 661 m hacia el
sur, entrada a pista en **(3269, 3372)**, y pista subiendo 164 m hasta el objetivo
en **(4178, 2060)**. Los `waypoints` son el corredor a despejar (usá semiancho
≈ 12 m para ROAD y ≈ 8 m para TRACK; distinguí por `waypoint.leg`). Despejá también
un círculo de 30 m en el inicio y de `targetClearRadiusM` (18 m) en el objetivo.

## Verificación (obligatoria, y honesta)

- `npm run typecheck` limpio. `npm run build` limpio.
- Un check proporcional en `scripts/environment/build_vegetation.mjs --check`
  (modo que NO escribe): re-deriva, compara con el archivo commiteado, y **verifica**:
  - ninguna instancia dentro de un corredor o de una zona despejada
  - ninguna instancia fuera de la ventana de 6000 × 6000
  - conteos > 0 y suma de tiers = total (**sin esto, un archivo vacío pasaría**)
  - **ninguna instancia por debajo del suelo**: muestreá el terreno en cada instancia
    (o en una muestra aleatoria de ≥ 2000 con semilla fija) y comprobá que
    `terrain.heightAt` es finito y que la base del árbol no queda flotando.
- **Mirá el resultado con los ojos**. Corré `npm run dev` o `npm run preview`, y
  capturá con Chrome headless + CDP (mirá `scripts/vehicle/capture_vehicle.mjs` y
  `scripts/roads/draping/capture_draping.mjs`: es el patrón del repo, sin Playwright,
  cero dependencias nuevas). Dejá 2–3 capturas en `output/milestone1/` con estos
  nombres exactos: `08_vegetation_aerial.png`, `09_vegetation_ground.png`. Describí
  lo que ves (¿hay árboles en la carretera? ¿flotan? ¿se ven como un bosque?).
- **No declares éxito por compilar.** Si algo no se ve bien, decilo con la captura.
- Medí `window.__game.perf()` antes y después (draw calls, triángulos, fps). El fps
  en headless es SwiftShader (CPU): **no es señal de rendimiento**, pero el conteo de
  draw calls y triángulos SÍ. Reportá ese par de números.

## Al terminar

Guardá en Engram (`mem_save`, `project: "montes-de-oca"`) cualquier decisión no
obvia, trampa o hallazgo. Después respondé, corto:

```
FILES: <archivos>
WHAT: <qué hiciste, 3-6 líneas>
VERIFY: <comandos exactos y su resultado real; qué capture mirás y qué se ve>
NUMBERS: draw calls y triángulos antes/después; instancias por tier
RISKS: <lo que no está probado o puede fallar>
```
