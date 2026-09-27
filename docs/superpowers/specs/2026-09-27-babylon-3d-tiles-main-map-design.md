# Integración de 3D Tiles en el mapa principal

**Estado:** propuesta para revisión; todavía no cambia la escena jugable.

## Objetivo

Mostrar el terreno cartográfico de Villafranca como contenido local 3D Tiles en
la escena principal de Babylon, con carga y selección de teselas según la cámara.
El vehículo, el personaje, las carreteras, el agua, los edificios y la misión
deben seguir coincidiendo con el MDT y sus coordenadas actuales.

## Condiciones de diseño propuestas y límites

- La referencia de datos sigue siendo EPSG:25830 con el origen actual
  `E=471500, N=4689000`; X crece al este, Z lógico al norte, Y es altura menos
  el datum de 870 m.
- `heightAt`, `normalAt`, la simulación del vehículo y del personaje, las rutas,
  las reglas del agua y el minimapa conservan esa convención lógica.
- Los datos iniciales salen de fuentes ya distribuidas por el juego: MDT05 del
  IGN/CNIG, ortofoto PNOA y geometrías OSM. Las imágenes PNOA se servirán como
  texturas externas; nunca se incrustan en GLB/GLTF.
- La capa de terreno 3D Tiles es solo visual. El heightfield de 5 m sigue siendo
  la autoridad para física, colocación y colisiones.
- MDS02 de 2 m queda como mejora de datos posterior: aún no se descargó ni se
  validó en la hoja 0201-4.
- No se cambian misión, controles, física, datos OSM ni geometrías de edificios
  para aparentar una precisión no respaldada.

## Enfoques evaluados

1. **Una escena Babylon en mano derecha y una frontera de coordenadas de
   renderizado (recomendado).** Se conserva el marco lógico y se convierte cada
   posición de render: `(x, y, z lógico) → (x, y, -z)`. Las capas y cámaras de
   Babylon usan el helper común; la simulación y los archivos geográficos no se
   transforman. 3D Tiles, entorno y actores comparten profundidad, cámara,
   luces y oclusión.
2. **Una segunda escena RH compuesta sobre la escena LH actual.** Aísla el
   requisito del renderer, pero dos escenas no comparten z-buffer por defecto:
   terreno, coches y edificios podrían dibujarse por encima en orden incorrecto.
   También duplica cámara y tratamiento de entrada. Se descarta para el mapa
   jugable.
3. **No usar el renderer y convertir el contenido a mallas Babylon LH.** Evita
   convertir toda la escena, pero elimina la carga jerárquica y LOD de 3D Tiles
   que se quiere incorporar. Se descarta para este objetivo.

## Diseño recomendado

### Marco lógico y marco de render

Se añade un módulo pequeño (`src/render-coordinates.ts`) con conversiones
explícitas entre el mundo lógico existente y el mundo Babylon RH. La conversión
se aplica en el borde de renderizado, no a `TerrainConfig`, datos OSM, samplers,
la simulación ni los objetivos de misión. Se auditan también vectores, normales,
órdenes de triángulos, yaw, cámara y raycasts, porque cambiar solo `position.z`
deja superficies invertidas o controles reflejados.

La escena principal pasa a `useRightHandedSystem = true`. Se migran por dominio
las mallas de terreno, carreteras, edificios, vegetación, agua, sitios de
referencia, vehículo, motocicleta, personaje y objetivo. El minimapa permanece
en coordenadas lógicas y conserva norte arriba; no debe heredar la reflexión del
render 3D.

### Terreno como tileset local

Un builder determinista produce un tileset desde los 36 heightfields existentes,
con el mismo origen, datum y alturas. El contenido genera niveles de detalle
coherentes con la cámara y conserva transiciones sin huecos. El PNOA se publica
por tesela como imagen externa con su procedencia y licencia. `TilesRenderer`
se actualiza por frame con la cámara principal; `terrain.heightAt()` sigue
consultando los samplers actuales.

Durante la migración se conserva una vía de fallback a las mallas actuales. El
tileset solo se convierte en la vista predeterminada cuando la comparación de
superficies, las pruebas de conducción y el coste de carga pasan los criterios
de aceptación. No se renderizan a la vez dos superficies coincidentes.

### Carga y errores

Los errores al cargar una tesela se registran con URL e identificador. La escena
mantiene el fallback de terreno y la simulación puede seguir leyendo el
heightfield. La falta de contenido visual no debe dejar al vehículo sin suelo.
Se mide el número de teselas activas, bytes descargados y triángulos visibles;
no se reporta FPS de GPU real a partir de SwiftShader.

### Atribución

Se mantienen las atribuciones existentes de IGN/CNIG, PNOA y OpenStreetMap. El
recorte PNOA sigue fuera de los GLB/GLTF. Cada tileset incluye metadatos de
generación y manifest reproducible con origen, resolución, conteos, hashes y
créditos.

## Criterios de aceptación

1. El terreno 3D Tiles coincide con el MDT05 y `heightAt()` en puntos de prueba
   con diferencia vertical máxima de 0,01 m; no hay doble superficie, costuras
   visibles ni inversión norte-sur.
2. Carreteras, lámina de agua, edificios, árboles, sitios focales, vehículo y
   personaje siguen apoyados sobre la misma coordenada lógica del terreno.
3. El vehículo puede completar el circuito de misión existente; conducción,
   controles a pie, interacción y cámara de persecución no quedan reflejados.
4. El minimapa mantiene su orientación, la posición del actor y los hitos.
5. La tesela correcta se activa al mover/acercar la cámara; cargas fallidas
   conservan el fallback. No se observan errores de consola ni respuestas 404.
6. La atribución CC BY 4.0 / ODbL está presente en el runtime y los artefactos
   derivados no incorporan la imagen PNOA dentro del GLB/GLTF.

## Verificación prevista

- Builders y validadores de terreno/tileset, con modo `--check` determinista.
- Conversión lógica↔render y signo de yaw: pruebas de ida y vuelta, norte,
  movimiento cardinal y proyección a cámara.
- `npm run build` y los validadores afectados de terreno, carreteras, pueblo,
  agua, vegetación, focal sites, vehículos y misión.
- Navegador Chrome/CDP en la escena real: captura de inicio, conducción por
  carretera y pista, vado del Oca, entorno de presa y vista aérea; límite de siete
  capturas útiles.
- El arnés de misión debe terminar `COMPLETED` con cero errores de consola. La
  prueba SwiftShader verifica recursos/flujo visual; rendimiento final se mide
  aparte en hardware objetivo.

## Riesgos conocidos

- El renderer Babylon exige escena RH; cambiar la propiedad de escena afecta a
  todos los materiales y mallas, no solo al terreno. Un signo incorrecto puede
  reflejar yaw, luz, normales, culling o cámara.
- El agua conserva una conversión equirectangular histórica diferente del UTM en
  algunos datos. La migración de mano no debe reinterpretarla como una
  desalineación nueva.
- La biblioteca tiene soporte incompleto de algunos volúmenes y formatos 3D
  Tiles. El tileset generado usará cajas y GLTF local; no dependerá de PNTS,
  I3DM ni `boundingRegion`.
- En el prototipo se probó una sola tesela, no el streaming/LOD de los 36 tiles.
  El constructor jerárquico y su presupuesto son parte de la implementación,
  no un resultado ya validado.

## Fuera de alcance

No se migra la autoridad física a 3D Tiles; no se sustituye EPSG:25830 ni el
datum; no se usa geometría o imagen de Google Maps/Earth; no se integra el mapa
en servicios externos ni se cambia la misión.
