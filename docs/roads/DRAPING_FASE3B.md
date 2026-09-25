# FASE 3b — Drapeado de la red vial real sobre el terreno

Producto de la capa de render vial de **Montes de Oca: Offroad Stories**: las
vías reales extraídas en la FASE 3a, dibujadas como cintas de calzada que siguen
la superficie del terreno de Villafranca (DEM IGN MDT05, 36 tiles de 5 m).

- **Entrada**: `public/roads/roads.json` (438 segmentos, 139,021 km). **Se lee,
  no se escribe.**
- **Salida runtime**: `src/road-draping.ts` + cableado en `src/main.ts`.
- **Medición/captura**: `scripts/roads/draping/capture_draping.mjs` (Chrome
  headless + CDP, WebSocket nativo de Node, cero dependencias).
- **Mediciones crudas**: `output/roads_draping.json`.
- **Capturas**: `output/roads_*.png`.

> **Alcance respetado.** Solo se escribió en `src/**`,
> `scripts/roads/draping/**`, `docs/roads/DRAPING_FASE3B.md` y `output/`. No se
> tocó `public/**` (ni `roads.json` ni los tiles), `data/**`,
> `scripts/roads/*.py`, `src/vehicle/**`, el repo de referencia, ni se agregó
> ninguna dependencia.

---

## Actualización de malla — 25 sep 2026

La inspección visual encontró terreno atravesando la calzada en laderas. La
malla ahora subdivide cada 2,5 m, usa secciones transversales de hasta 1,5 m y
levanta localmente los triángulos que cortarían el DEM, dejando al menos 0,02 m
de separación. `audit()` prueba vértices, puntos medios y centroides: 0
penetraciones en 2.743.356 muestras. La red completa conserva 3 mallas y suma
260.245 vértices / 392.260 triángulos. Las tablas de la sección 4 y las medidas
antes/después de la sección 6 corresponden a la malla anterior de 5 m.

## 1. Qué se hizo

Por cada segmento de `roads.json`:

1. Se **subdivide la polilínea a 2,5 m** entre vértices OSM (los vértices
   originales se preservan). El hueco máximo entre vértices OSM de la red es
   **538,6 m**, así que subdividir no es opcional.
2. En cada estación se calcula el tangente por diferencia central y la **normal
   perpendicular** en el plano XZ.
3. Se levantan los vértices de borde cada ≤1,5 m y se **muestrea la cota del
   terreno con `terrain.heightAt`** (nunca se reimplementa la interpolación).
4. Se cierran los triángulos de la franja.
5. **ROAD** recibe además faldones laterales y aplanado parcial (ver §3).
6. Se agrupa todo en **una malla por clase** (`vias:ROAD`, `vias:TRACK`,
   `vias:PATH`) con vertex data propia. **3 draw calls, no 438.**

### Las 6 decisiones cerradas, implementadas tal cual

| # | Decisión | Cómo quedó en el código |
| --- | --- | --- |
| 6.1 | La calzada sigue el terreno, vértice a vértice, sin aplanar | TRACK/PATH: `y = heightAt(vértice) + offset`; se triangula cada ≤1,5 m transversalmente |
| 6.2 | ROAD: aplanado parcial `lerp 0,6` + faldones | `y = max(terrainY, lerp(terrainY, centerY, 0,6)) + offset`; faldón de 0,6 m |
| 6.3 | Offset vertical 0,06–0,15 m | **ROAD 0,12 · TRACK 0,10 · PATH 0,08 m** (ver §3.4 por qué escalonado) |
| 6.4 | Subdividir a 2,5 m y probar el despeje interior de triángulos | `DRAPING.subdivisionM = 2,5`, margen adaptativo 0,02 m |
| 6.5 | No suavizar longitudinalmente | No hay ninguna pasada de suavizado |
| 6.6 | La pendiente transversal la siente la física | No se toca: el vehículo sigue muestreando `terrain.normalAt` |

### Módulo `src/road-draping.ts`

`loadRoadNetwork(scene, terrain, { bounds })` devuelve:

- `meshes`: 3 mallas (una por clase).
- `stats`: vías, estaciones, vértices, triángulos, puentes y las constantes.
- `audit()`: residual de todos los vértices y separación en vértices, centros y
  bordes de triángulo; distingue calzada, faldón y puente.
- `probe(n)` / `stations()`: muestras y estaciones para la verificación externa.

---

## 2. La trampa del §4: respetada

**Toda** altura de terreno sale de `terrain.heightAt` (interpolación triangular
SO→NE de `heightfield.ts`). `road-draping.ts` no reimplementa ninguna
interpolación; el verificador externo tampoco (llama a
`window.__game.terrainHeightAt`). Consecuencia medible: en TRACK/PATH el
residual es del orden del redondeo de `Float32`, no de 0,2 m.

Además se descubrió el caso borde inverso: **fuera de la ventana
`heightAt` devuelve el "0 absoluto" (−870 de mundo)**, no el borde. En el mundo
real eso solo pasa con vértices laterales (a ±ancho/2 y ±0,6 m del faldón) de
vías pegadas al borde del mapa. Por eso `loadRoadNetwork` recibe `bounds`
(0..6000, tomado de los tiles) y **recorta la coordenada de muestreo**; el
vértice se dibuja igual, con la cota del borde. Sin esto aparecía un pico
artificial de −870 m. En la muestra aleatoria quedaron **7 de 6.000** vértices
fuera de ventana, todos recortados.

---

## 3. Decisiones de diseño propias

### 3.1 ROAD: aplanado parcial + faldones

En cada sección del asfalto se conserva el aplanado parcial mientras no quede
bajo el DEM; si el terreno lateral está más alto se limita la cota a ese terreno.
Los puntos medios se miden también y reciben una elevación local cuando una
arista de la malla cortaría la superficie. El faldón de 0,6 m sigue cosiendo el
borde libre al terreno.

### 3.2 Puentes: **no se drapean**

El campo `bridge: true` es por way entero. Para esos 20 segmentos el deck es una
**recta 3D entre las cotas de terreno de sus dos extremos**, sin faldones y sin
muestrear el terreno en el medio. Es exactamente lo que se quiere: el puente
cruza el río/barranco en lugar de bajarse a él. Residual medido del deck contra
el terreno (que **debe** ser ≠ 0, es el hueco que salva): ROAD p95 1,57 · máx
1,71 m; TRACK máx 0,85 m; PATH máx 0,31 m. Están reportados aparte y **no** entran
en la tolerancia de "sobre el terreno".

### 3.3 Cruces: apilado determinista

Dos cintas de distinto orden se solapan en los cruces. En lugar de depender del
orden de dibujo, el offset vertical y el `zOffset` están **escalonados por
jerarquía**: ROAD 0,12 m / zOffset −3 > TRACK 0,10 / −2 > PATH 0,08 / −1. Así, en
un cruce gana siempre la vía más importante y no hay caras coplanares. Los 2 cm
de diferencia son invisibles en el empalme.

### 3.4 Por qué esos offsets

Todos dentro de la ventana 0,06–0,15 m pedida. El escalón resuelve los cruces
(§3.3). Además el `zOffset` (polygon offset) compensa que el offset geométrico es
**menor que la resolución de profundidad a ~1 km** (≈0,2 m con `minZ 0.3` /
`maxZ 40000`); sin él, las vías lejanas z-fightean contra el terreno.

### 3.5 Materiales

`StandardMaterial` (sin dependencias nuevas), `backFaceCulling = false`,
`zOffset` por clase. Asfalto (gris oscuro), tierra (marrón), senda (tierra
clara). Color por vértice con una variación suave determinista para romper la
planitud.

---

## 4. Medición 1 — la cinta está sobre el terreno

Método: `window.__game.roads.audit()` recorre **todos** los vértices de cinta y
calcula `|y_cinta − (heightAt(x,z) + offset)|`. En paralelo, el script toma una
muestra aleatoria de 6.000 vértices y **recalcula el residual del lado del
script** con `terrainHeightAt`, para no autoevaluarse. Los dos coinciden.

**Tolerancia declarada: 1×10⁻³ m** para los vértices que deben seguir el terreno.

| Clase / rol | n | p50 (m) | p95 (m) | máx (m) |
| --- | --- | --- | --- | --- |
| TRACK · calzada | 39.450 | 6,1×10⁻⁶ | 4,3×10⁻⁵ | 1,28×10⁻⁴ |
| PATH · calzada | 11.896 | 1,0×10⁻⁵ | 4,4×10⁻⁵ | 1,39×10⁻⁴ |
| ROAD · faldón (borde libre) | 9.066 | 5,8×10⁻⁶ | 4,2×10⁻⁵ | 1,18×10⁻⁴ |

Verificación externa (muestra de 6.000, script-side):

| Clase / rol | n | p50 (m) | p95 (m) | máx (m) |
| --- | --- | --- | --- | --- |
| TRACK · calzada | 1.997 | 6,1×10⁻⁶ | 4,2×10⁻⁵ | 1,28×10⁻⁴ |
| PATH · calzada | 1.927 | 1,0×10⁻⁵ | 4,2×10⁻⁵ | 9,8×10⁻⁵ |
| ROAD · faldón | 1.015 | 5,8×10⁻⁶ | 4,2×10⁻⁵ | 9,5×10⁻⁵ |

**Lectura**: el residual es el piso de `Float32` (los vértices se guardan en
`Float32Array`), cuatro órdenes por debajo de la tolerancia. **No es 0,2 m**:
la trampa del §4 está respetada.

### ROAD · calzada (aplanado, residual por diseño ≠ 0)

| n | p50 (m) | p95 (m) | máx (m) |
| --- | --- | --- | --- |
| 9.066 | 0,184 | **0,675** | **1,324** |

Es la cota que el faldón debe salvar. Queda por debajo del presupuesto de diseño
(p95 0,91 · máx 1,62 m) y la medición lo confirma: los faldones, de 0,6 m de
ancho, alcanzan.

### Puentes (por diseño NO drapeados)

| Clase | n | p50 (m) | p95 (m) | máx (m) |
| --- | --- | --- | --- | --- |
| ROAD | 54 | 0,297 | 1,572 | 1,709 |
| TRACK | 54 | 0,134 | 0,619 | 0,851 |
| PATH | 30 | 0,026 | 0,304 | 0,312 |

---

## 5. Medición 2 — el faldón llega al terreno

El borde libre del faldón se define como `heightAt(bordeLibre) + offset`, y su
residual medido es **p95 4,2×10⁻⁵ m · máx 1,2×10⁻⁴ m** (tablas de §4). Es
decir: **no deja hueco**, en el sentido de que el borde libre de la cinta toca la
cota del terreno. El hueco de 0,675 m p95 que existe entre el *borde del
asfalto* y el terreno lo cubre justamente la franja del faldón.

> Aclaración honesta: el residual mide que el **borde libre** está sobre el
> terreno. No mide que el plano del faldón no atraviese el terreno entre sus dos
> bordes (en un quiebre cóncavo podría cortar). No se detectó ningún caso visible
> en las capturas, pero no está medido analíticamente.

---

## 6. Medición 3 — triángulos y draw calls (antes / después)

Medido en la misma build, con `?drape=0` (sin vías) y sin él:

| Métrica | Antes (solo terreno) | Después (con vías) | Δ |
| --- | --- | --- | --- |
| **Draw calls** | 13 | **16** | **+3** |
| **Triángulos** | 240.360 | **317.666** | **+77.306** |
| Vértices | 1.454.892 | 1.524.508 | +69.616 |
| Mallas activas | 13 | 16 | +3 |

Desglose de la red (3 mallas):

| Clase | Vías | Estaciones | Vértices | Triángulos |
| --- | --- | --- | --- | --- |
| ROAD | 131 | 4.560 | 18.186 | 26.490 |
| TRACK | 213 | 19.752 | 39.504 | 39.078 |
| PATH | 94 | 5.963 | 11.926 | 11.738 |
| **Total** | **438** | **30.275** | **69.616** | **77.306** |

**El presupuesto de render se sostiene**: 139 km de red cuestan **3 draw calls** y
el **+32 % de triángulos** del terreno. Nada de cientos de draw calls.

---

## 7. Medición 4 — FPS / tiempo de cuadro

> ⚠️ **NO es señal de rendimiento del juego.** Chrome headless sin GPU usa
> **SwiftShader** (render por CPU), igual que en la FASE 4.

| | FPS | frame time |
| --- | --- | --- |
| Sin vías | 9,1 | 116,9 ms |
| Con vías | 8,7 | 34,4 ms |

Los valores no son comparables entre sí (varían con la vista y el estado de
compilación de shaders) y **no representan una GPU real**. Lo válido de esta
sección son los draw calls y triángulos de §6.

---

## 8. Medición 5 — el 4x4 conduce por el camino

Se teleportó el vehículo sobre una estación de la red y se capturó con el coche
encima. Todos los `output/roads_*.png`.

| Captura | Punto (mundo) | Clase | Telemetría relevante |
| --- | --- | --- | --- |
| `roads_track.png` | (3075, 4144) | TRACK | alabeo −14,1° · residual ruedas 0,083 m |
| `roads_road.png` | (3088, 3944) | ROAD | alabeo 0,0° · residual ruedas **0,000 m** |
| `roads_pendiente_transversal.png` | (3320, 3705) | TRACK | transversal **−39,8°** · alabeo −40,4° · residual 0,136 m |
| `roads_vista_ne.png` | (3550, 620, 4350) | vista amplia | picado sobre el cuadrante NE |
| `roads_vista_pueblo.png` | (2800, 680, 3350) | vista amplia | picado sobre el pueblo |

La cinta **no desaparece bajo las ruedas**: el residual de rueda del vehículo es
el de la FASE 4 (el vehículo se apoya en `terrain.heightAt`), y la cinta está
0,08–0,12 m por encima de esa misma superficie.

---

## 9. Medición 6 — el caso difícil (pendiente transversal)

La propia app eligió la estación TRACK de **mayor** pendiente transversal,
proyectando el gradiente del terreno sobre la normal de la vía:

- Punto **(3319,9 · 3705,1)**, clase TRACK.
- Pendiente transversal **40,1°** (p95 de la red TRACK = 17,7°; este es el máximo).
- En la captura el 4x4 aparece **casi volcado (alabeo −40,4°)** y la cinta se ve
  inclinada siguiendo el terreno.

**Se ve mal a propósito, y se muestra igual.** No es un bug del drapeado: es el
micro-relieve real del MDT05 bare-earth y una decisión cerrada (§6.1: seguir el
terreno; §6.6: la física ya cubre la pendiente transversal). El mismo punto es el
`fuerte_40` de la FASE 4. A p95 (17,7°) el efecto es mucho más leve; este es el
extremo.

---

## 10. Un bug real que encontró la verificación (y se corrigió)

Al pasar el offset vertical de escalar a **por clase**, en la construcción del
faldón una variable local `offset` (el desplazamiento **lateral** ±(ancho/2+0,6))
**sombreeó** el offset vertical. Resultado: el borde libre del faldón se iba a
`terreno + 4,35 m`.

- `npm run build` → exit 0 (el build no lo ve).
- `roads.audit()` → faldón p50 3,72 m · máx 4,47 m.
- La verificación **independiente** lo confirmó (p50 3,72 · máx 4,47).

Corregido renombrando la variable lateral. Residual del faldón después:
**p95 4,2×10⁻⁵ · máx 1,2×10⁻⁴ m**. Queda anotado porque es exactamente el tipo de
defecto que "construir no es validar" deja pasar.

---

## 11. Qué NO quedó hecho (explícito)

1. **Sin streaming ni LOD.** Las 3 mallas cubren los 6×6 km enteros y **no se
   culleen**. Consecuencia visible: en vistas que incluyen el horizonte, las vías
   más allá del radio de culling del terreno (`viewRadius = 900 m`) aparecen
   **flotando contra el cielo**. Es inherente al mandato ("sin streaming ni LOD, 3
   mallas"); las capturas amplias se encuadraron en picado para que la red se lea,
   y el artefacto no afecta a la conducción (cámara a 2,4 m).
2. **Los cruces no tienen topología.** Dos vías que se cruzan son dos cintas
   solapadas (apiladas por jerarquía, §3.3). No hay unión de calzada, rotonda ni
   recorte de la cinta que pasa por debajo. Tampoco se usó
   `navigation.json`.
3. **Los puentes no tienen barandas, estribos ni textura propia.** Solo el deck
   lineal. No se detecta en `roads.json` la altura del río bajo el puente.
4. **Sin líneas de eje, cunetas, texturas ni marcas viales.** Material plano con
   color por vértice.
5. **`PATH` se drapea igual que `TRACK`** (salvo ancho y offset). No se distingue
   una senda de un sendero de montaña más allá del ancho de la tabla de diseño.
6. **No se tocó `width`.** El ancho sale tal cual de `roads.json`; no se recalculó
   ni se pisó. Si el diseño de geometría hubiera querido otro ancho, iría acá.
7. **Sin túneles** (la red no tiene ninguno: 0 túneles).
8. **Sin one-way visual** (no hay flechas ni sentidos dibujados).
9. **Sin colisión de la cinta.** El vehículo sigue apoyándose en el terreno
   (FASE 4); la cinta es geometría visual de 8–12 cm de espesor, no una capa de
   física separada.
10. **El faldón no se verifica contra atravesar el terreno en quiebres cóncavos**
    (ver §5).
11. **FPS no representativo** (SwiftShader, §7).

---

## 12. Cómo reproducir

```bash
cd /home/kiri_/projects/montes-de-oca-offroad
npm test                         # typecheck + datum + validador de vías (27/27)
npm run build
npm run preview -- --port 4173   # en otra terminal
node scripts/roads/draping/capture_draping.mjs
```

Salidas: `output/roads_draping.json` (mediciones) y `output/roads_*.png`
(capturas). El script navega a `/?drape=0` para medir el "antes" y a `/` para el
"después", en la misma build.

Parámetro de depuración agregado en `main.ts`: **`?drape=0`** desactiva la capa
vial (solo para medir; sin él las vías se cargan siempre).

---

## 13. Archivos

| Archivo | Qué |
| --- | --- |
| `src/road-draping.ts` | Módulo de drapeado: parseo, subdivisión, geometría por clase, faldones, puentes, materiales, auditoría |
| `src/main.ts` | Cableado: carga la red, expone `window.__game.roads`, `?drape=0`, dispose |
| `scripts/roads/draping/capture_draping.mjs` | Medición + captura por CDP, cero dependencias |
| `docs/roads/DRAPING_FASE3B.md` | Este informe |
| `output/roads_draping.json` | Mediciones crudas |
| `output/roads_track.png` | TRACK de tierra con el 4x4 encima |
| `output/roads_road.png` | ROAD asfaltada con el 4x4 encima |
| `output/roads_pendiente_transversal.png` | Caso difícil: 40,1° transversal, el 4x4 casi volcado |
| `output/roads_vista_ne.png` | Vista amplia del cuadrante NE |
| `output/roads_vista_pueblo.png` | Vista amplia del pueblo |

---

## 14. Definición de hecho

- [x] Las vías se ven sobre el terreno y no lo atraviesan (p50/p95/máx medidos,
      tolerancia 1×10⁻³ m declarada; TRACK/PATH en el piso de Float32).
- [x] ROAD se distingue de TRACK/PATH (aplanado parcial 0,6 + faldones de 0,6 m).
- [x] El 4x4 se teleportó a una TRACK y a una ROAD y se capturó encima.
- [x] Draw calls y triángulos reportados antes (13 / 240.360) y después
      (16 / 317.666).
- [x] El informe dice explícitamente qué NO quedó hecho (§11).
- [x] Toda altura de terreno sale de `terrain.heightAt` (trampa del §4 respetada;
      el verificador externo también la usa).
