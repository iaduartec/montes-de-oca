# Pueblo (Villafranca del Cid)

## Fuente
- Overpass `way["building"]` radio 900 m en 42.3883784, -3.3086147 → `scripts/environment/fetch_buildings.sh`.
- Crudo: `data/gameplay/raw/osm_buildings_villafranca.json` (335 ways, sha256 en `_manifest.json`, osm `2026-09-25T00:43:35Z`).
- Build determinista: `node scripts/environment/build_village.mjs` → `public/village/buildings.json` (330 edificios, 83.6 KB).
  `--check` no escribe y valida re-deriva byte a byte, ventana, alturas, spawn y bases.
- Descartes: 5 por área mínima (<12 m²); el resto 0.

## Datos por edificio
- Altura: `building:levels`×3.2 (323) > tag `height` > tipo (7). Rango 3.2–12.8 m.
- `materialKind` ∈ {piedra, revoco, teja, ladrillo} (110/114/69/37); `roofKind` ∈ {teja, chapa, pizarra} (201/128/1).
- `meta.fecha` = `fetched_at_utc` del manifiesto, nunca `new Date()` (si no, `--check` rompe).

## Runtime — `src/environment/village.ts`
- Contrato: `loadVillage(scene, terrain, options?) → {stats, dispose}`; `keepClearAt`/`keepClearRadiusM` filtran en runtime.
- Base SIEMPRE en `terrain.heightAt` por esquina, estirada hacia abajo `FALDON_M = 1.5` (constante duplicada y verificada por `--check`).
- Tejado dos aguas si elongación PCA ≥ 1.35, si no plano con ear-clipping (62 % de footprints no son convexos).
- Agrupación: 4 mallas de cuerpo por `materialKind` + 3 de tejado por `roofKind` = 7 draw calls para 330 casas.
- `backFaceCulling = false` (igual que terreno y vías); normales de muro orientadas por el signo del área.

## Verificación
- `npm run typecheck` y `npm run build` limpios; `build_village.mjs --check` → TODO OK.
- Capturas: `output/milestone1/10_village_street.png`, `11_village_aerial.png` (Chrome headless + CDP, sin Playwright).
- Coste medido: +6 draw calls (5→11), +7708 triángulos (237306→245014); pico aéreo 14/405027.
- Auditoría de base por esquina: 250 edificios, gap máx 0.0000 m. Spawn (3088,3935) libre a 27.9 m.
- Known: 4/250 quedan embebidos en la ladera (terreno sobre la cumbrera); no flotan.
