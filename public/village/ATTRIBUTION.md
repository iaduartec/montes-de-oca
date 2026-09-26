# Datos geográficos del pueblo

Los dos productos se distribuyen por separado; las alturas del IGN se aplican
en memoria sobre los footprints OSM al construir la escena.

## Huellas de edificios

- © OpenStreetMap contributors, licencia ODbL 1.0.
- Consulta y snapshot: `data/gameplay/raw/osm_buildings_villafranca_manifest.json`.
- Archivo derivado: `buildings.json`.

## Alturas de cubiertas

- © Instituto Geográfico Nacional / Centro Nacional de Información Geográfica (IGN/CNIG).
- Producto: MDSnE 2,5 m, PNOA-LiDAR, primera cobertura.
- Licencia: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Servicio y consulta: `data/gameplay/raw/ign_mdsn_e025_villafranca_manifest.json`.
- Matriz servida: `building_height_grid.json` + `ign_mdsn_e025_villafranca_2_5m.bin`.
- Recorte WCS en EPSG:25830; conversión de GeoTIFF a Int16 fila-major, conservando metros.
- Para cada huella, el juego toma el percentil 95 de las celdas de edificio dentro del polígono y resta la subida del tejado low-poly. Se requieren al menos cuatro celdas válidas; en los demás casos mantiene la altura derivada de OSM.
- Es una medición LiDAR de la primera cobertura, no una constatación del estado actual de cada inmueble.
