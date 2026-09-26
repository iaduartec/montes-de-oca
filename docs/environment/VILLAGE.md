# Pueblo (Villafranca de Montes de Oca, Burgos)

## Fuente
- Overpass `way["building"]` radio 900 m en 42.3883784, -3.3086147 → `scripts/environment/fetch_buildings.sh`.
- Crudo: `data/gameplay/raw/osm_buildings_villafranca.json` (335 ways, sha256 en `_manifest.json`, osm `2026-09-25T00:43:35Z`).
- Build determinista: `node scripts/environment/build_village.mjs` → `public/village/buildings.json` (330 edificios, 83.6 KB).
  `--check` no escribe y valida re-deriva byte a byte, ventana, alturas, spawn y bases.
- Descartes: 5 por área mínima (<12 m²); el resto 0.

## Datos por edificio
- Huellas, materiales y tipo permanecen en `buildings.json` (OSM/ODbL).
- En runtime, la altura explícita `height` de OSM se respeta. Para las demás huellas se muestrea el grid IGN MDSnE de 2,5 m; con cuatro celdas válidas, el alero se estima usando el percentil 95 de cubierta y la subida del tejado low-poly. Las alturas estimadas restantes usan `building:levels`×3.2 o la altura por tipo.
- Las casas `levels`/`tipo` elevan la cubierta estimada hasta dejar 0,2 m de holgura sobre la ladera, con tope de 1,6 m. Las medidas LiDAR y alturas OSM explícitas no se alteran.
- El grid independiente `public/village/building_height_grid.json` + `.bin` deriva del MDSnE de la primera cobertura LiDAR (CC BY 4.0). El recorte y su hash están en `data/gameplay/raw/ign_mdsn_e025_villafranca_manifest.json`; actualización con `python3 scripts/environment/fetch_building_height_grid.py` (requiere Pillow y NumPy).
- La rejilla IGN y la base de datos OSM se mantienen como archivos separados; la combinación sólo ocurre en memoria al construir la escena. Atribuciones en `public/village/ATTRIBUTION.md`.
- `materialKind` ∈ {piedra, revoco, teja, ladrillo} (110/114/69/37); `roofKind` ∈ {teja, chapa, pizarra} (201/128/1).
- `meta.fecha` = `fetched_at_utc` del manifiesto, nunca `new Date()` (si no, `--check` rompe).

## Runtime — `src/environment/village.ts`
- Contrato: `loadVillage(scene, terrain, options?) → {stats, dispose}`; `keepClearAt`/`keepClearRadiusM` filtran en runtime.
- Base SIEMPRE en `terrain.heightAt` por esquina, estirada hacia abajo `FALDON_M = 1.5` (constante duplicada y verificada por `--check`).
- Las plantas alargadas usan cubierta a dos aguas; el subconjunto cercano al spawn añade variantes a cuatro aguas y de un agua. Las casas dentro de 90 m reciben detalles de fachada y alero.
- El pueblo se agrupa en 4 mallas de cuerpo, 3 de cubierta y hasta 3 de detalle (10 en la escena actual de 330 edificios; 11.558 triángulos). No hay una malla por casa.
- `backFaceCulling = false` (igual que terreno y vías); normales de muro orientadas por el signo del área.

## Referencia visual
- Google Maps 3D puede servir para orientación visual manual. No extraer ni incorporar capturas, tiles, mallas o geometría reconstruida desde Google Maps/Earth. Los datos del juego deben proceder de fuentes reutilizables y atribuidas: OSM y el MDSnE IGN/CNIG (ver `public/village/ATTRIBUTION.md`).

## Verificación
- `npm run typecheck`, `npm run build` y `build_village.mjs --check` limpios.
- Capturas: `output/milestone1/10_village_street.png`, `11_village_aerial.png` (Chrome headless + CDP, sin Playwright).
- Coste medido: +6 draw calls (5→11), +7708 triángulos (237306→245014); pico aéreo 14/405027.
- Auditoría de base por esquina: 250 edificios, gap máx 0.0000 m. Spawn (3088,3935) libre a 27.9 m.
- La auditoría actual eleva 3/65 alturas estimadas, con máximo 0,83 m; permanecen 9 intersecciones puntuales en alturas LiDAR medidas (máximo 1,18 m), sin modificar esas mediciones.
