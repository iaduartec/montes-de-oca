# Hitos singulares del pueblo

## Alcance y procedencia

El primer paquete cubre la Iglesia de Santiago Apóstol, el mobiliario genérico de La Plaza y la Presa de Alba. Los modelos son reconstrucciones low-poly estilizadas; no son levantamientos arquitectónicos. La iglesia usa la huella OSM way `90614388`; sus 12,8 m proceden de la etiqueta de cuatro plantas, no de una medición LiDAR. La plaza referencia OSM ways `645040295` (polígono peatonal) y `741760074` (calle existente). La presa usa way `168459142` y conserva anchura, base, coronación y la polilínea de coronación del `public/water/water.json` versionado.

La fotografía de la iglesia de Gerd Eichmann se registra como referencia visual CC BY-SA 4.0; no se incorpora su imagen ni una textura. OSM conserva su atribución ODbL 1.0 e IGN/CNIG CC BY 4.0. El registro de fuentes y los hashes de exportación están en [`assets/environment/focal-sites/sites.json`](../../assets/environment/focal-sites/sites.json) y [`public/village/focal-sites/manifest.json`](../../public/village/focal-sites/manifest.json). La atribución del juego queda en [`public/village/ATTRIBUTION.md`](../../public/village/ATTRIBUTION.md).

El aparcamiento del bar El Pájaro sigue pendiente de trazar manualmente con el comparador PNOA/IGN. La última inspección no mostró ortofoto utilizable, así que no se inventa el contorno ni sus marcas, bordillos o muebles. No se incluye geometría del aparcamiento.

## Evidencia PNOA 2023 y correcciones

La ortofoto oficial PNOA 2023 (PNOA MA 2023, vuelo de 2023 para Castilla y León, GSD 35 cm, IGN/CNIG CC BY 4.0) se usó como evidencia de planta. El registro por objetivo, con URL, fecha, licencia, huella WGS84 y discrepancia, está en [`assets/environment/real-structures/evidence.json`](../../assets/environment/real-structures/evidence.json); lo valida `node scripts/environment/validate_real_structure_evidence.mjs --phase=source`.

- **Presa de Alba — corregida:** el way OSM `168459142` es un arco (≈45 m de flecha sobre 189 m de cuerda), pero el asset anterior era un cajón recto sobre la cuerda a-b. `public/water/water.json` publica ahora `dam.crest` (18 nodos; 216,4 m reales vs 188,9 m de cuerda) y `build_focal_sites.py` barre el cuerpo de hormigón a lo largo de esa polilínea; el manifiesto focal registra `crestPoints=18` y `yawRad=0`.
- **Iglesia — blocker:** la ortofoto muestra una cubierta a dos aguas **cruzadas** (nave N-S + crucero E-O) con un faldón visible. El asset es un único faldón estilizado y no hay foto de suelo que justifique las vertientes faltantes; reorientar un solo faldón sería adivinar, así que no se reclama edición.
- **Plaza — blocker:** el asset son cuatro muebles genéricos; la ortofoto solo muestra la superficie pavimentada y no puede justificar geometría ni colocación de mobiliario.

Las vistas antes/después reproducibles (render cenital del GLB alineado al bbox de la ortofoto) se generan fuera del repositorio bajo `output/real_structures/model/`.

## Archivos y rendimiento

- Fuente Blender editable: [`assets/environment/focal-sites/focal-sites.blend`](../../assets/environment/focal-sites/focal-sites.blend); el generador reproducible es [`scripts/environment/build_focal_sites.py`](../../scripts/environment/build_focal_sites.py).
- Exports compactos: `church.glb` 30 040 B / 424 triángulos; `plaza.glb` 12 752 B / 168 triángulos; `dam.glb` 13 356 B / 174 triángulos. Cada archivo contiene una malla sin texturas raster.
- Total: 56 148 B y 766 triángulos. El coste de descarga es menor de 55 KiB; al usar el loader existente de Babylon, no se añadió una dependencia nueva.
- Iglesia y plaza suman una malla por hito. La presa sustituye la malla visual genérica del muro solo después de cargar correctamente. Se conservan el modelo de agua y su rejilla de profundidad; un fallo GLB vuelve a la geometría anterior. Las colisiones de edificios no se alteran.
- Capturas: vistas fijas reproducibles con `scripts/environment/capture_focal_sites.mjs` (iglesia, plaza, presa y vehículo) guardadas fuera del repositorio, por ejemplo `output/real-structures/browser/`. Las medidas de FPS proceden de Chrome con SwiftShader y sirven para detectar cambios en ese entorno de emulación; no predicen rendimiento en una GPU de escritorio ni en un móvil real.

Verificación: `npm run test:focal-sites`, `npm run test:water`, `npm run build` y `npm test`. Para regenerar los GLB hace falta Blender; la versión verificada en el entorno fue Blender 4.0.2.
