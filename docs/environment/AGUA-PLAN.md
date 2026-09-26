# Agua (ríos, arroyos y embalse de Alba) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dibujar el agua real de la ventana jugable (embalse de Alba con su presa, río Oca, Retorto y arroyos) como escenografía low-poly, con reglas de vadeo, hundimiento y enfangado del 4x4.

**Architecture:** consulta Overpass → crudo versionado → constructor Python (solo stdlib) → `public/water/water.json` con láminas pre-trianguladas, cintas de río y un campo de profundidad del vaso → módulo `src/environment/water.ts` (≤3 mallas, color por vértice, sin animación) → API de consulta consumida por el paso de simulación del 4x4 en `src/main.ts`.

**Tech Stack:** TypeScript estricto + Babylon.js (runtime), Python 3 stdlib (datos), Node + Chrome headless vía CDP (arneses, sin dependencias nuevas).

**Spec:** `docs/environment/AGUA.md`

## Global Constraints

- **Cero dependencias nuevas**: ni npm ni pip. Python solo stdlib; los arneses usan el WebSocket nativo de Node (patrón de `scripts/roads/draping/capture_draping.mjs`).
- **No tocar** `src/vehicle/physics.ts` ni `src/player/**`: las reglas del agua viven en el paso de simulación de `src/main.ts` y solo añaden límite de velocidad y un offset visual.
- **≤3 mallas nuevas**, ≤25 k triángulos, `water.json` ≤0,5 MB, 0 trabajo por frame salvo consultas O(1) a la grilla.
- **El terreno no se modifica**: nada de excavar el DEM (ver spec §3.2).
- **Toggle `?water=0`** obligatorio, con el mismo patrón que `?pueblo=0` / `?drape=0`.
- **Estilo del repo**: TypeScript de 2 espacios, comillas simples, punto y coma, comentarios en español; commits convencionales (`feat(water): ...`).
- **Verificación por tarea**: `npm run typecheck` y `npm test` siempre en verde; las tareas de datos añaden `python3 -m py_compile`.
- **Reglas solo en modo conducción** (`player.mode === 'driving'`); a pie el agua es decorativa.
- **El vado del Oca en la ruta debe quedar ≤0,35 m de calado**: es requisito de misión, no preferencia.

## Review Focus

Cinco formas de fallar que el spec implica y que ninguna prueba de tarea cubre por sí sola; cada una baja a una prueba concreta en la tarea que le corresponde:

1. **Vado impasable** en la ruta de misión → prueba de regresión con el arnés de milestone (Tarea 7).
2. **Borde recortado del vaso** contra el límite de la ventana (línea recta visible) → captura y medición del borde oeste (Tarea 7).
3. **Retorno a punto inseguro** (pendiente >20° o dentro de una huella) → prueba de `nearestSafeShore` con casos de pendiente (Tarea 5).
4. **Profundidad en seco** (una consulta fuera del agua devuelve >0 y activa el hundimiento en tierra) → prueba unitaria del campo (Tarea 5).
5. **`?water=0` deja el mundo a medias** (mallas huérfanas, reglas activas sin agua) → medición con/sin capa y prueba de reglas apagadas (Tarea 4 y 6).

---

### Task 1: Consulta Overpass y crudo versionado

**Files:**
- Create: `scripts/water/fetch_water.py`
- Create: `data/water/raw/osm_water_window_query.txt` (lo escribe el script)
- Create: `data/water/raw/osm_water_window.json` (crudo)
- Create: `data/water/raw/osm_water_window_manifest.json` (sha256 + conteos)

**Interfaces:**
- Consumes: `public/terrain/config.json` (bounds y proyección).
- Produces: `osm_water_window.json` (formato Overpass `out geom tags`), `manifest.json` con `{sha256, bytes, counts: {reservoir, dam, river, stream, lake, pond}}`, usado por la Tarea 2.

- [ ] **Step 1: Escribir el script**

```python
#!/usr/bin/env python3
"""Descarga el agua de OSM dentro de la ventana jugable y la versiona cruda.

Mismo patrón que data/roads/raw: consulta + JSON crudo + manifiesto con sha256.
Sin dependencias: urllib de la stdlib.
"""
from __future__ import annotations
import hashlib, json, sys, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "public" / "terrain" / "config.json"
OUT_DIR = ROOT / "data" / "water" / "raw"
QUERY_FILE = OUT_DIR / "osm_water_window_query.txt"
DATA_FILE = OUT_DIR / "osm_water_window.json"
MANIFEST = OUT_DIR / "osm_water_window_manifest.json"
ENDPOINT = "https://overpass-api.de/api/interpreter"
UA = "montes-de-oca/1.0 (water fetch)"

def window_bbox() -> tuple[float, float, float, float]:
    cfg = json.loads(CONFIG.read_text())
    o, p = cfg["origin"], cfg["projection"]
    b = cfg["bounds"]
    west = o["lon"] + b["e"][0] / p["metersPerDegreeLon"]
    east = o["lon"] + b["e"][1] / p["metersPerDegreeLon"]
    south = o["lat"] + b["n"][0] / p["metersPerDegreeLat"]
    north = o["lat"] + b["n"][1] / p["metersPerDegreeLat"]
    return south, west, north, east

def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    s, w, n, e = window_bbox()
    query = f"""[out:json][timeout:90];
(
  way["waterway"]({s:.6f},{w:.6f},{n:.6f},{e:.6f});
  way["natural"="water"]({s:.6f},{w:.6f},{n:.6f},{e:.6f});
  rel["natural"="water"]({s:.6f},{w:.6f},{n:.6f},{e:.6f});
);
out geom tags;
"""
    QUERY_FILE.write_text(query)
    body = urllib.parse.urlencode({"data": query}).encode()
    request = urllib.request.Request(ENDPOINT, data=body, headers={"User-Agent": UA})
    with urllib.request.urlopen(request, timeout=180) as response:
        raw = response.read()
    payload = json.loads(raw)
    elements = payload.get("elements", [])
    kinds = {"reservoir": 0, "dam": 0, "river": 0, "stream": 0, "lake": 0, "pond": 0, "wastewater": 0}
    for element in elements:
        tags = element.get("tags", {})
        if tags.get("water") == "reservoir": kinds["reservoir"] += 1
        if tags.get("water") == "wastewater": kinds["wastewater"] += 1
        if tags.get("water") == "lake": kinds["lake"] += 1
        if tags.get("water") == "pond": kinds["pond"] += 1
        if tags.get("waterway") == "dam": kinds["dam"] += 1
        if tags.get("waterway") == "river": kinds["river"] += 1
        if tags.get("waterway") == "stream": kinds["stream"] += 1
    DATA_FILE.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    digest = hashlib.sha256(DATA_FILE.read_bytes()).hexdigest()
    MANIFEST.write_text(json.dumps({
        "generado_por": "scripts/water/fetch_water.py",
        "endpoint": ENDPOINT,
        "bbox": {"south": s, "west": w, "north": n, "east": e},
        "sha256": digest,
        "bytes": DATA_FILE.stat().st_size,
        "elements": len(elements),
        "counts": kinds,
    }, indent=2, ensure_ascii=False) + "\n")
    print(f"[agua] {len(elements)} elementos · {kinds} · sha256 {digest[:12]}")
    if kinds["reservoir"] < 1 or kinds["dam"] < 1 or kinds["river"] < 2:
        print("[agua] FALLA: faltan elementos esperados (embalse, presa, ríos)", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Ejecutar y verificar el crudo**

Run: `cd /home/ubuntu/.worktrees/montes-de-oca && python3 scripts/water/fetch_water.py`
Expected: imprime conteos con `reservoir ≥ 1`, `dam ≥ 1`, `river ≥ 2` y deja los tres archivos en `data/water/raw/`.

- [ ] **Step 3: Verificar el manifiesto**

Run: `python3 -c "import hashlib,json,pathlib;p=pathlib.Path('data/water/raw');m=json.loads((p/'osm_water_window_manifest.json').read_text());print(m['sha256']==hashlib.sha256((p/'osm_water_window.json').read_bytes()).hexdigest(), m['counts'])"`
Expected: `True` y los conteos.

- [ ] **Step 4: Commit**

```bash
git add scripts/water/fetch_water.py data/water/raw
git commit -m "feat(water): consulta Overpass y crudo versionado del agua de la ventana"
```

---

### Task 2: Constructor — láminas, cota del vaso y grilla de profundidad

**Files:**
- Create: `scripts/water/build_water.py`
- Create: `public/water/water.json`, `public/water/stats.json`, `public/water/ATTRIBUTION.md`
- Create: `scripts/water/validate_water.mjs`

**Interfaces:**
- Consumes: `data/water/raw/osm_water_window.json` (Tarea 1), `public/terrain/tiles/*.json` (DEM).
- Produces: `water.json` con `{schemaVersion, meta, levelM, sheets[], ribbons[], dam, depthGrid}`; `validate_water.mjs` como validador de invariantes reutilizable por `npm test`.

- [ ] **Step 1: Escribir el núcleo del constructor (proyección, DEM, cota y grilla)**

```python
PROJECTION = cfg["projection"]; ORIGIN = cfg["origin"]
DATUM_M = 870.0                      # datum vertical del juego (absoluta - 870 = mundo)
def to_world(lon, lat):
    return ((lon - ORIGIN["lon"]) * PROJECTION["metersPerDegreeLon"],
            (lat - ORIGIN["lat"]) * PROJECTION["metersPerDegreeLat"])

def load_tiles() -> list[dict]:
    tiles = []
    for path in sorted((ROOT / "public" / "terrain" / "tiles").glob("tile_*.json")):
        tiles.append(json.loads(path.read_text())["grid"])
    return tiles

def height_at(tiles, x, z) -> float:
    for g in tiles:
        if g["x0"] - 0.01 <= x <= g["x0"] + (g["columns"] - 1) * g["dx"] + 0.01 and \
           g["z0"] - 0.01 <= z <= g["z0"] + (g["rows"] - 1) * g["dz"] + 0.01:
            c = round((x - g["x0"]) / g["dx"]); r = round((z - g["z0"]) / g["dz"])
            return g["heights"][r * g["columns"] + c]
    raise KeyError((x, z))

def pool_level(tiles, ring, fallback: float) -> float:
    """Cota del vaso: moda del DEM dentro del polígono en bins de 1 m."""
    counts: dict[int, int] = {}
    for (x, z) in sample_ring_interior(ring, step=25.0):
        v = height_at(tiles, x, z)
        counts[round(v)] = counts.get(round(v), 0) + 1
    if not counts:
        return fallback
    return float(max(counts.items(), key=lambda kv: kv[1])[0])

DAM_LINE = dam_endpoints_world()      # extremos del way waterway=dam
def dam_distance(x, z) -> float:
    return point_segment_distance(x, z, *DAM_LINE)

def depth_grid(tiles, ring, level_m: float, cell_m: float = 25.0) -> dict:
    """Profundidad plausible: 0 en la orilla, hasta 18 m junto a la presa."""
    xs = [p[0] for p in ring]; zs = [p[1] for p in ring]
    x0, z0 = min(xs), min(zs)
    cols = int((max(xs) - x0) / cell_m) + 1; rows = int((max(zs) - z0) / cell_m) + 1
    shore_dist = {  # distancia a la orilla por celda, con muestreo del anillo
        (c, r): min_distance_to_ring(x0 + c * cell_m, z0 + r * cell_m, ring, step=10.0)
        for r in range(rows) for c in range(cols)
    }
    dam_dist = {k: dam_distance(x0 + k[0] * cell_m, z0 + k[1] * cell_m) for k in shore_dist}
    max_shore = max(shore_dist.values()) or 1.0
    max_dam = max(dam_dist.values()) or 1.0
    depths = []
    for r in range(rows):
        for c in range(cols):
            x, z = x0 + c * cell_m, z0 + r * cell_m
            inside = point_in_polygon(x, z, ring)
            near_dam = 1.0 - min(1.0, dam_dist[(c, r)] / max_dam)
            deep = min(1.0, shore_dist[(c, r)] / (0.45 * max_shore))
            depths.append(int(round(18.0 * deep * (0.35 + 0.65 * near_dam))) if inside else 0)
    return {"originX": x0, "originZ": z0, "cellM": cell_m, "cols": cols, "rows": rows, "depthsDm": depths,
            "levelM": round(level_m, 2), "maxDepthM": max(depths) / 10.0 if depths else 0}
```

- [ ] **Step 2: Triangulación de láminas con recorte a la ventana**

```python
def clip_ring_to_window(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Recorte Sutherland–Hodgman contra el rectángulo de la ventana."""
    # 4 pasadas (x≥0, x≤6000, z≥0, z≤6000) contra el rectángulo del terreno
    ...

def ear_clip(ring: list[tuple[float, float]]) -> list[int]:
    """Triangulación en abanico con orejas: devuelve índices sobre `ring`."""
    ...

def sheet_triangles_area(ring, indices) -> float: ...
```

Invariante que se prueba en el validador: la suma de áreas de los triángulos coincide con el área del polígono dentro del 0,5 %.

- [ ] **Step 3: Escribir `water.json`, `stats.json` y `ATTRIBUTION.md`**

```python
payload = {
  "schemaVersion": 1,
  "meta": {"generadoPor": "scripts/water/build_water.py", "sourceSha256": manifest["sha256"],
           "fecha": ..., "scriptSha256": sha_of(__file__)},
  "levelM": round(level, 2),
  "sheets": [{"id": "embalse-alba", "kind": "reservoir", "name": "Embalse de Alba",
              "levelM": round(level, 2), "ring": [...], "indices": [...], "foamM": 1.5}, ...],
  "ribbons": [],           # Tarea 3
  "dam": {"a": [...], "b": [...], "crestM": round(level + 0.6, 2), "baseM": ..., "widthM": 6.0},
  "depthGrid": grid,
}
```

- [ ] **Step 4: Escribir el validador de invariantes**

```javascript
// scripts/water/validate_water.mjs
const checks = [];
const ok = (cond, msg) => { checks.push([cond, msg]); if (!cond) process.exitCode = 1; };
ok(water.schemaVersion === 1, 'schemaVersion');
ok(water.sheets.every((s) => s.ring.length >= 3 && s.indices.length % 3 === 0), 'láminas trianguladas');
ok(water.sheets.every((s) => s.ring.every(([x, z]) => x >= -0.5 && x <= 6000.5 && z >= -0.5 && z <= 6000.5)), 'láminas dentro de la ventana');
ok(Math.abs(triangleArea(water) - polygonArea(water.sheets[0].ring)) / polygonArea(water.sheets[0].ring) < 0.005, 'área del embalse');
ok(water.depthGrid.depthsDm.every((d) => d >= 0 && d <= 200), 'profundidades en rango');
ok(maxDepthNearDam(water) > 100 && minDepthAtShore(water) === 0, 'profundidad máxima junto a la presa y 0 en la orilla');
```

- [ ] **Step 5: Correr el validador y el modo `--check`**

Run: `python3 scripts/water/build_water.py --check && node scripts/water/validate_water.mjs`
Expected: `OK … checks` y sin diferencias (`--check` re-deriva y compara byte a byte).

- [ ] **Step 6: Commit**

```bash
git add scripts/water public/water
git commit -m "feat(water): constructor de láminas, cota del vaso y grilla de profundidad"
```

---

### Task 3: Cintas de río/arroyo y muro de la presa

**Files:**
- Modify: `scripts/water/build_water.py` (rellenar `ribbons` y `dam`)
- Modify: `scripts/water/validate_water.mjs`

**Interfaces:**
- Consumes: `height_at(tiles, x, z)`, `to_world(lon, lat)`.
- Produces: `ribbons[]` con `{kind, name, widthM, points: [[x, z, terrainY]...], caladoM}` y `dam` con `{a, b, crestM, baseM, widthM}`; los consume la Tarea 4.

- [ ] **Step 1: Añadir el remuestreo de cintas y el cálculo de la cota de paso**

```python
WIDTH_BY_KIND = {"river": 7.0, "stream": 2.5, "ditch": 1.2, "dam": 6.0}
CALADO_M = {"river": 0.25, "stream": 0.18, "ditch": 0.12}

def ribbon_from_way(tiles, element, kind) -> dict:
    ring = [to_world(g["lon"], g["lat"]) for g in element["geometry"]]
    pts = resample(ring, step=2.5)                      # 2,5 m como las pistas
    width = float(element.get("tags", {}).get("width") or WIDTH_BY_KIND[kind])
    return {"kind": kind, "name": element.get("tags", {}).get("name", ""),
            "widthM": max(0.8, width), "caladoM": CALADO_M[kind],
            "points": [[round(x, 2), round(z, 2), round(height_at(tiles, x, z), 2)] for x, z in pts]}

def ford_depths(tiles, ribbons, cruces) -> dict:
    """Calado real en los cruces de la ruta: (superficie - terreno) en el punto."""
    ...
```

- [ ] **Step 2: Añadir el muro de la presa**

```python
dam_way = next(e for e in elements if e.get("tags", {}).get("waterway") == "dam")
a, b = (to_world(*dam_way["geometry"][0]) if len(dam_way["geometry"]) == 1 else
        (to_world(dam_way["geometry"][0]["lon"], dam_way["geometry"][0]["lat"]),
         to_world(dam_way["geometry"][-1]["lon"], dam_way["geometry"][-1]["lat"])))
crest = max(height_at(tiles, *a), height_at(tiles, *b)) + 0.6
```

- [ ] **Step 3: Extender el validador con los invariantes de cintas y del vado**

```javascript
ok(water.ribbons.length >= 60, 'cintas de río/arroyo');
ok(water.ribbons.every((r) => r.widthM > 0 && r.points.length >= 2), 'cintas con ancho y eje');
const ocaFords = water.ribbons.filter((r) => r.kind === 'river' && nearOcaFords(r));
ok(ocaFords.length >= 1, 'el Oca cruza la ruta');
ok(ocaFords.every((r) => r.caladoM <= 0.35), 'vado del Oca ≤ 0,35 m');
ok(water.dam.widthM > 0 && water.dam.crestM > water.levelM, 'muro por encima de la lámina');
```

- [ ] **Step 4: Re-derivar y validar**

Run: `python3 scripts/water/build_water.py && node scripts/water/validate_water.mjs`
Expected: todas las comprobaciones en verde, con el conteo de cintas impreso.

- [ ] **Step 5: Commit**

```bash
git add scripts/water public/water
git commit -m "feat(water): cintas de ríos y arroyos, y muro de la presa"
```

---

### Task 4: Módulo runtime, mallas y toggle

**Files:**
- Create: `src/environment/water.ts`
- Modify: `src/main.ts` (carga, `?water=0`, `window.__game.water`)
- Create: `scripts/water/capture_water.mjs` (arnés de captura)

**Interfaces:**
- Consumes: `public/water/water.json`, `WorldTerrain` (`heightAt`).
- Produces: `loadWater(scene, terrain, options): Promise<Water>` con `Water = { stats: WaterStats; depthAt(x, z): number; isMuddy(x, z): boolean; nearestSafeShore(x, z): { x: number; z: number } | null; dispose(): void }`; `WaterStats = { sheets: number; ribbons: number; meshes: number; triangles: number; dataBytes: number }`.

- [ ] **Step 1: Escribir el módulo con las tres mallas**

```typescript
/** Color por vértice: claro en la orilla, azul oscuro en el vaso; el terreno no se toca. */
function sheetColor(depthM: number, foam: boolean): [number, number, number] {
  if (foam) return [0.86, 0.9, 0.92];
  const t = Math.max(0, Math.min(1, depthM / 18));
  return [0.32 - 0.18 * t, 0.52 - 0.24 * t, 0.66 - 0.24 * t];
}

export async function loadWater(scene: Scene, terrain: WorldTerrain, options: LoadWaterOptions = {}): Promise<Water> {
  const response = await fetch(options.url ?? DEFAULT_URL);
  if (!response.ok) throw new Error(`agua: no se pudo cargar ${options.url ?? DEFAULT_URL} (HTTP ${response.status})`);
  const data = parseWaterData(await response.json());
  const meshes: Mesh[] = [];
  meshes.push(buildSheets(scene, data));       // agua:laminas
  meshes.push(buildRibbons(scene, data, terrain)); // agua:cintas
  if (data.dam) meshes.push(buildDam(scene, data.dam, terrain)); // agua:presa
  ...
}
```

- [ ] **Step 2: Integrar en `main.ts` con el toggle**

```typescript
const aguaParam = params.get('water');
const waterEnabled = aguaParam === null || !(aguaParam === '0' || aguaParam.toLowerCase() === 'false');
let water: Water | null = null;
if (waterEnabled) {
  try {
    water = await loadWater(scene, terrain, { url: publicUrl('/water/water.json') });
    console.info(`[agua] ${water.stats.sheets} láminas · ${water.stats.ribbons} cintas · ${water.stats.meshes} mallas`);
  } catch (error) {
    water = null;                      // decorativo: si falla, el juego arranca igual
    console.warn('[agua] no se pudo cargar la capa decorativa', error);
  }
}
```

- [ ] **Step 3: Exponer la API y medir el coste**

```typescript
water: water ? { stats: () => water!.stats, depthAt: (x, z) => water!.depthAt(x, z), isMuddy: (x, z) => water!.isMuddy(x, z) } : null,
```

- [ ] **Step 4: Arnés de captura y coste**

```javascript
// scripts/water/capture_water.mjs: vistas libres (?px…), mide perf() con y sin ?water=0
const con = await medir(cdp, `${BASE}/?px=2350&py=175&pz=1300&tx=2434&ty=150&tz=1523`);
const sin = await medir(cdp, `${BASE}/?px=2350&py=175&pz=1300&tx=2434&ty=150&tz=1523&water=0`);
check('agua: 3 mallas visibles', con.drawCalls - sin.drawCalls >= 2, `${sin.drawCalls} -> ${con.drawCalls}`);
```

Run: `node scripts/water/capture_water.mjs --base http://127.0.0.1:5173`
Expected: capturas de presa/vaso y delta de draw calls ≥2, triángulos ≤25 k.

- [ ] **Step 5: `npm run typecheck` y commit**

```bash
npm run typecheck && git add src/environment/water.ts src/main.ts scripts/water/capture_water.mjs
git commit -m "feat(water): módulo runtime con láminas, cintas y muro, y toggle ?water=0"
```

---

### Task 5: API de consulta (profundidad, fango, orilla segura)

**Files:**
- Modify: `src/environment/water.ts`
- Create: `scripts/water/test_water_queries.mjs`

**Interfaces:**
- Produces: `depthAt`, `isMuddy`, `nearestSafeShore` (firmas de la Tarea 4), consumidas por la Tarea 6.

- [ ] **Step 1: Escribir la consulta de profundidad con casos de prueba**

```javascript
// scripts/water/test_water_queries.mjs (contra el navegador, patrón CDP del repo)
const casos = [
  ['centro del vaso', 2350, 1300, 'profundo', (d) => d > 6],
  ['orilla oeste', 2050, 1300, 'seco', (d) => d === 0],
  ['vado del Oca', 3176, 3450, 'vadeable', (d) => d > 0 && d <= 0.35],
  ['lejos del agua', 3000, 3900, 'seco', (d) => d === 0],
];
for (const [nombre, x, z, etiqueta, esperado] of casos) {
  const d = await evaluate(`window.__game.water.depthAt(${x}, ${z})`);
  check(`${nombre} (${etiqueta})`, esperado(d), d);
}
```

- [ ] **Step 2: Implementar `depthAt` (grilla O(1) + cintas)**

```typescript
const depthAt = (x: number, z: number): number => {
  const grid = data.depthGrid;
  if (grid && x >= grid.originX && z >= grid.originZ) {
    const c = Math.floor((x - grid.originX) / grid.cellM);
    const r = Math.floor((z - grid.originZ) / grid.cellM);
    if (c >= 0 && c < grid.cols && r >= 0 && r < grid.rows) {
      const dm = grid.depthsDm[r * grid.cols + c] ?? 0;
      if (dm > 0) return dm / 10;
    }
  }
  return ribbonDepthAt(x, z);   // 0,12-0,25 m dentro del ancho de una cinta; 0 fuera
};
```

- [ ] **Step 3: Implementar `isMuddy` y `nearestSafeShore` con sus casos**

```javascript
const fango = await evaluate("window.__game.water.isMuddy(2150, 1230)");      // banda de orilla
check('fango en la orilla del vaso', fango === true, fango);
const seguro = await evaluate("window.__game.water.nearestSafeShore(2350, 1300)");
check('orilla segura a <=150 m y en seco', seguro !== null && Math.hypot(seguro.x - 2350, seguro.z - 1300) <= 150, seguro);
const seco = await evaluate("window.__game.water.depthAt(seguro.x, seguro.z)");
check('el punto de retorno está en seco', seco === 0, seco);
```

- [ ] **Step 4: Correr el arnés y commit**

Run: `node scripts/water/test_water_queries.mjs --base http://127.0.0.1:5173`
Expected: todos los casos en verde, incluido el del vado del Oca (≤0,35 m) y el de tierra seca (0).

```bash
git add src/environment/water.ts scripts/water/test_water_queries.mjs
git commit -m "feat(water): profundidad, fango y orilla segura con pruebas de consulta"
```

---

### Task 6: Reglas del 4x4 (vadeo, arrastre, hundimiento y enfangado)

**Files:**
- Modify: `src/main.ts` (paso de simulación, calado visual, aviso)
- Modify: `index.html` (elemento `#aviso`)
- Create: `scripts/water/drive_water.mjs`

**Interfaces:**
- Consumes: `water.depthAt`, `water.isMuddy`, `water.nearestSafeShore`.
- Produces: `estadoAgua` (`'seco' | 'vadeando' | 'hundiendo' | 'enfangado'`) y el mensaje `AVISO_HUNDIDO`.

- [ ] **Step 1: Añadir el aviso en `index.html`**

```html
<div id="aviso" role="status" aria-live="assertive" hidden>
  El 4x4 se hundió — volvés a la orilla
</div>
```

- [ ] **Step 2: Escribir la máquina de estados en el paso de simulación**

```typescript
/**
 * Reglas del agua. Solo en conducción: a pie el agua es decorativa. No toca la física
 * (nada de `vehicle/physics.ts`): limita la velocidad objetivo y aplica un calado visual.
 */
const reglasAgua = (dt: number): void => {
  if (!water || !vehicle || !player || player.mode !== 'driving') return;
  const t = player.telemetry();
  const prof = water.depthAt(t.x, t.z);
  if (prof > 1.1 || (water.isMuddy(t.x, t.z) && Math.abs(t.speedMps) < 0.4 && t.throttle > 0)) {
    hundimientoS += dt;
    calado = Math.min(1.5, calado + dt * 1.2);
    if (hundimientoS > 1.5) volverALaOrilla();
    return;
  }
  hundimientoS = 0;
  calado = Math.max(0, calado - dt * 0.8);
  if (prof > 0.35) velocidadMaximaAgua = 3.5;   // arrastre alto
  else if (prof > 0) velocidadMaximaAgua = 9;   // vadeo
  else velocidadMaximaAgua = Infinity;
};

const volverALaOrilla = (): void => {
  const t = player!.telemetry();
  const destino = water!.nearestSafeShore(t.x, t.z);
  if (destino) { player!.teleport(destino.x, destino.z, (t.yawDeg * Math.PI) / 180); }
  vehicle!.setState({ speed: 0, lateral: 0 });
  calado = 0; hundimientoS = 0;
  mostrarAviso(AVISO_HUNDIDO_TEXTO, 4000);
};
```

- [ ] **Step 3: Aplicar el calado visual y el límite de velocidad**

```typescript
// Calado visual: el modelo baja respecto de su pose; la física no cambia.
if (calado > 0) vehicle.root.position.y -= calado;
// Límite de velocidad objetivo dentro del agua (post-paso, sin tocar la física).
if (velocidadMaximaAgua < Infinity && vehicle.state.speed > velocidadMaximaAgua) {
  vehicle.setState({ speed: velocidadMaximaAgua });
}
```

- [ ] **Step 4: Arnés de inmersión**

```javascript
// scripts/water/drive_water.mjs
await entrarAl4x4(cdp, 3350, 1600, Math.atan2(2350 - 3350, 1300 - 1600));  // orilla del vaso
const antes = await evaluate('window.__game.water.depthAt(3350, 1600)');
await conducir(cdp, 12);              // gas a fondo hacia el centro del vaso
const despues = await evaluate(`(() => { const t = window.__game.player.telemetry();
  return { x: t.x, z: t.z, d: window.__game.water.depthAt(t.x, t.z), v: t.speedMps, aviso: document.getElementById('aviso')?.hidden === false }; })()`);
check('entró al vaso', antes < 1.1 && despues.d >= 0, { antes, despues });
check('terminó en tierra', despues.d === 0, despues);
check('detenido tras el rescate', Math.abs(despues.v) < 0.05, despues.v);
check('aviso visible', despues.aviso === true, despues.aviso);
```

Run: `node scripts/water/drive_water.mjs --base http://127.0.0.1:5173`
Expected: las cuatro comprobaciones en verde y consola sin errores.

- [ ] **Step 5: Caso de enfangado (orilla lenta) y `?water=0`**

```javascript
// el mismo arnés: entrar despacio a la banda de fango y quedarse sin avanzar
check('enfangado devuelve a la orilla', (await casoEnfangado(cdp)).d === 0);
const apagado = await evaluate("window.__game.water === null");
await navegar(cdp, `${BASE}/?water=0`);
check('?water=0 no deja reglas activas', (await evaluate('window.__game.water')) === null);
```

- [ ] **Step 6: `npm test`, typecheck y commit**

```bash
npm test && npm run typecheck && git add src/main.ts index.html scripts/water/drive_water.mjs
git commit -m "feat(water): vadeo, arrastre, hundimiento con retorno a la orilla y aviso en pantalla"
```

---

### Task 7: Regresión de misión, capturas y publicación

**Files:**
- Modify: `package.json` (añadir `test:water` y encadenarlo en `test`)
- Create: `output/playwright/current-review/opencode-water-*.png` (capturas)

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: build publicada y verificada en `kiri-vnic.tail4b3cf6.ts.net/montes-de-oca`.

- [ ] **Step 1: Encadenar la validación de agua en `npm test`**

```json
"test:water": "python3 scripts/water/build_water.py --check && node scripts/water/validate_water.mjs",
"test": "npm run typecheck && node scripts/roads/test_road_visuals.mjs && … && npm run test:water",
```

- [ ] **Step 2: Regresión de la misión (el vado del Oca)**

Run: `node scripts/milestone/drive_milestone.mjs --base http://127.0.0.1:5173 --no-build`
Expected: llega al repetidor con todos los checks en verde. **Si falla, el vado quedó hondo: bajar `CALADO_M.river` y volver a derivar.**

- [ ] **Step 3: Capturas (antes/después y el borde oeste del vaso)**

```javascript
const vistas = {
  presa:    '?px=2350&py=175&pz=1300&tx=2434&ty=150&tz=1523',
  orilla:   '?px=2150&py=160&pz=1230&tx=2350&ty=145&tz=1300',
  vado_oca: '?px=3176&py=90&pz=3520&tx=3176&ty=76&tz=3450',
  borde_oeste: '?px=1750&py=200&pz=1200&tx=2100&ty=145&tz=1250',
};
```

- [ ] **Step 4: `npm test` completo y build**

Run: `npm test && npm run build -- --base=/montes-de-oca/`
Expected: todo en verde y `dist/` con el bundle nuevo.

- [ ] **Step 5: Publicar con backup y verificar**

```bash
sudo cp -a /srv/www/montes-de-oca /srv/www/montes-de-oca.backup-$(date +%Y%m%d)-agua
sudo cp -a dist/. /srv/www/montes-de-oca/
sudo cmp dist/index.html /srv/www/montes-de-oca/index.html && echo HTML_MATCH
curl -sk -o /dev/null -w "%{http_code}\n" https://kiri-vnic.tail4b3cf6.ts.net/montes-de-oca/
```

- [ ] **Step 6: `record_change` y commit final**

```bash
git add package.json && git commit -m "test(water): validación de agua en npm test y capturas de regresión"
```

---

## Self-review del plan

- **Cobertura del spec**: §1 datos → T1; §2 cotas y geometría → T2/T3; §3 datos horneados → T2/T3; §4 runtime → T4; §5 reglas → T5/T6; §6 pruebas → T2-T7; §7 publicación → T7; §8 riesgos → Review Focus 1-2.
- **Placeholders**: ninguno; los `...` de `clip_ring_to_window`/`ear_clip` son funciones completas a escribir en su paso (algoritmo nombrado y con invariante de área).
- **Consistencia de tipos**: `Water`, `WaterStats`, `depthAt/isMuddy/nearestSafeShore` y el esquema de `water.json` se definen en T2/T4 y se usan igual en T5/T6.
- **Review Focus**: cada línea tiene su prueba en T4 (toggle), T5 (seco/orilla segura), T6 (vado/reglas), T7 (misión y borde oeste).
