# AGUA · ríos, arroyos y embalse de Alba

Especificación de diseño (aprobada en conversación el 26 sep 2026). Es el
artefacto que precede al plan de implementación; **no hay código de producto
todavía**.

## 0. Objetivo y alcance

Que el valle se lea como el valle real del Oca: el río pasando por Villafranca,
sus arroyos, y el embalse de Alba con su presa como pieza mayor del paisaje.

- **Es escenografía.** No hay misión nueva ni objetivos.
- **Se puede entrar al agua.** Si el 4x4 se hunde demasiado o se enfanga, vuelve
  a la orilla con un aviso en pantalla.
- **Queda fuera**: reflejos/espejos de agua, oleaje animado, shaders nuevos,
  balsas de depuración (`water=wastewater`), canalizaciones, y **excavar el DEM**
  (ver §3.2).

Criterio de éxito: el embalse, la presa, el Oca y los arroyos se ven en su sitio
real y con profundidad creíble; el 4x4 se hunde y vuelve a la orilla como se
pidió; la misión actual sigue completándose; el coste en móvil no sube de forma
apreciable.

## 1. Datos de entrada (OSM, ventana jugable)

Consulta Overpass sobre la ventana del terreno (6×6 km, `bounds` de
`public/terrain/config.json`), con geometría completa. Elementos y conteo real
del reconocimiento:

| Elemento | Tipo OSM | N | Uso |
| --- | --- | --- | --- |
| Embalse de Alba | `natural=water` + `water=reservoir` (relation) | 1 | lámina a cota de vaso |
| Presa de Alba | `waterway=dam` | 1 | muro |
| Río Oca | `waterway=river` | 5 tramos | cinta de río |
| Río Retorto | `waterway=river/stream` | 7+ tramos | cinta |
| Arroyos | `waterway=stream` | ~70 | cintas finas |
| Laguna de Valliciruelas | `natural=water` + `water=lake` | 1 | lámina |
| Lago/Fuente de San Indalecio | `natural=water` + `water=pond` | 2 | láminas |
| Pilón | `natural=water` | 1 | lámina |
| Zanja | `waterway=ditch` | 1 | cinta fina |
| Balsas de depuración | `natural=water` + `water=wastewater` | 8 | **excluidas** |

Datos crudos: `data/water/raw/` con su `*_query.txt` y manifiesto, mismo patrón
que `data/roads/raw/`. El reconocimiento ya dejó el archivo de consulta probado
(ventana y corredor de ruta).

## 2. Cotas y geometría (medidas del DEM real)

- **Nivel del embalse**: el DEM trae el vaso como un plano a **1013,0 m**
  absolutos; la lámina se dibuja a **1013,15 m** (world y ≈ 143,15, con el datum
  vertical de −870 m). Aguas abajo de la presa el terreno cae a 981-989 m, así
  que el escalón del muro (≈30 m) ya existe: la presa se ve.
- **Ríos y arroyos**: cintas caladas sobre el terreno como las pistas de tierra,
  a **+0,15 m** del terreno local. Anchos: `width` OSM si existe; si no, por
  tipo (río 7 m, arroyo 2,5 m, zanja 1,2 m). Donde el DEM tiene cauce (p. ej. el
  Oca al norte del pueblo, ~14 m por debajo de la terraza) la cinta baja dentro
  del cauce.
- **Vado del Oca en la ruta** (3176, 3450): el DEM es vega casi plana y la ruta
  lo cruza. La cinta queda a ≤0,25 m sobre el terreno ⇒ profundidad de paso
  ≲0,35 m ⇒ **la misión sigue siendo completable**. Esto es requisito, no
  preferencia (§6).
- **Láminas menores** (laguna, charcas, pilón): polígonos a la cota del terreno
  circundante + 0,15 m.

## 3. Datos horneados

Constructor `scripts/water/build_water.py` (Python, como `build_roads.py`):
crudo + DEM → `public/water/water.json`, `public/water/stats.json`,
`public/water/ATTRIBUTION.md`, con modo `--check` reproducible byte a byte.

### 3.1 Esquema de `water.json`

- `schemaVersion`, `meta` (fuente, sha256 del crudo, fecha, script sha).
- `sheets[]`: láminas (`reservoir | lake | pond`), con `levelM` (absoluta),
  `polygon` recortado a la ventana y triangulado en abanico.
- `ribbons[]`: ríos/arroyos/zanjas, con `points[]` (eje remuestreado a 2,5 m),
  `widthM`, `kind` y `caladoM` de calado visual nominal (0,15-0,25; la holgura
  real sobre el terreno sigue al DEM y puede enflaquecer en los lomos).
- `dam`: línea del muro con `crestM`, `baseM` y ancho, para la malla del muro.
- `depthGrid`: campo de profundidad del vaso, celdas de 25 m, `origin`, `cellM`,
  `cols`, `rows`, `depths[]` en decímetros (0 en la orilla, hasta ~18 m junto a
  la presa).

### 3.2 Por qué no se excava el DEM

El DEM no tiene batimetría: dentro del vaso todo es el plano de cota 1013. En
lugar de modificar los 36 tiles del terreno (riesgo alto: datum vertical,
validadores, colocación de pueblo/vegetación, y la base de todo el mundo), la
profundidad vive **solo en los datos del agua** y el hundimiento se resuelve con
calado visual del vehículo (§5.3). Así el terreno queda intacto y, si el campo de
profundidad fallara, el agua se sigue viendo.

## 4. Runtime

Módulo nuevo `src/environment/water.ts`, mismo patrón que `village.ts` /
`vegetation.ts`: `loadWater(scene, terrain, options)` devuelve `stats` y
`dispose()`, más la API de consulta del §5.1.

- **Mallas (≤3)**: `agua:laminas` (embalse + lagunas + charcas), `agua:cintas`
  (ríos y arroyos) y `agua:presa` (muro). Una malla por material; sin mallas por
  elemento.
- **Color por vértice, sin animación**: tonos por profundidad (claro en la orilla
  → azul oscuro en el vaso), y **espuma blanca de 1-2 m** en el borde de cada
  lámina y a los lados de cada cinta.
- **Material** `StandardMaterial` plano, sin reflejos, sin transparencia
  (la profundidad se lee por tono, no por transparencia).
- **Toggle de medición**: `?water=0` apaga la capa entera, como `?pueblo=0` y
  `?drape=0`, para medir draw calls y triángulos con y sin agua en la misma
  build.
- **Integración**: `main.ts` carga el agua después de las vías y expone
  `window.__game.water` con la API de consulta para los arneses. No se añade
  despeje de vegetación: el módulo de vegetación ya trabaja por corredores y
  claros, y este pedido es solo agua.

## 5. Reglas del 4x4 (hundimiento y enfangado)

### 5.1 API de consulta

- `depthAt(x, z): number` — 0 en seco; 0,15-0,25 en cintas; 0-18 en el vaso.
- `isMuddy(x, z): boolean` — banda húmeda: profundidad 0,05-0,5 m o a ≤12 m de
  una orilla con pendiente < 20°.
- `nearestSafeShore(x, z): { x, z } | null` — punto más cercano con profundidad 0
  y pendiente < 20°, buscado en anillos de 25 m hasta 150 m.

### 5.2 Efectos por profundidad

| Profundidad | Efecto |
| --- | --- |
| ≤ 0,35 m | Paso normal (vados del Oca y arroyos). Solo arrastre leve. |
| 0,35 - 1,1 m | Arrastre alto: límite de velocidad objetivo dentro del agua (se implementa en el paso de simulación, sin tocar `src/vehicle/physics.ts`) y calado visual hasta 1,5 m. |
| > 1,1 m | Secuencia de hundimiento (~1,5 s) y retorno a la orilla. |

Enfangado: si `isMuddy` y `velocidad < 0,4 m/s` con gas aplicado durante **> 3 s**,
se dispara la misma secuencia (sin profundidad alta).

### 5.3 Secuencia de hundimiento

1. Se atenúa el control (sin fuerzas nuevas: solo límite de velocidad).
2. Calado visual: el modelo del 4x4 baja hasta 1,5 m respecto de su pose, para
   que la lámina lo tape (el terreno no se toca; sólo el offset visual del nodo).
3. A los ~1,5 s: mensaje fijo en pantalla **«El 4x4 se hundió — volvés a la
   orilla»**, teleport a `nearestSafeShore`, velocidad 0 y calado a 0.
4. Si no hay punto seguro en 150 m, se usa la última posición con profundidad 0
   (garantiza salida siempre; sin estado bloqueado).

No se modifican física, controles ni la misión: la regla vive en el paso de
simulación y solo añade amortiguación y un offset visual.

## 6. Pruebas y criterios de aceptación

- **Datos**: `build_water.py --check` reproducible; invariantes (ninguna lámina
  fuera de la ventana; ninguna cinta con ancho ≤0; cotas de lámina ≥ nivel del
  terreno bajo ellas; `depthGrid` con máximo junto a la presa y 0 en el borde).
- **Arnés de agua** (`scripts/water/drive_water.mjs`, Chrome headless + CDP, cero
  dependencias): teleporta el 4x4 al vaso, conduce hacia el centro y comprueba
  (a) que `depthAt` crece, (b) que aparece el estado de hundimiento, (c) que
  termina en tierra (`depthAt` 0, velocidad 0), (d) que el HUD muestra el aviso y
  (e) que la consola queda sin errores.
- **Regresión de misión**: el arnés de milestone existente
  (`scripts/milestone/drive_milestone.mjs`) debe seguir llegando al repetidor.
  Es la prueba de que el vado del Oca quedó pasable.
- **Vado**: medición explícita de `depthAt` en los tres cruces de la ruta
  ((3176,3450), (3118,3501), (3139,3485)) con tope de 0,35 m.
- **Visual**: capturas antes/después con la misma cámara en (a) la presa desde el
  agua arriba, (b) la orilla del vaso, (c) el vado del Oca, (d) un arroyo. Con y
  sin `?water=0` para el coste.
- **Presupuesto**: ≤3 mallas nuevas, ≤40 k triángulos (revisado el 26 sep 2026
  con datos reales: las 60 cintas a 2,5 m de paso dan ~31,7 k triángulos; la
  estimación inicial de 25 k no contaba el número real de arroyos y recortarles
  fidelidad no compensa), `water.json` ≤0,5 MB,
  0 trabajo por frame salvo una consulta de celda (O(1)); medición de draw calls
  y triángulos con y sin la capa.

## 7. Publicación y rollback

Build con `--base=/montes-de-oca/`, backup de `/srv/www/montes-de-oca`, copia,
verificación de HTTP 200 y HTML idéntico a `dist`, captura servida desde
Tailscale, y `record_change` en Project Bridge con las decisiones y la
verificación. Rollback: restaurar el backup del sitio (patrón ya usado en los
pasos 1-4).

## 8. Riesgos

- **Radio del vaso**: la lámina se recorta a la ventana; si el embalse siguiera
  fuera del terreno, el borde recortado puede verse recto en el extremo oeste.
  Mitigación: espuma en el borde recortado y cámara de revisión en esa esquina.
- **Arroyos intermitentes**: la mayoría son estacionales; se dibujan todos, pero
  con calado mínimo. Si ensucian la lectura, se filtran por longitud (>150 m).
- **Coste en móvil**: mitigado por el toggle `?water=0` y por el límite de
  triángulos; la medición real se hará en el iPhone con F3 (paso 5 pendiente).
