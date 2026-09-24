# DECISIÓN — Resolución de la convención de coordenadas y de la fuente de terreno

**Fecha**: 2026-09-25
**Contexto**: `docs/geo/GEO_PLAN.md` (worker W6, MiMo free) llegó **después** de que la FASE 2
(`docs/terrain/TERRAIN_FASE2.md`, worker T1, DeepSeek) y la FASE 3a (`docs/roads/ROADS_FASE3.md`,
worker T2, MiMo free) ya estuvieran construidas contra una convención fijada en sus packets.

Este documento resuelve las discrepancias y deja constancia de qué se adoptó y qué se rechazó, con
el motivo. **No se reescribe ningún trabajo ya validado.**

---

## 1. Nota de proceso (error mío, para no repetirlo)

Despaché T1 y T2 con una convención fija **antes** de que el plan geo hubiera terminado. El plan geo
tenía secciones enteras dedicadas a *elegir* esa convención (§5 Proyección y origen, §6 Tiling).

**Costo real: cero**, porque las diferencias resultaron ser de convención y no de corrección, y la
convención ya construida resiste la comparación. **Costo potencial: alto** — si W6 hubiera encontrado
un problema real (geometría mal alineada, CRS incompatible), habríamos regenerado terreno y rutas.

**Regla que queda**: las decisiones transversales (origen, CRS, escala, resolución) se **cierran antes**
de despachar trabajo que dependa de ellas. Si un worker está calculándolas, o se lo espera, o se le
fija la convención en el packet para que no la elija.

---

## 2. Discrepancias y resolución

### 2.1 Fuente de terreno: MDT02 (2 m) vs MDT05 (5 m)

| | GEO_PLAN | Lo construido (T1) |
| --- | --- | --- |
| Fuente | **MDT02 (2 m)**, §4.5 | **MDT05 (5 m)** vía WCS |
| Tiles | 8 m base + 4 m LOD cercano, §6.5 | **5 m nativo**, tiles de 1000 m |

**El propio `GEO_PLAN` se contradice**: §4.5 elige MDT02 como fuente, pero §6.5 dice
textualmente *«**descartar 2 m** (66 049 vértices → índices `u32`, 252 MiB)»* — porque 2 m por tile
de 512 m da **66 049 vértices, que NO caben en índices `u16`** (límite 65 536), forzando `u32`,
252 MiB y 18,8 M triángulos.

**Resolución: se mantiene MDT05 a 5 m.** Motivos:

1. **No hay remuestreo.** El MDT05 se descargó del WCS en su **grilla nativa** de 5 m. La regla 4 de
   `GEO_PLAN §7` («etiquetar toda grilla remuestreada como *remuestreo de MDT02*») **no aplica**:
   no estamos remuestreando nada.
2. **La diferencia es invisible conduciendo.** RMSE medido entre MDT02 y MDT05 = **0,835 m**
   (`dem_comparison.json`). 0,835 m de error vertical en un mundo de 324 m de relieve no se ve.
3. **Los tiles construidos son MÁS finos que la recomendación de `GEO_PLAN`.** W6 recomienda base de
   **8 m**; lo construido ya está a **5 m**. Adoptar el plan *empeoraría* el detalle.
4. **2 m no resuelve la pista forestal de todos modos.** Una pista tiene 3–4 m de ancho: ni 5 m ni 2 m
   de celda representan su corte transversal. Por eso **la pista se drapea, no se excava** — y esa
   decisión es independiente de la resolución del DEM.

**Se conserva**: `data/geo/raw/mdt02_bbox_2m.tif` (26,7 MB) **en disco** como fuente autoritativa, por
si en el futuro queremos un LOD cercano a 4 m (que `GEO_PLAN §6.5` sí recomienda y que sigue siendo
válido). No hay que volver a descargar nada.

### 2.2 Origen del mundo: centro del bbox vs esquina sudoeste

| | Valor |
| --- | --- |
| `GEO_PLAN §5.1` | E 474 123 / N 4 691 751 (centro del bbox, vértice de celda par) |
| Construido (T1/T2) | E 471 500 / N 4 689 000 (esquina sudoeste) |

**Resolución: se mantiene la esquina sudoeste.** Motivos:

1. **Es una traslación pura.** Cambiar el origen no corrige ningún error: sólo mueve el cero.
2. **Ya está shippeada y verificada.** El crosscheck DEM↔`heightAt()` da **diff 0** en 5 puntos, y los
   36 tiles son copia 1:1 del ráster.
3. **El argumento de alineación de W6 ya se cumple.** Su preocupación era que el ráster MDT02 tiene
   vértices en coordenadas **impares**, y por eso eligió un vértice par. Nuestra grilla de 5 m del WCS
   tiene bounds en **múltiplos exactos de 5 m** (`471500`, `477505`, `4688995`, `4695000`) y los
   límites de tile caen en múltiplos de 5 m → **alineación perfecta sin ajuste**.
4. **Costo de cambiar**: regenerar 36 tiles + toda la red vial. Beneficio: cero funcional.

### 2.3 Signo de Z: norte-positivo vs sur-positivo

| | Fórmula |
| --- | --- |
| `GEO_PLAN §5.1` | `z = −(N − 4691751)` → **Z crece al SUR** («Babylon: +z hacia el sur») |
| Construido (T1) | `z = N − 4689000` → **Z crece al NORTE** |

**Resolución: se mantiene Z norte-positivo.** Motivos:

1. **Es consistente con el esquema del motor de referencia**, que es la propiedad que el packet exigía
   preservar. Los tiles construidos son copia 1:1 del ráster **invirtiendo filas**, justamente porque
   las filas del ráster crecen al sur y las del tile crecen al norte.
2. **El `-Z` de W6 es una preferencia de cámara, no una corrección de datos.** En Babylon (sistema
   izquierdo) el vector «adelante» por defecto apunta a `+Z`. Que el norte sea `+Z` o `−Z` es una
   decisión de diseño; ambas funcionan. Las 4 capturas de T1 renderizan correctamente.
3. **Invertirlo invalidaría la verificación existente** sin ganar nada.

---

## 3. Lo que SÍ se adopta del GEO_PLAN (aportes verificados)

| Aporte | Por qué vale |
| --- | --- |
| **`EPSG:32649` es geográficamente absurdo para Burgos** | Medido: E **negativo** (−4 711 544) y a **114,3°** del meridiano central. Documenta por qué jamás se usa la CRS heredada de Shenzhen. Corrobora `scripts/landmark_tasks.py:89` del repo de referencia. |
| **El presupuesto de triángulos del repo de referencia NO sirve** | `src/city-ground-relief.ts:74` valida `triangles > 200 000` y `tiles.length > 100` **como error**, y `src/city-mountains.ts:20` `triangles < 260 000`. Con 36 tiles y 2,88 M triángulos **fallaríamos ambos validadores**. Hace falta presupuesto y validador propios. |
| **Granularidad de streaming: tiles de 512 m > 1024 m** | Con el mismo radio de vista, tiles más chicos cargan **menos** triángulos (204 800 vs 294 912 a 8 m, r = 1000 m) porque el culling es más fino. Converge con la propuesta independiente de T1 (subdividir en sub-mallas de 500 m). |
| **Regla «interpolar NO crea resolución»** (`§7`) | Con evidencia medida. Regla para el equipo: etiquetar todo remuestreo como **«remuestreo de MDT02»**, nunca «resolución 4 m / 8 m». |
| **`highway=proposed` (A-12) = 15,730 km dentro del bbox** | Severidad alta. T2 ya lo excluye, pero queda como riesgo del grafo jugable. |
| **Sólo 20,8 % de ways con `surface` y 3,5 % con `access`** | Severidad alta: **no hay datos para la física**. Hay que **inferir** desde DEM + `tracktype` y **declararlo como inferencia**. Refuerza la exigencia ya puesta a T2. |
| **64 de 191 `track` sin `tracktype` (18,4 km)** | Se infiere tracción y se etiqueta como inferencia. |
| **OSM sólo etiqueta 1,06 % del bbox como bosque** | No es cobertura real. Para la máscara de vegetación: **CORINE / ESA WorldCover**, no OSM. |
| **Flujo CNIG con `muestraLic=NO` puede cambiar sin aviso** | Mitigado por el snapshot verificado por SHA-256. Justifica conservar el ráster en disco. |
| **Geoide de las alturas MDT02 = `UNKNOWN`** | La ficha dice «ortométricas» sin nombrar geoide. **No aplica**: el juego no mezcla fuentes verticales. |
| **Disciplina de descargas** | La mayor fue la hoja MDT02 con **107,8 MB**, reportada. Límite declarado: >200 MB se reporta. |
| **PBF de CyL (169 MB) NO descargado** | Overpass cubrió el bbox con 466 KB. Decisión correcta. |

---

## 4. Acciones que se derivan

1. **Validador de presupuesto propio** — no reutilizar `city-ground-relief.ts:74` ni `city-mountains.ts:20`.
   `public/terrain/budget.json` ya existe; falta el validador que lo haga cumplir.
2. **Sub-mallas de 500 m** para granularidad de culling cuando se agregue LOD (convergencia T1 + W6).
   **Diferido**: hoy el peor caso son 320 k triángulos con 4 draw calls, que no aprieta. Se diseña
   junto con vegetación y pistas, cuando el presupuesto tenga todos sus consumidores.
3. **Máscara de vegetación desde CORINE / ESA WorldCover**, no desde OSM.
4. **Etiquetar como inferencia** todo ancho, penalización de velocidad y tracción que derive de
   `tracktype` o del DEM.
5. **Conservar los rásters en disco**, con su SHA-256 versionado.

---

## 5. Confianza

| Afirmación | Confianza |
| --- | --- |
| La convención construida es correcta y consistente | **Alta** — 36/36 tiles copia 1:1 del ráster; crosscheck diff 0 leyendo el ráster |
| 5 m es suficiente para el MVP | **Alta** — RMSE 0,835 m contra 2 m, y `GEO_PLAN §6.5` rechaza 2 m por límite de `u16` |
| Las diferencias con `GEO_PLAN` son de convención, no de corrección | **Alta** — ninguna de las tres cambia un valor del terreno, sólo su etiqueta |
| Haber despachado T1/T2 antes del plan fue un error de proceso | **Alta** — costo cero en este caso, por suerte |
