# Hitos singulares del pueblo

## Alcance y procedencia

El paquete cubre la Iglesia de Santiago Apóstol, La Plaza y la Presa de Alba. Los modelos son reconstrucciones low-poly estilizadas; no son levantamientos arquitectónicos. La iglesia usa la huella OSM way `90614388`; sus 12,8 m proceden de la etiqueta de cuatro plantas, no de una medición LiDAR. La plaza referencia OSM ways `645040295` (polígono peatonal) y `741760074` (calle existente). La presa usa way `168459142` y conserva anchura, base, coronación y la polilínea de coronación del `public/water/water.json` versionado.

La fotografía de la iglesia de Gerd Eichmann se registra como referencia visual CC BY-SA 4.0; respalda la lectura estilizada de la torre y no se incorpora su imagen ni una textura. `fotos/Iglesia_plaza.jpg` fue facilitada por el usuario: se conserva como referencia visual, con autor, licencia, fecha y pose de cámara desconocidos; no se le asignan ni se empaquetan píxeles. PNOA MA 2023 (IGN/CNIG, CC BY 4.0) respalda la forma en planta de los tejados y la superficie pavimentada de la plaza. OSM conserva su atribución ODbL 1.0. El registro de fuentes y los hashes de exportación están en [`assets/environment/focal-sites/sites.json`](../../assets/environment/focal-sites/sites.json) y [`public/village/focal-sites/manifest.json`](../../public/village/focal-sites/manifest.json). La atribución del juego queda en [`public/village/ATTRIBUTION.md`](../../public/village/ATTRIBUTION.md).

El aparcamiento del bar El Pájaro sigue pendiente de trazar manualmente con el comparador PNOA/IGN. La última inspección no mostró ortofoto utilizable, así que no se inventa el contorno ni sus marcas, bordillos o muebles. No se incluye geometría del aparcamiento.

## Evidencia PNOA 2023 y correcciones

La ortofoto oficial PNOA 2023 (PNOA MA 2023, vuelo de 2023 para Castilla y León, GSD 35 cm, IGN/CNIG CC BY 4.0) se usó como evidencia de planta. El registro por objetivo, con URL, fecha, licencia, huella WGS84 y discrepancia, está en [`assets/environment/real-structures/evidence.json`](../../assets/environment/real-structures/evidence.json); lo valida `node scripts/environment/validate_real_structure_evidence.mjs --phase=source`.

- **Presa de Alba — corregida:** el way OSM `168459142` es un arco (≈45 m de flecha sobre 189 m de cuerda), pero el asset anterior era un cajón recto sobre la cuerda a-b. `public/water/water.json` publica ahora `dam.crest` (18 nodos; 216,4 m reales vs 188,9 m de cuerda) y `build_focal_sites.py` barre el cuerpo de hormigón a lo largo de esa polilínea; el manifiesto focal registra `crestPoints=18` y `yawRad=0`.
- **Iglesia — corregida en planta/cubierta y proporción de torre:** PNOA muestra cumbreras cruzadas (nave N-S y crucero E-O); el GLB ahora construye dos volúmenes de cubierta que se cruzan y conserva huella/apoyo OSM. La foto local muestra el reloj claramente por encima de la cumbrera; se extendió el fuste hasta una silueta de 22,04 m y se conservaron unidos el reloj, los vanos de campanas y la cúpula. La altura sigue siendo una interpretación estilizada, no una medición.
- **Plaza — corregida en planta:** antes solo había muebles sobre el terreno. El GLB incorpora paños regulares de pavimento derivados del polígono OSM y ajustados al MDT IGN de 5 m, dejando sin cubrir el corredor de la calle `living_street` de 5 m y las huellas de edificios. La pequeña plataforma, escalones y barandillas son una colocación aproximada a partir de la foto local; la foto no está georreferenciada. No se alteran calle ni colisiones.

Las vistas antes/después reproducibles (render cenital del GLB alineado al bbox de la ortofoto) se generan fuera del repositorio bajo `output/real_structures/model/`.

## Archivos y rendimiento

- Fuente Blender editable: [`assets/environment/focal-sites/focal-sites.blend`](../../assets/environment/focal-sites/focal-sites.blend); el generador reproducible es [`scripts/environment/build_focal_sites.py`](../../scripts/environment/build_focal_sites.py). `blender --background --factory-startup --python scripts/environment/build_focal_sites.py -- --check` reexporta en temporal y compara GLB y manifest byte a byte.
- Exports compactos: `church.glb` 89 792 B / 1 326 triángulos; `plaza.glb` 462 676 B / 8 138 triángulos; `dam.glb` 12 332 B / 174 triángulos. Cada archivo contiene una malla sin texturas raster.
- Total: 564 800 B y 9 638 triángulos (551,6 KiB), dentro del presupuesto de 600 KiB y 20 000 triángulos; al usar el loader existente de Babylon, no se añadió una dependencia nueva.
- Iglesia y plaza suman una malla por hito. La presa sustituye la malla visual genérica del muro solo después de cargar correctamente. Se conservan el modelo de agua y su rejilla de profundidad; un fallo GLB vuelve a la geometría anterior. Las colisiones de edificios no se alteran.
- La iglesia usa una nave y crucero de cubierta cruzada, fachada con portal/vanos, fuste alto con bandas de piedra, reloj, cuerpo de campanas, cúpula y cruz. El manifiesto registra su extensión vertical (22,04 m) y la valida para que la torre no vuelva a quedar baja; es una proporción visual, no medida. La plaza usa paños de 0,5 m ajustados al MDT, recortados al polígono OSM y a una separación continua de la carretera para cerrar huecos y evitar invadir el asfalto. La captura reciente de revisión está en `output/tower-review-20260928/church-facade.png`; las capturas revisadas previas quedan en `output/real_structures/model/after_{church,plaza}_focal_sites.png`. Las medidas de FPS proceden de Chrome con SwiftShader y sirven para detectar cambios en ese entorno de emulación; no predicen rendimiento en una GPU de escritorio ni en un móvil real.

Verificación: `npm run test:focal-sites`, `npm run test:water`, `npm run build` y `npm test`. Para regenerar los GLB hace falta Blender; la versión verificada en el entorno fue Blender 4.0.2.

## Verificación final del delivery conjunto

- `npm test` → OK (typecheck + validadores, incluido `validate_real_structure_evidence.mjs --phase=source`; las correcciones de iglesia y plaza reducen los blockers previos, pero aún quedan seis casas sin discrepancia demostrable).
- `npm run build` → OK.
- `node scripts/vehicle/drive_catalog.mjs` con `npm run dev` → TODO OK: los 8 vehículos se conducen, las dos motos caen y se recuperan, el cambio en movimiento se rechaza sin tocar preset/storage, 11 cambios entre categorías con recursos gráficos estables (tri 674762, vert 1823402) y 0 errores de consola.
- Vistas reproducibles en `output/real-structures/browser/` (iglesia, plaza, presa, vehículo) y renders cenitales en `output/real_structures/model/`.

**Estado del conjunto de estructuras: INCOMPLETO.** Iglesia y plaza ya tienen correcciones limitadas a cubierta y planta respectivamente. `node scripts/environment/validate_real_structure_evidence.mjs --phase=final` seguirá fallando porque seis casas piloto permanecen como release blockers según la spec; no se modifica su estado con esta entrega.

En esta verificación, `npm run test:real-structures` pasa la fase `source` (124 checks), pero `npm run test:real-structures:final` también detecta que faltan las capturas de comparación de `house-474364247`, `house-474364248` y `dam-168459142` bajo `output/real_structures/model/`. Las comparativas de iglesia y plaza sí existen y corresponden a las capturas fijas actualizadas; esos outputs locales se ignoran en Git.

## Oca y revisión de plaza (2026-09-30)

La plaza corrige la inversión X de mobiliario y su apoyo en terreno, los peldaños y el recorte continuo del pavimento junto a la carretera. El acabado gris usa la fotografía facilitada por el usuario como referencia artística; rampas, barandillas y alturas no son un levantamiento.

Nuestra Señora de Oca se carga desde un paquete independiente reproducible (`scripts/environment/build_oca_site.py`), con huella OSM way 216539679, entrada occidental, espadaña de dos vanos con campanas y porche norte. Las fotos de Jialxv de 2017 respaldan estas características históricas, con alturas estimadas. La campa es una traza conservadora del césped al norte en PNOA, con fecha de vuelo desconocida y ajuste por triángulos al MDT; se corrige la penetración que producía huecos en la primera versión. No se inventan cierres perimetrales. Hay mapas originales de piedra/césped; no fotos empaquetadas.

La revisión final reduce el pavimento de 0,5 m a 1 m y baja el contraste entre paños, conservando el recorte de bordes y carreteras. Plaza: 147.352 B / 2.410 triángulos; ermita: 150.728 B / 2.264 triángulos (tres materiales); campa: 12.868 B / 228 triángulos. Todos los hitos: 413.072 B / 6.402 triángulos, por debajo de 600 KiB / 20.000. Misma cámara de plaza: 33 draw calls en ambos, escena 792.083 → 790.035 triángulos (incluye cambio de muros). Las capturas y mediciones quedan en `outputs/facades-plaza-oca-20260930/`; misión completa, 28 comprobaciones y cero errores de consola. Oca añade cuatro draw calls (tres materiales de ermita y uno de campa). La campa usa tres mapas de 256²: aproximadamente 1 MiB con mipmaps.

Ajuste posterior de cubiertas de Oca: faldones cerrados de 10 cm, cumbreras curvas de bajo coste y remate inclinado de la espadaña; posteado del porche apoyado en MDT y unido a la pendiente, con viga frontal. La madera comparte el material sin textura de los detalles oscuros para evitar juntas de piedra sobre los postes. Huella, ancla y alturas generales conservadas; remates y espesores siguen siendo artísticos. Ermita: 156.620 B / 2.354 triángulos, tres materiales. Comparación cercana: 33 draw calls y 33 mallas activas en ambos casos, +90 triángulos. Evidencia: `outputs/oca-roof-adjustments-20260930/`. Build, validador de hitos y regeneración byte a byte pasan.

Encuentros con terreno: umbral claro bajo la reja de Oca, dimensiones aproximadas a partir de la referencia fotográfica de 2017 y apoyo sobre MDT. Campa con alfa por vértice y transición interior suave hacia el terreno; el trazado no se amplía. Capturas fijas en `outputs/oca-ground-transitions-20260930/`: campa conserva 31 draw calls; ermita conserva 33; +2 triángulos del umbral. El coste de relleno de transparencia no se ha medido en GPU objetivo. Ermita 156.760 B / 2.356 triángulos; campa 12.868 B / 228 triángulos. Tipos, build, validación y regeneración byte a byte correctos.
