# Datos geográficos del agua

La capa de agua (`water.json`) combina el contorno OSM del embalse y las
lagunas con la cota del vaso medida sobre el DEM del IGN. Los dos productos
se distribuyen por separado; la profundidad es sintética (0 en la orilla,
fondo junto a la presa), no una batimetría medida.

## Contornos de agua

- © OpenStreetMap contributors, licencia ODbL 1.0.
- Consulta y snapshot: `data/water/raw/osm_water_window.json`.
- Manifiesto con sha256: `data/water/raw/osm_water_window_manifest.json`.
- Archivo derivado: `water.json` (láminas `sheets`, cintas `ribbons`).
- El anillo del Embalse de Alba se ensambló desde sus 22 ways de contorno
  (`source=ITACyL`, relation 18149353) porque la consulta de ventana trae la
  relation sin miembros; ver el comentario `RESERVOIR_RING` en
  `scripts/water/build_water.py`.

## Cota del vaso y fondo

- © Instituto Geográfico Nacional / Centro Nacional de Información Geográfica (IGN/CNIG).
- Producto: MDT05, paso de malla 5 m, vuelo LiDAR PNOA.
- Licencia: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Matriz servida: `public/terrain/tiles/tile_*.json` (alturas absolutas;
  el juego resta el datum 870 m).
- La cota del vaso es la moda del DEM dentro del polígono en bins de 1 m,
  más 0,15 m de resguardo; la grilla de profundidad (`depthGrid`) reparte el
  fondo entre la orilla (0 m) y la zona honda junto a la presa.
- Detalle de la descarga del DEM: `data/terrain/raw/fetch_manifest.json`;
  atribución completa del terreno: `public/terrain/ATTRIBUTION.md`.
