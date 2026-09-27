# Hitos singulares del pueblo

## Alcance y procedencia

El primer paquete cubre la Iglesia de Santiago Apóstol, el mobiliario genérico de La Plaza y la Presa de Alba. Los modelos son reconstrucciones low-poly estilizadas; no son levantamientos arquitectónicos. La iglesia usa la huella OSM way `90614388`; sus 12,8 m proceden de la etiqueta de cuatro plantas, no de una medición LiDAR. La plaza referencia OSM ways `645040295` (polígono peatonal) y `741760074` (calle existente). La presa usa way `168459142` y conserva extremos, anchura, base y coronación del `public/water/water.json` versionado.

La fotografía de la iglesia de Gerd Eichmann se registra como referencia visual CC BY-SA 4.0; no se incorpora su imagen ni una textura. OSM conserva su atribución ODbL 1.0 e IGN/CNIG CC BY 4.0. El registro de fuentes y los hashes de exportación están en [`assets/environment/focal-sites/sites.json`](../../assets/environment/focal-sites/sites.json) y [`public/village/focal-sites/manifest.json`](../../public/village/focal-sites/manifest.json). La atribución del juego queda en [`public/village/ATTRIBUTION.md`](../../public/village/ATTRIBUTION.md).

El aparcamiento del bar El Pájaro sigue pendiente de trazar manualmente con el comparador PNOA/IGN. La última inspección no mostró ortofoto utilizable, así que no se inventa el contorno ni sus marcas, bordillos o muebles. No se incluye geometría del aparcamiento.

## Archivos y rendimiento

- Fuente Blender editable: [`assets/environment/focal-sites/focal-sites.blend`](../../assets/environment/focal-sites/focal-sites.blend); el generador reproducible es [`scripts/environment/build_focal_sites.py`](../../scripts/environment/build_focal_sites.py).
- Exports compactos: `church.glb` 30 100 B / 424 triángulos; `plaza.glb` 12 816 B / 168 triángulos; `dam.glb` 9 628 B / 120 triángulos. Cada archivo contiene una malla sin texturas raster.
- Total: 52 544 B y 712 triángulos. El coste de descarga es menor de 52 KiB; al usar el loader existente de Babylon, no se añadió una dependencia nueva.
- Iglesia y plaza suman una malla por hito. La presa sustituye la malla visual genérica del muro solo después de cargar correctamente. Se conservan el modelo de agua y su rejilla de profundidad; un fallo GLB vuelve a la geometría anterior. Las colisiones de edificios no se alteran.
- Capturas antes/después: [`output/focal-sites-before/`](../../output/focal-sites-before/) y [`output/focal-sites-after/`](../../output/focal-sites-after/). Las medidas de FPS proceden de Chrome con SwiftShader y sirven para detectar cambios en ese entorno de emulación; no predicen rendimiento en una GPU de escritorio ni en un móvil real.

Verificación: `npm run test:focal-sites`, `npm run test:water`, `npm run build` y `npm test`. Para regenerar los GLB hace falta Blender; la versión verificada en el entorno fue Blender 4.0.2.
