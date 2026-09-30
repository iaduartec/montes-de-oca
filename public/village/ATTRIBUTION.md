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
- `fotos/Iglesia_plaza.jpg` fue facilitada por el usuario y se usa solo como referencia visual para rasgos estilizados de torre y plaza. Autor, licencia, fecha y pose de cámara son desconocidos; no se le asigna una licencia ni se incorpora ningún píxel.
- La cubierta de la iglesia conserva el footprint OSM y representa las cumbreras cruzadas de nave y crucero observadas en planta; torre, vanos, reloj y cúpula son una interpretación estilizada a partir de las referencias visuales. La superficie de plaza deriva del polígono peatonal OSM y se ajusta al MDT IGN/CNIG; su plataforma, rampa y barandillas son aproximadas y no georreferenciadas. El vial `living_street` y sus colisiones existentes se conservan.
- El cuerpo/coronación de la presa también es una reconstrucción low-poly estilizada; los hitos no son levantamientos arquitectónicos.
- Ortofoto de contraste: PNOA 2023 (PNOA MA 2023, vuelo de 2023 para Castilla y León, GSD 35 cm), © IGN/CNIG, CC BY 4.0, servida por `https://www.ign.es/wms-inspire/pnoa-ma` (capa `OI.OrthoimageCoverage`; registro IDEE `spaignPNOA2023`). Solo respalda planta, cubierta y superficie pavimentada de plaza; no se incorpora ningún píxel ni tile al juego. Ledger por objetivo: `assets/environment/real-structures/evidence.json`.
- El contorno del parking de El Pájaro está pendiente de una lectura visual válida de la ortofoto PNOA en el comparador IGN; no se exporta geometría ni imagen para ese sitio.

## Muros cartografiados

23 trazados `barrier=wall/retaining_wall` de © OpenStreetMap contributors (ODbL 1.0), descargados el 2026-09-30: https://api.openstreetmap.org/api/0.6/map.json?bbox=-3.318,42.368,-3.305,42.390 . Snapshot reducido: `data/village/raw/osm_mapped_walls.json`; derivado: `mapped-walls.json`. La posición procede de OSM. Altura de way 476051609: etiqueta OSM 3 m; el resto y el grosor son estimaciones artísticas, no mediciones. Sustituyen tapias generadas sin evidencia.

## Nuestra Señora de Oca y campa

Huella de ermita OSM way 216539679 (ODbL 1.0), versión 2024-12-27, consultada 2026-09-30. Fotos de referencia de Jialxv, 2017-10-04, CC BY-SA 4.0: https://commons.wikimedia.org/wiki/File:Ermita_de_Ntra_Sra_de_Oca_01.jpg y https://commons.wikimedia.org/wiki/File:Ermita_de_Ntra_Sra_de_Oca_02.jpg . Solo referencia, sin píxeles incorporados. Alturas, proporciones y materiales son estilizados; las fotos de 2017 no prueban el estado actual. Campa: traza conservadora del césped al norte en PNOA IGN/CNIG, CC BY 4.0, fecha de vuelo desconocida. Fuentes, metadatos y polígono en `assets/environment/oca-site/source.json`; mapas de césped originales procedurales. No se infieren muros perimetrales de Oca.
