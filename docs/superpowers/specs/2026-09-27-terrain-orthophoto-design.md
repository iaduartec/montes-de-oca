# Especificación: ortofoto real para el terreno de Villafranca

## Objetivo

Dar al paisaje jugable una apariencia reconocible y cercana a Villafranca de Montes de Oca. La vista aérea debe distinguir el parcelario agrícola, las masas forestales, el valle y el núcleo urbano. La ortofoto modifica la apariencia del suelo; el MDT y las capas jugables continúan siendo la fuente de verdad de altura y geometría.

## Estado actual y evidencia

- `public/terrain/config.json` define una ventana de 6 × 6 km, CRS EPSG:25830, con origen E=471500 / N=4689000, 36 teselas de 1000 m y muestreo del MDT cada 5 m.
- `src/terrain.ts` construye el relieve con el MDT05, colorea sus vértices por altura y usa un material compartido. No consume imágenes de superficie.
- Las capturas aéreas actuales dejan el suelo en tonos verdes casi uniformes. Las fotos nuevas muestran un pueblo longitudinal por el valle, campos en parcelas y bloques de bosque claramente separados.
- Las fotos aéreas aportadas tienen fecha de cámara de 2005 y no incluyen coordenadas GPS. Sirven como referencia visual para la forma y el uso del suelo, no como imágenes georreferenciadas para texturizar el mapa.

## Diseño

Descargar una cobertura acotada de la ortofoto PNOA Máxima Actualidad del IGN/CNIG para la misma ventana geográfica del MDT. Registrar la fecha de vuelo mosaico disponible para la zona, el CRS, la resolución solicitada, la URL/capa del servicio y los hashes de los archivos usados. La fecha puede variar entre partes del mosaico y se conservará el metadato oficial correspondiente.

Preparar una imagen norte-arriba de 6144 × 6144 píxeles para los 6000 × 6000 m, aproximadamente 0,98 m/píxel. Se publicará como textura raster estática del terreno, no integrada en Blender ni horneada en GLB. Las coordenadas de texel y malla compartirán los límites exactos de `terrain/config.json`; la fila superior representa el borde norte y el borde oeste corresponde a `worldX = 0`.

La textura tendrá una conversión de color moderada que conserve las diferencias observadas entre campos y bosque. El material seguirá recibiendo iluminación y sombras. Los colores actuales por vértice se pondrán en blanco o se desactivarán al usar la imagen para evitar teñirla con la paleta de altura.

## Componentes y flujo de datos

1. Un builder de terreno obtiene el recorte PNOA de la zona, verifica cobertura y alineación en EPSG:25830, y genera la imagen estática. La captura usada para derivar el resultado queda guardada como entrada reproducible junto con su manifiesto; `--check` vuelve a derivar y compara hashes sin descargar una versión nueva.
2. Un manifiesto de procedencia en `public/terrain/` registra origen, fecha o fechas de adquisición, extensión, CRS, dimensiones, resolución, licencia, reconocimiento y SHA-256 de entrada y salida.
3. El loader del terreno carga el recurso estático indicado por el manifiesto y asigna UV geográficos a cada malla actual. Las 36 teselas comparten el atlas y el material.
4. Si el recurso falta, no carga o el dispositivo no admite su dimensión, el loader conserva el aspecto procedural actual por color de vértice. El runtime no hace peticiones a IGN/CNIG.

## Límites y compatibilidad

- No modificar el DEM, los valores de `heightAt`/`normalAt`, la física, la cámara, los límites del mundo ni el culling de teselas.
- Conservar la malla de carreteras, agua, casas y vegetación sobre la superficie. La ortofoto no reemplaza sus geometrías.
- El material de terreno seguirá siendo compartido. No debe añadirse un draw call por tesela a lo ya producido por sus mallas.
- El atlas será de hasta 6144 × 6144; el gasto de textura RGBA con mipmaps no superará 200 MiB. El archivo distribuido no superará 35 MiB. Se reducirá la calidad de compresión antes que la resolución geográfica objetivo.
- Si la cobertura PNOA disponible para el área no alcanza 1 m/píxel o produce un artefacto de mosaico visible, se para la integración y se documenta la limitación para revisar la fuente o el tamaño de imagen.

## Atribución y licencias

La ortofoto PNOA Máxima Actualidad se obtiene del IGN/CNIG bajo las condiciones de uso geográfico compatibles con CC BY 4.0. Se añadirá el reconocimiento de titularidad y licencia a `public/terrain/ATTRIBUTION.md`, además de conservar la procedencia por producto y fecha. La atribución existente del MDT05 permanece. Los datos de carreteras y cobertura OSM mantienen su atribución ODbL 1.0.

No se copiarán las fotos aportadas al juego ni a los assets. Tampoco se empaquetarán imágenes dentro de GLB.

## Criterios de aceptación

- Se distinguen a simple vista, desde la cámara aérea de captura, los límites reales de parcelas, bosque, claros y núcleo urbano en la zona cubierta por PNOA.
- La imagen coincide espacialmente con la orientación y los cuatro bordes de las teselas del terreno, sin espejado norte-sur, huecos, franjas duplicadas ni costuras internas del atlas.
- `heightAt`, `normalAt`, colisiones, superficie de carreteras y capas OSM producen los mismos resultados antes y después.
- Si la imagen no carga o excede `MAX_TEXTURE_SIZE`, se ve el terreno procedural y no aparece una excepción sin atender en consola.
- El build y el chequeo del asset reproducen tamaños y hashes declarados. Una captura de navegador comprueba una vista de valle desde arriba y otra a altura de conducción.
- La atribución pública identifica a IGN/CNIG, el producto PNOA, la licencia y las fechas de imagen disponibles para la ventana.

## Fuera de alcance

Cambiar el MDT o sus teselas, rehacer la silueta del pueblo, sustituir la geometría de árboles, editar carreteras o parcelas OSM, hacer fotogrametría de las imágenes aportadas, añadir detalles históricos no acreditados, crear un modo satélite de mapa, o introducir streaming de terreno.

## Fuente principal

- PNOA Máxima Actualidad (IGN): https://pnoa.ign.es/pnoa-imagen/ortofotos-pnoa-maxima-actualidad
- Descarga CNIG y licencia: https://centrodedescargas.cnig.es/CentroDescargas/detalleArchivo?sec=11547781
