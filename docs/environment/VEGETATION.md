# Vegetación (Fase D — milestone 1)

## Fuente y build
- Landcover OSM de la ventana 6×6 km (`scripts/geo/overpass.sh`) → `data/gameplay/raw/osm_landcover_window.json` (sha256 en `_manifest.json`, ODbL).
- Clasificación FOREST/GRASS/FIELDS; `node scripts/environment/build_vegetation.mjs` → `public/vegetation/vegetation.json` (33.363 instancias, 7 tipos, 2,84 MB); `--check` re-deriva sin escribir (21/21).
- Por tipo: roble 12433, hierba 6310, haya 6227, abedul 5266, jaral 1822, enebro 1197, pino 108. Excluidos en build: 1746 por corredor, 8 por claro, 0 fuera de ventana.

## Decisiones
- Despeje en el BUILD sobre la polilínea densa: ROAD 12 m / TRACK 8 m / PATH 4 m más toda la red vial (438 corredores en total), + claros de 30 m (inicio) y 18 m (objetivo). El runtime solo red de seguridad O(N) con grilla de 100 m: `excludedByCorridor = 0`.
- LOD dibujado a 900 m = `config.viewRadius`. Con 650 m se veía un disco de terreno pelado alrededor de la cámara; con 1200 m las copas se metían sobre el borde recortado del terreno (A/B de píxeles de cielo con copa encima: 2,0%/2,6% → 0,01%/0,06%).
- `vegetation.json` sin `y`: la altura la resuelve el runtime con `terrain.heightAt` (residual máx 2,27e-13 m) y hunde `SINK_M` (arbol 0,25 / arbusto 0,15 / hierba 0,05 m).
- `tier` en datos = banda de distancia a la primera ruta (300/900 m); en runtime se recalcula contra la cámara real.

## Runtime — `src/environment/vegetation.ts`
- `loadVegetation(scene, terrain, options?)` → 21 mallas thin instance (7 tipos × 3 bandas), normales analíticos con `backFaceCulling = false`; `update(camara)` con buckets ya resueltos.
- Capturas: `output/milestone1/08_vegetation_aerial.png`, `08b_vegetation_spawn.png`, `09_vegetation_ground.png` (Chrome headless + CDP, sin Playwright).

## Verificación
- `npm run typecheck`, `npm run build` y `npm test` (incluye `build_vegetation.mjs --check` y `test_vegetation_color.mjs`) limpios.
- Coste en la vista aérea: draw calls 7→13 (+6), triángulos 758084→890646 (+132562); tiers 16304/9745/7314 (24034 árboles, 3019 arbustos, 6310 matas).
