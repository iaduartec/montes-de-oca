# Hitos del entorno: iglesia, plaza, El Pájaro y presa

## Objetivo

Mejorar por etapas cuatro lugares reconocibles de Villafranca de Montes de Oca, conservando la escala, las ubicaciones de OSM, el terreno IGN y el estilo low-poly castellano. El orden de entrega es iglesia y plaza, parking de El Pájaro, presa de Alba.

## Estado y datos disponibles

- La Iglesia de Santiago Apóstol es el way OSM `90614388`. `public/village/buildings.json` conserva su huella y una altura de 12,8 m, pero esa altura procede del valor por tipo de cuatro plantas; no es una medición LiDAR confirmada.
- La plaza es el way peatonal OSM `645040295`; el tramo `741760074` está etiquetado como `living_street` y pavimento de piedra. Las mallas actuales de carretera y su superficie quedan intactas.
- Los datos locales no contienen una entidad OSM llamada El Pájaro ni una huella del parking. Hay referencias de dirección pública, pero la ubicación de los límites del aparcamiento se fijará por comparación manual con el comparador PNOA/IGN y las huellas OSM del entorno. No se copiarán imágenes, tiles ni geometría de otros mapas.
- La presa de Alba es el way OSM `168459142`. `src/environment/water.ts` ya genera un muro plano en una malla; el proyecto tiene MDSnE IGN de 2,5 m pero no una fotografía local del muro.
- Hay fotografías de la iglesia en Wikimedia Commons. La referencia `Villafranca Montes de Oca-02-Santiago Apostol-1996-gje.jpg`, de Gerd Eichmann, permite reutilización bajo CC BY-SA 4.0. Se usará como referencia visual y se acreditará en la procedencia del asset; cualquier asset derivado respetará la licencia aplicable.
- El comparador PNOA del IGN se usará para observar huellas, cubiertas, entorno y parking. Sus imágenes no se empaquetarán en el juego.

## Diseño

Una capa nueva, aislada de la generación masiva de edificios, reunirá los hitos singulares y los props de sitio. Mantendrá activos los builders de terreno, carreteras, colisiones y casas como fuentes de verdad. El GLB de las ocho casas piloto y sus rutas de fallback se conservarán. La carga de hitos tendrá fallback sin bloqueo: si falta un GLB o falla su parseo, el juego conserva la geometría de pueblo y agua existente.

### Iglesia y plaza

Modelar la iglesia como pieza singular en Blender usando la huella OSM, las cotas del terreno y alturas derivadas disponibles; distinguir datos observados de las decisiones artísticas. Las fotografías CC BY-SA 4.0 guiarán la silueta y los rasgos visibles. La geometría será una reconstrucción low-poly, no un escaneo ni una reproducción métrica interior.

Representar la plaza con un grupo pequeño de mobiliario reutilizable de escala humana. Se elegirán piezas respaldadas por la ortofoto/fotografías; los elementos no confirmados serán arte genérico y no se describirán como históricos. No se retexturiza ni se reconstruye la superficie de calzada existente.

### Parking de El Pájaro

Fijar primero el polígono del área observada en PNOA/IGN, referenciado en coordenadas del mundo y separado de la huella del edificio. Si la imagen no permite diferenciar plazas pintadas, bordes o firme, esos detalles no se afirmarán como reales: se usará una explanada estilizada con procedencia y grado de confianza documentados. No se incorporarán fotos de fachada con licencia desconocida.

### Presa

Mejorar el muro existente con facetas de hormigón y los detalles que se puedan confirmar mediante fuentes reutilizables. La geometría de base/coronación, ubicación y cota seguirá viniendo de `water.json` y el terreno. La nueva capa decorativa no toca el DEM, profundidad del vaso ni reglas de conducción por agua. Sin evidencia de compuertas, barandillas o aliviadero, esos componentes no se presentarán como reconstrucción literal.

## Assets, runtime y atribución

- Fuentes Blender editables y GLB exportados con materiales planos/color por vértice; no se requieren texturas fotográficas.
- Separar por lugar las mallas para que el culling no use un único bounding box que abarque pueblo y presa. Agrupar por material dentro de cada lugar; no crear una malla por cada detalle pequeño.
- Reutilizar `@babylonjs/loaders` existente. La integración de la iglesia debe evitar dibujar dos veces el edificio genérico `90614388`, manteniendo el builder existente como fallback si falla el asset.
- Cada asset tendrá un manifiesto con IDs OSM, fuente/fecha del extract, fuente IGN y CC BY 4.0, licencia/autores de fotos reutilizadas, archivos `.blend`/`.glb`, hashes, bytes, triángulos, mallas y etiqueta de aproximación.
- Atribuir OpenStreetMap bajo ODbL 1.0 e IGN/CNIG bajo CC BY 4.0 según las atribuciones ya mantenidas por el proyecto.

## Límites de rendimiento y aceptación

- Hasta 2 draw calls nuevos por lugar visible, agrupados por material, y hasta 20.000 triángulos adicionales para el conjunto iglesia/plaza/parking/presa.
- Hasta 600 KiB de GLB nuevos para los cuatro lugares, sin texturas raster. Cualquier exceso requiere una reducción de geometría/materiales antes de integrar.
- La iglesia conserva el centro, huella OSM y apoyo `terrain.heightAt`; el límite de su altura estimada queda explícito en el manifiesto.
- La plaza no cambia mallas/collisions de carreteras. El parking se alinea con el polígono observado y no se infiere su forma a partir de Google.
- La presa conserva posición, cotas, profundidad y comportamiento del agua.
- Capturas comparables antes/después desde iglesia/plaza, parking y presa; build, suite del proyecto y validación visual en juego; revisar draw calls, triángulos y bytes de assets.

## Fuera de alcance

El resto de las 330 huellas, interior de edificios, cambios a terreno/carreteras, nuevos recorridos, misión, conducción, física, controles de conducción, UI y navegación.

## Fuentes

- OSM way 90614388: https://www.openstreetmap.org/way/90614388
- OSM way 645040295: https://www.openstreetmap.org/way/645040295
- OSM way 741760074: https://www.openstreetmap.org/way/741760074
- OSM way 168459142: https://www.openstreetmap.org/way/168459142
- Foto reutilizable de la iglesia: https://commons.wikimedia.org/wiki/File:Villafranca_Montes_de_Oca-02-Santiago_Apostol-1996-gje.jpg
- Comparador PNOA/IGN: https://visualizadores.ign.es/comparador_pnoa/
- Descargas CNIG e información de licencia: https://centrodedescargas.cnig.es/CentroDescargas/
- Dirección publicada del restaurante El Pájaro, pendiente de comprobación visual del parking: https://listae.me/informacion-restaurante/el-pajaro/
