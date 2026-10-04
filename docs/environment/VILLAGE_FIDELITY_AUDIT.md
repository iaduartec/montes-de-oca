# Auditoría de fidelidad del casco de Villafranca

Estado de referencia: HEAD `349d984` más los cambios locales presentes el 4 de octubre de 2026. Esta auditoría no representa el contenido completo del HEAD: conserva las huellas y los datos que el runtime consume hoy, y separa las observaciones de las decisiones artísticas.

El inventario reproducible está en `outputs/village-fidelity-20261004/inventory/village-buildings.json`. Se regenera con:

```sh
node scripts/environment/audit_village_fidelity.mjs
node scripts/environment/audit_village_fidelity.mjs --check
```

El comando predeterminado escribe `outputs/village-fidelity-20261004/inventory/village-buildings.json`; `--out-dir <ruta>` cambia el directorio conservando el nombre del archivo. `--check` compara el resultado determinista byte a byte sin escribir. El script lee los derivados versionados de OSM/IGN, los overrides de tejado del runtime, los manifiestos de assets y, si están disponibles, las referencias PNOA por edificio de `outputs/village-fidelity-20261004/references/`. No descarga datos, no altera los archivos fuente y no hace raycasts. El inventario actual contiene 330 edificios: A 20, B 59 y C 251.

## Selección y lectura de las vistas

El nivel A contiene veinte edificios elegidos para cubrir la aparición, Calle Mayor, la iglesia y la plaza, además de los objetivos PNOA individuales revisados. El inventario los ordena por distancia mínima a las posiciones de referencia. El nivel B contiene los edificios restantes a menos de 80 m de algún punto de referencia. El nivel C contiene los que quedan a más de 80 m de todos ellos. Las distancias se calculan del contorno OSM al punto; son una medida de proximidad, no una prueba de que el edificio aparezca en pantalla.

Los puntos de plaza y Calle Mayor se han alineado con el manifiesto fijo de captura; los restantes conservan los aims de `scripts/environment/village_preview.ts` y `scripts/environment/capture_focal_sites.mjs`: cámara de calle en el inicio de ruta, punto al que mira la cámara por Calle Mayor, fachada piloto, vista de la iglesia, vista de la plaza y aim de la vista aérea. No se proyectan los contornos con la matriz real de cámara y no se comprueban edificios interpuestos, terreno, árboles, frustum ni oclusión. El inventario rotula cada distancia como estimación; la confirmación de visibilidad necesita captura del juego.

## Hallazgos que permiten cambios

Las referencias PNOA individuales capturadas el 4 de octubre de 2026 sustentan cuatro cambios de geometría de cubierta (tres formas y una orientación) y una corrección artística de apariencia. La geometría visible permanece dentro de la huella OSM; la imagen acredita planta y cubierta, no fachadas ni alturas verticales medidas. La heurística actual se calcula con el centroide, el eje principal, el hash, los límites de convexidad y la selección de `src/environment/village.ts`.

| Way OSM | Runtime anterior | Evidencia PNOA | Decisión acotada | Confianza |
| --- | --- | --- | --- | --- |
| 818885706 | Tejado a un agua; eje actual calculado ~171° | Cubierta a dos aguas con cumbrera aproximadamente N–S dentro de la huella mapeada | Cambiar a dos aguas y orientar la cumbrera aproximadamente N–S | Alta para la forma; aproximada para el eje |
| 818885708 | Tejado a un agua; huella cóncava | Cubierta principal a cuatro aguas, encajada en la huella mapeada | Cambiar a cuatro aguas con una superficie recortada y validada dentro del polígono OSM | Observada para los testeros; probable para el ajuste de toda la cubierta compuesta |
| 474364245 | Tejado a un agua; huella cóncava | Testero de cubierta a cuatro aguas legible dentro de la huella | Cambiar a cuatro aguas con superficie segura para el contorno cóncavo | Observada para el testero; probable para el ajuste de toda la cubierta |
| 474649085 | Dos aguas; eje PCA actual ~82° | Cubierta a dos aguas con eje aproximado N–S | Conservar dos aguas y girar la cumbrera hacia N–S | Alta para la forma; aproximada para el eje |
| 672017718, Antiguo Hospital | Material artístico `chapa`; forma compleja de un solo volumen | La mayor parte de la cubierta de varias alas muestra tonos envejecidos cálidos, con un pequeño paño azul grisáceo | Asignar apariencia artística de teja envejecida al volumen. No reinterpretar las alas como una sola cubierta simple ni texturizar con píxeles PNOA | Probable para material; observada para color general |

Los cambios implementados están en `src/environment/village-building-overrides.ts`. Las dos cubiertas a cuatro aguas cóncavas usan `src/environment/village-roof-geometry.ts`: primero se triangula la huella simple y luego se divide en paños de planos por sus líneas de quiebre. El test usa las dos huellas OSM reales y comprueba contención de centroides, área total y elevación máxima. Los overrides conservan `heightM`, huella y base del runtime.

La ortofoto no da licencia para afirmar el material de construcción: la fila del Hospital es una decisión artística basada en la apariencia visible. No se copiarán píxeles al asset. Su altura visual continúa basada en tres plantas OSM y 202 muestras de LiDAR con P95 de 13 m; ese P95 es altura de superficie normalizada y no una medida de alero levantada.

El control `310174514` ya muestra una cubierta a dos aguas y un eje que concuerda con la orientación aproximada de PNOA; no se registra un cambio. En 818885703/704 PNOA muestra alas asimétricas y cubiertas superpuestas; los polígonos OSM contiguos no permiten asignar cada faldón sin comprobar límites y solapes. En 818885707 se distingue una cubierta a dos aguas en un volumen inferior, pero la correspondencia exacta entre ese volumen y el contorno OSM no basta para un override aislado.

Los cuatro Way 818885674–677 están etiquetados como edificios industriales de una planta, sin muestras LiDAR clasificadas. El runtime deriva `chapa` del tipo `industrial`; las ortofotos nuevas muestran cubiertas grises en 674–676 y un parche cálido ambiguo en 677. Se conserva el aspecto actual hasta demostrar una discrepancia. `building:levels` es una etiqueta OSM, no una altura medida.

## Evidencia ya reutilizable

- `public/village/buildings.json` conserva las 330 huellas construidas a partir de 335 ways OSM. `data/gameplay/raw/osm_buildings_villafranca.json` conserva los tags originales; el snapshot consultado es de 2026-09-25 y la licencia es ODbL 1.0.
- `public/village/building_height_grid.json` y `public/village/ign_mdsn_e025_villafranca_2_5m.bin` aportan el MDSnE IGN/CNIG de primera cobertura LiDAR, resolución de 2,5 m y licencia CC BY 4.0. Para cada edificio, el inventario informa celdas válidas y P95. El runtime exige al menos cuatro celdas, resta la subida geométrica del tejado y usa alturas OSM derivadas si el resultado no pasa sus límites.
- `public/village/pilot-houses.glb` ya agrupa ocho casas próximas a la salida, con alturas LiDAR y detalles estilizados. La ortofoto motivó dos cambios documentados de cubierta para 474364247/248; los otros seis pilotos no tenían una discrepancia demostrada en la auditoría anterior. Sus fachadas siguen siendo aproximaciones.
- `public/village/focal-sites/church.glb` y `plaza.glb` ya resuelven los hitos principales. El primero tiene cubierta cruzada y torre estilizada; el segundo incorpora pavimento drapeado a la plaza OSM, forecourt y mobiliario aproximados. La foto local `fotos/Iglesia_plaza.jpg` no tiene autor, fecha ni licencia registrados y solo puede servir como referencia visual, no como textura ni evidencia métrica.
- Las fotos aéreas `VI3E3604.jpg` y `VI3E3605.jpg` permiten inspeccionar la forma general del pueblo y el contraste entre cubiertas cálidas de teja y cubiertas grises. No están georreferenciadas por edificio y su procedencia/licencia no está registrada; no justifican detalle de fachada ni cambios por Way individual.
- `outputs/village-fidelity-20261004/references/{ID}.json` conserva bbox WGS84, URL exacta, proveedor y licencia de las consultas PNOA recientes. El servicio representa la máxima actualidad y esos JSON no asignan por sí solos un año de vuelo. El ledger conserva los once objetivos anteriores y añade cinco correcciones de representación procedural; las comparaciones y parámetros de aceptación se validan con `--phase=village`. Los seis bloqueos históricos permanecen explícitos.

## Guía de kits y límites de la fachada

`src/environment/village-facade-kits.ts` contiene perfiles compartidos `calle-mayor`, `casa-rural` y `casa-cuadra`, y `src/environment/village-pilot.ts` asigna estilos artísticos a las ocho casas piloto. Para edificios detallados fuera del piloto, `facadeKitsByBuilding` permite escoger override del edificio, kit con evidencia, kit artístico y finalmente hash estable, en ese orden. Un fixture del renderer verifica que la elección de contraventanas llega a los buffers. Los pilotos GLB mantienen su representación existente. Esta entrega conecta la prioridad de evidencia; no declara terminado el catálogo completo Facade Kit V2 de balcones, huecos y materiales. Esos perfiles solo deben añadir variación visual contenida: teja, contraventanas, zócalos o portones estilizados. OSM no etiqueta las fachadas individuales revisadas y las imágenes aéreas no muestran sus huecos, materiales de muro o plantas con suficiente precisión.

La prioridad para extender detalle visible es 1509797551 (residencial, dos plantas, diez celdas LiDAR), 818885708 (residencial, tres plantas, dieciséis celdas), 310174514 (Calle Barrio Alto, tres plantas, dieciocho celdas) y 672017718 (Antiguo Hospital, tres plantas, 202 celdas). Los datos permiten fijar masa, planta y perfiles de arte compartidos; no autorizan recrear puertas o ventanas como hechos observados.

## Capturas y coste

La captura `before` ya está congelada en `outputs/village-fidelity-20261004/before/`. Para generar el `after` del juego con sus mismas cámaras, iniciar el servidor Vite en `http://127.0.0.1:5174` y ejecutar:

```sh
node scripts/environment/capture_village_fidelity.mjs --phase after --base http://127.0.0.1:5174 --manifest outputs/village-fidelity-20261004/before/camera-manifest.json --out-dir outputs/village-fidelity-20261004/after
```

Las capturas se guardan en `outputs/village-fidelity-20261004/after/`; se pueden limitar vistas con `--views calle_mayor_1,plaza,iglesia,house_818885706,house_818885708,house_474364245,house_474649085,house_672017718`. El harness incluye el arranque jugable, calle Mayor, plaza, iglesia y objetivos individuales; registra errores de consola y métricas de geometría.

El baseline y las capturas comparables de esta entrega usan SwiftShader: los draw calls/triángulos sirven para comparar la misma escena; su FPS y frame time no prueban rendimiento en RTX 2070.

La comparación de esta entrega conserva los mismos aims y el control individual: 310174514 sin cambio y 818885674–676 sin cambio de material. Inspeccionar los PNG, revisar errores de consola y reportar los costes junto a la evidencia geométrica. Para reclamar rendimiento objetivo se necesita una captura comparable en el hardware objetivo.

## Ranking de veinte estructuras A

Prioridad de inspección por proximidad a los puntos fijos, con iglesia como hito central. `h` es estimación del muro/asset, no un levantamiento. La columna kit es candidato artístico; su aplicación depende del radio de detalle y de la sustitución por GLB. Visibilidad: estimada por distancia; se confirma solo donde existe cámara individual revisada.

| Prioridad | Way OSM | Punto próximo | Distancia m | h estimada m | Cubierta actual | Kit / asset | Evidencia |
|---|---|---|---:|---:|---|---|---|
| 1 | 90614388 | church | 0 | 18 | cross-gable landmark asset | GLB | ledger previo |
| 2 | 305647007 | facade305647007 | 0 | 7.097 | gable | GLB | ledger previo |
| 3 | 1509797544 | facade305647007 | 3.38 | 4.242 | gable | GLB | ledger previo |
| 4 | 433198559 | calleMayorStreetLookTarget | 9.37 | 6.086 | gable | GLB | ledger previo |
| 5 | 310458426 | calleMayorStreetLookTarget | 10.38 | 5.727 | gable | GLB | ledger previo |
| 6 | 1509797545 | facade305647007 | 11.33 | 4 | gable | GLB | ledger previo |
| 7 | 474364247 | spawnStreetCamera | 13.02 | 5 | gable | GLB | ledger previo |
| 8 | 474364248 | spawnStreetCamera | 22.08 | 5 | gable | GLB | ledger previo |
| 9 | 818885676 | calleMayorCapture1 | 22.83 | 3.2 | gable | calle-mayor | PNOA por ID |
| 10 | 310174514 | facade305647007 | 23.78 | 6.232 | gable | casa-cuadra | PNOA por ID |
| 11 | 474364245 | facade305647007 | 25.79 | 8 | hip | calle-mayor | PNOA por ID |
| 12 | 818885675 | calleMayorCapture1 | 30.1 | 3.2 | hip | casa-rural | PNOA por ID |
| 13 | 818885707 | spawnStreetCamera | 31.08 | 5.896 | gable | casa-cuadra | PNOA por ID |
| 14 | 818885678 | spawnStreetCamera | 33.47 | 6.288 | gable | GLB | ledger previo |
| 15 | 818885703 | church | 35.62 | 6.892 | gable | casa-rural | PNOA por ID |
| 16 | 672017718 | plaza | 36.53 | 10 | gable | casa-rural | PNOA por ID |
| 17 | 818885706 | church | 38.16 | 10 | gable | casa-cuadra | PNOA por ID |
| 18 | 818885708 | spawnStreetCamera | 39.48 | 8 | hip | casa-rural | PNOA por ID |
| 19 | 818885704 | church | 39.98 | 7.645 | gable | casa-rural | PNOA por ID |
| 20 | 474649085 | facade305647007 | 40.28 | 5.726 | gable | calle-mayor | PNOA por ID |

## Resultado aceptado del alcance

La revisión independiente y el orquestador aceptan cuatro correcciones de perfil de cubierta y solo la apariencia del Antiguo Hospital. 818885708/474364245 conservan un ajuste probable de alas compuestas. En 672017718 el volumen compuesto y el pequeño paño acristalado permanecen bloqueados; la mejora de color no demuestra fidelidad completa del edificio. `evidence.json` conserva este límite y no elimina los seis blockers anteriores.

Las 21 vistas finales tienen cámara/preset/resolución comparables y cero errores en el reporte aceptado. Diecinueve proceden del servidor fuente; spawn/NPC se repitieron con el build de la misma fuente congelada. El intento de spawn negro se archivó y rechazó. Una comprobación posterior en frío demuestra que desarrollo y preview renderizan el juego sin excepción; los harnesses ahora exigen recursos positivos, carga de página y geometría renderizada. El test antiguo del catálogo que exigía caída por giro se actualiza al contrato de estabilidad.

Los draw calls, meshes activos y texturas son iguales en las vistas emparejadas. El contador suma 1.130 triángulos/2.606 vértices en las vistas de diagnóstico; spawn suma 2.260 triángulos/2.606 vértices. La teselación segura general de gables y las cubiertas objetivo comparten buffers: este aumento no es un coste aislado de cada uno de los cinco IDs. `review/village-comparison.json` registra los valores por vista y la procedencia.
