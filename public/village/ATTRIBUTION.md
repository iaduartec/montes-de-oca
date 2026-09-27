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

## Piloto de modelos de casas

- Ocho modelos singulares derivan sus huellas y alturas de los mismos productos OSM ODbL 1.0 e IGN/CNIG CC BY 4.0 descritos arriba; su registro técnico está en `public/village/pilot-houses.json`.
- Fuente y export generado: `assets/environment/village-pilot/village-pilot.blend`, `public/village/pilot-houses.glb`, creados por `scripts/environment/build_village_pilot.py`.
- Las fachadas, contraventanas, chimeneas, colores y cubiertas son reconstrucciones estilizadas aproximadas, no fotos ni mediciones del inmueble. Referencias y límites: `docs/environment/VILLAGE_PILOT.md`.

## Hitos singulares

- Iglesia, plaza y presa: huellas y referencias de ubicación derivadas de OSM (ODbL 1.0); las cotas de muro de la presa salen del `water.json` generado a partir de datos IGN/CNIG (CC BY 4.0). Inventario y hashes: `public/village/focal-sites/manifest.json`.
- La fotografía de la Iglesia de Santiago de Gerd Eichmann, `Villafranca Montes de Oca-02-Santiago Apostol-1996-gje.jpg`, se usa solo como referencia visual y conserva su licencia CC BY-SA 4.0: https://commons.wikimedia.org/wiki/File:Villafranca_Montes_de_Oca-02-Santiago_Apostol-1996-gje.jpg. No se incorpora ningún píxel de esa foto a los GLB.
- La iglesia, el mobiliario de plaza y los contrafuertes/coronación de la presa son reconstrucciones low-poly estilizadas; no son un levantamiento ni afirman reproducir detalles arquitectónicos no verificados.
- El contorno del parking de El Pájaro está pendiente de una lectura visual válida de la ortofoto PNOA en el comparador IGN; no se exporta geometría ni imagen para ese sitio.
