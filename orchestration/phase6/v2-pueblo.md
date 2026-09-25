# TAREA v2-pueblo — FASE E de la milestone 1

**Modelo**: `opencode/mimo-v2.6-flash-free`
**Proyecto**: `/home/kiri_/projects/montes-de-oca-offroad`
**Referencia (SOLO LECTURA, jamás escribir)**: `/home/kiri_/projects/montes-de-oca`

## Contexto: la milestone

El juego ya tiene terreno real (IGN MDT05, 36 tiles de 1 km a 5 m), red viaria real
de OSM drapeada, y un 4x4 con física de pendiente. La milestone en curso es un
**primer loop jugable**: Villafranca → carretera → pista → objetivo → regreso.
El jugador **arranca en Villafranca**, así que el punto de inicio tiene que
**parecer un pueblo** y no una explanada con asfalto.

## Tus archivos (ÚNICOS, sos el único escritor)

- `scripts/environment/build_village.mjs`
- `scripts/environment/fetch_buildings.sh` (o `.py`; usá `scripts/geo/overpass.sh`)
- `data/gameplay/raw/osm_buildings_villafranca.json` + `..._manifest.json`
- `public/village/buildings.json` (generado; se versiona)
- `src/environment/village.ts`
- `docs/environment/VILLAGE.md` — **máximo 30 líneas**.

**PROHIBIDO tocar**: `src/main.ts`, `index.html`, `package.json`, `src/terrain.ts`,
`src/heightfield.ts`, `src/config.ts`, `src/road-draping.ts`, `src/vehicle/**`,
`src/gameplay/**`, `src/environment/vegetation.ts`, `scripts/roads/**`,
`scripts/terrain/**`, `public/terrain/**`, `public/roads/**`.

## Convenciones del proyecto (no inventar otras)

- `worldX = E − 471500`, `worldZ = N − 4689000` (z crece al norte). Ventana 6000 × 6000 m.
- `y` de mundo = altura **absoluta − 870** (`verticalDatum` de `public/terrain/config.json`).
- Lon/lat → mundo: `wgs84ToWorld(config, lon, lat)` de `src/config.ts`. Transpilá con
  `typescript` como hace `scripts/terrain/validate_terrain.mjs` (ese es el patrón).
- **LA TRAMPA DE ESTE PROYECTO**: la altura se pide SIEMPRE a `terrain.heightAt(x, z)`
  o al `heightfield` real. **NUNCA reimplementes la interpolación**: la malla usa la
  diagonal SO→NE (`src/terrain.ts:167-180`) y una bilineal da hasta 0,29 m de error.
- `terrain.heightAt` **fuera de la ventana devuelve 0**. Recortá al dominio.
- Solo `@babylonjs/core`. **Imports profundos** (`@babylonjs/core/Meshes/meshBuilders`,
  etc.), nunca `from '@babylonjs/core'`. **Cero dependencias nuevas.**
- Comentarios en español, explicando **por qué**.

## API existente (no la cambies)

```ts
// src/terrain.ts
heightAt(x: number, z: number): number;                 // mundo, datum restado
normalAt(x: number, z: number, out?: Vector3): Vector3;
```
`scripts/geo/overpass.sh <query-file> <out-file>`: POST a Overpass con User-Agent,
reintentos y reporte de HTTP/bytes/sha256. Mirá
`data/roads/raw/osm_highways_window_query.txt` y `scripts/roads/fetch_osm_roads.py`
para el formato de query y de manifiesto que usa el repo.

## Contrato que tenés que cumplir EXACTAMENTE

`src/environment/village.ts`:

```ts
import type { Scene } from '@babylonjs/core/scene';
import type { WorldTerrain } from '../terrain';

export interface VillageStats {
  readonly buildings: number;
  readonly meshes: number;
  readonly triangles: number;
  readonly footprintAreaM2: number;
  readonly tallestM: number;
  /** Edificios descartados por invadir el punto de aparición. */
  readonly droppedAtSpawn: number;
}

export interface Village {
  readonly stats: VillageStats;
  dispose(): void;
}

export interface LoadVillageOptions {
  /** URL de los datos. Por defecto `/village/buildings.json`. */
  readonly url?: string;
  /** Punto que NO puede quedar tapado por una casa (la aparición del 4x4). */
  readonly keepClearAt?: { readonly x: number; readonly z: number } | null;
  /** Radio a despejar alrededor de `keepClearAt`, en metros. */
  readonly keepClearRadiusM?: number;
}

export async function loadVillage(
  scene: Scene,
  terrain: WorldTerrain,
  options?: LoadVillageOptions,
): Promise<Village>;
```

## Qué tenés que construir

1. **Descarga** de footprints reales de Villafranca. El pueblo está en
   `42.3883784, -3.3086147` (ver `data/geo/raw/osm_village_node.json`). Pedí
   `way["building"]` en un radio que cubra el casco urbano (**~900 m** alrededor del
   nodo; si el casco es más grande, ampliá, pero no traigas media provincia).
   Guardá con manifiesto (query, endpoint, timestamp OSM, bytes, sha256).

2. **Build** (`scripts/environment/build_village.mjs`, determinista):
   - Convertí cada `way` cerrado a un polígono en coordenadas de mundo.
   - Descartá: polígonos < 4 vértices, área < 12 m², y los que caen fuera de la
     ventana. **Reportá cuántos descartaste y por qué** (un descarte silencioso es
     cómo se pierden datos sin darse cuenta).
   - Altura: `building:levels` si está (× 3,2 m), si no `height` en metros, si no un
     valor por tipo (2 plantas por defecto). Marcá en los datos **de dónde salió la
     altura** (`levels | height | tipo`) — es un tag de OSM, no una medición.
   - Clasificá en **2–4 materiales rurales**: `piedra`, `revoco`, `teja`, `ladrillo`.
     Un `materialKind` por edificio (heurística por tags; no importa si es perfecta).
   - Salida `public/village/buildings.json`: `meta` (fecha, script, sha256 de la
     fuente, conteos) + `buildings: [{ id, footprint: [[x,z],...], heightM, levels,
     heightSource, materialKind, roofKind }]`.
   - **No** guardes `y`: se pide al terreno al construir.

3. **Runtime** (`src/environment/village.ts`):
   - Por cada edificio: **extrusión del footprint** hacia arriba + **tejado sencillo**
     (a dos aguas si el footprint es alargado, plano si es casi cuadrado). Sin
     ventanas individuales, sin puertas modeladas, sin monumentos.
   - **La base tiene que tocar el suelo.** Estirá cada edificio desde el **mínimo**
     `terrain.heightAt` de sus vértices hacia arriba y agregá un faldón/base de
     ~1,5 m hacia abajo, para que en pendiente no quede flotando ni cortado. Este es
     el defecto que más se ve en un pueblo sobre ladera: **verificalo en pendiente**.
   - **Pocas mallas**: fusioná los edificios por material (`Mesh.MergeMeshes` o
     `VertexData` propio). Objetivo: **≤ 4 mallas de cuerpo + ≤ 4 de tejado** para
     100 edificios. Prohibido un mesh por casa.
   - Descartá (y contá en `droppedAtSpawn`) los que invadan `keepClearAt` con radio
     `keepClearRadiusM`: el 4x4 aparece en **(3088, 3935)** y no puede nacer dentro
     de una casa.
   - Materiales: `StandardMaterial` plano, colores rurales (piedra, revoco, teja,
     ladrillo). Sin texturas. `dispose()` limpio.

## Verificación (obligatoria, y honesta)

- `npm run typecheck` y `npm run build` limpios.
- `node scripts/environment/build_village.mjs --check` (modo que NO escribe):
  re-deriva, compara con el archivo commiteado y **verifica de verdad**:
  - `buildings > 0` (**sin esto un archivo vacío pasaría**)
  - ningún footprint fuera de la ventana
  - ninguna altura ≤ 0 ni > 60 m
  - **el punto de aparición (3088, 3935) queda libre** con radio ≥ 8 m
  - **ninguna base flotante**: para ≥ 200 edificios al azar (semilla fija), el mínimo
    `terrain.heightAt` de los vértices del footprint tiene que estar dentro del rango
    vertical del edificio construido. Esto es lo que separa "parece un pueblo" de
    "casas flotando".
- **Mirá el resultado con los ojos.** Capturá con Chrome headless + CDP (patrón:
  `scripts/vehicle/capture_vehicle.mjs`, `scripts/roads/draping/capture_draping.mjs`;
  sin Playwright, cero dependencias nuevas). 2 capturas en `output/milestone1/`:
  `10_village_street.png` (a nivel de calle, desde la aparición) y
  `11_village_aerial.png`. Describí lo que ves.
- Medí `window.__game.perf()` antes y después (draw calls, triángulos). El fps en
  headless es SwiftShader: **no es señal**; draw calls y triángulos sí.
- **No declares éxito por compilar.**

## Al terminar

Guardá en Engram (`mem_save`, `project: "montes-de-oca"`) las decisiones no obvias.
Después respondé, corto:

```
FILES: <archivos>
WHAT: <qué hiciste, 3-6 líneas>
VERIFY: <comandos exactos y su resultado real; qué captura mirás y qué se ve>
NUMBERS: edificios, descartados y por qué, draw calls/triángulos antes y después
RISKS: <lo que no está probado>
```
