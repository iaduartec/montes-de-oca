# TAREA d1-drapeado — FASE 3b: drapear la red vial real sobre el terreno

**Modelo**: `opencode-go/deepseek-v4.1-flash`
**Fase**: FASE 3b (render de vías)
**Proyecto**: `/home/kiri_/projects/montes-de-oca-offroad`
**Referencia (SOLO LECTURA, jamás escribir)**: `/home/kiri_/projects/montes-de-oca`

Eres el **único escritor** de `src/**`, `scripts/roads/draping/**` y
`docs/roads/DRAPING_FASE3B.md`. Nadie más está tocando esos directorios. A cambio:
**no toques nada fuera de ellos.**

---

## 1. Misión

El terreno real de Villafranca ya está (36 tiles a 5 m, verificado 1:1 contra el
GeoTIFF del IGN). El 4x4 ya está y **siente las pendientes** (FASE 4, validada).
La red vial real ya está extraída de OSM: **438 segmentos, 138,98 km**.

**Falta lo que los une: dibujar las vías sobre el terreno.** Hoy el mundo es un
campo pelado: hay caminos en los datos, pero no los ves ni los pisás. Tu misión es
**drapear la red** — cintas de calzada que siguen la superficie del terreno — para
que se pueda ver y conducir por un camino real.

No es decoración: es la primera vez que el jugador tiene un camino que seguir.

---

## 2. Leé primero, en este orden

1. **`docs/vehicle/VALIDACION_FASE4.md` §2 — LEELO ANTES QUE NADA.** Documenta una
   trampa que ya hizo perder una hora al orquestador. Está resumida en el §4 de acá
   y es la causa número uno de que tus mediciones den mal sin que te enteres.
2. `docs/roads/ROADS_FASE3.md` — qué hay en la red: clasificación, contabilidad,
   conectividad y qué NO se conservó.
3. `public/roads/roads.json` — tu entrada. Esquema exacto en el §5.
4. `src/terrain.ts` — `WorldTerrain`, `heightAt`, `normalAt`, `auditVerticalDatum`.
5. `src/heightfield.ts` — el interpolador real.
6. `src/main.ts` — dónde se cablea (es de la FASE 4, respetá su estructura).
7. En la referencia (solo leer): `src/city-road-surface.ts` y cómo
   `city-world.ts` une vías. **Ojo**: esa es una ciudad Shenzhen con calzada
   plana preparada; nuestro caso es terreno real sin aplanar. Mirala como patrón de
   código, no como diseño a copiar.

---

## 3. Convención FIJA — no la cambies, no la reinterpretes

| | |
| --- | --- |
| Mundo | 6000 × 6000 m |
| Ejes | **+X al ESTE · +Z al NORTE · +Y arriba** |
| Escala | `worldScale = 1` → 1 unidad = 1 metro |
| CRS | `EPSG:25830` |
| `verticalDatum` | **870** |
| Tiles | 36 de 1000 m, 201×201 nodos, `dx = dz = 5` |
| `viewRadius` | 900 (`public/terrain/config.json`) |
| Spawn | `worldX = 3097.258`, `worldZ = 3945.020` → Y de mundo **74.5484** |

Los `points` de `roads.json` ya están en coordenadas de mundo `[worldX, worldZ]`.
**No hay que reproyectar nada.** Si te encontrás queriendo proyectar, paramé y releé.

---

## 4. ⚠️ LA TRAMPA: `heightAt` interpola por TRIÁNGULOS, no bilinealmente

`createHeightfield(grid, scale).heightAt` interpola **sobre triángulos con diagonal
SO→NE**. Dentro de cada triángulo la superficie es **plana**. Esto es **correcto**:
la malla renderizada ES triangular, así que el `heightAt` coincide exactamente con
la geometría que se ve. Un `heightAt` bilineal sería el bug: pondría las cosas
fuera de la superficie dibujada.

Fórmula exacta, verificada analíticamente y contra la app en 4.000 puntos
(diferencia máxima 2.3e-13 m):

```
fx = (x - x0) / dx   (parte fraccionaria dentro de la celda)
fz = (z - z0) / dz
sw, se, nw, ne = alturas de las 4 esquinas de la celda

si fz <= fx :  h = sw + (se - sw)*fx + (ne - se)*fz     # triángulo SO-SE-NE
si fz >  fx :  h = sw + (ne - nw)*fx + (nw - sw)*fz     # triángulo SO-NO-NE
```

**Regla dura**: para altura del terreno usá **`terrain.heightAt(x, z)`** y para
normal **`terrain.normalAt(x, z)`**. **NO reimplementes la interpolación.** Y si
escribís un verificador independiente que lea los tiles por su cuenta, **tenés que
usar la fórmula triangular de arriba**, o tus números van a discrepar de la app
hasta ~0,2 m y vas a "descubrir" un bug que no existe.

Ese error es exactamente el que cometió el orquestador. No lo repitas.

---

## 5. Tu entrada: `public/roads/roads.json`

```
meta          { generated_at_utc, script, coordinate_system, world_scale, ... }
roads[]       438 elementos
```

Cada elemento:

| Campo | Tipo | Para qué |
| --- | --- | --- |
| `id` / `osmId` | str / int | identidad |
| `class` | `"ROAD"` \| `"TRACK"` \| `"PATH"` | **decide el tratamiento** |
| `kind` | str | tag `highway=` original (`track`, `residential`, …) |
| `width` | number | **ancho en metros, ya resuelto** (ver abajo) |
| `widthSource` | str | de dónde salió el ancho (`diseno_*` u `osm_width`) |
| `tracktype` | str | `grade1`…`grade5` o `""` |
| `length` | number | metros |
| `points` | `[[x, z], …]` | **vértices en coordenadas de mundo**, ≥2 |
| `bridge`, `tunnel` | bool | hay puentes: no los entierres |
| `surface`, `access`, `smoothness`, `ref`, `name`, `tags` | | informativos |

Distribución real: 213 TRACK, 131 ROAD, 94 PATH.
El `width` **ya está resuelto**: no lo recalcules ni lo pises. Si tu diseño de
geometría necesita un ancho distinto al del archivo, escribilo en el informe, no
lo cambies.

También tenés `public/roads/navigation.json` (3869 nodos / 4007 aristas, con
`edgeMeta`) para navegación. **Para el drapeado no lo necesitás**: drapeás
`roads.json` directo. Usalo sólo si querés validar continuidad en cruces.

---

## 6. Las 6 decisiones de diseño — YA ESTÁN CERRADAS, no las reabras

Se cerraron con medición sobre la red real (344 vías rodables, 112,1 km). El
detalle y las tablas están en memoria y resumidos acá. **Implementalas como están.**

### 6.1 La calzada SIGUE el terreno, vértice a vértice. NO se aplana.
Si aplanaras a una plataforma, se hundiría o levantaría **0,64 m en p95 y 1,63 m
máximo** (TRACK), y no hay presupuesto para hacer cut/fill real sobre 112 km.
Siguiendo el terreno el hundimiento es **cero por construcción**. Es además menos
código.

### 6.2 Excepción ROAD (asfalto): aplanado PARCIAL + faldones laterales.
La clase **ROAD** sí lleva un aplanado parcial — **`lerp ≈ 0,6`** entre la cota del
terreno y la cota de la línea central — **más faldones laterales** que la cosen al
terreno. Razón: el asfalto inclinado 16,9° en p95 se lee como error, no como
camino. Los faldones necesarios son chicos y por eso es viable: **p95 0,91 m,
máx 1,62 m** (ROAD). TRACK y PATH siguen el terreno sin aplanar.

### 6.3 Offset vertical de la cinta: 0,06 – 0,15 m.
Para evitar z-fighting. Declará el valor elegido y por qué.

### 6.4 Subdividir a 5 m a lo largo.
Coincide con la grilla del DEM. Más fino no aporta: el dato no tiene más
resolución. Subdividí **entre** los vértices OSM (que están mucho más separados).

### 6.5 NO suavizar longitudinalmente.
Suavizar con ventana de 15 m mejora el p95 sólo 13% (TRACK) / 29% (ROAD) / 6%
(PATH); con 30 m, 17/37/6%. La rugosidad es **micro-relieve real** del MDT05
bare-earth, no ruido de grilla. Drapear fiel es correcto y es menos código.

### 6.6 La pendiente transversal ya la siente la física.
p95 17,7° en TRACK, 8,83% de los puntos por encima de 15°. **Ya está cubierto** por
la FASE 4: el vehículo muestrea `terrain.normalAt`. Vos sólo tenés que **no
romperlo** y no estás obligado a hacer nada acá.

---

## 7. Alcance

### Hacé

1. **Generar la geometría de cinta drapeada** desde `roads.json` + `terrain`.
   Por cada vía: subdividir a 5 m, muestrear la cota del terreno en cada punto,
   construir el ancho perpendicular a la dirección, cerrar los triángulos.
2. **Tratar ROAD distinto de TRACK/PATH** según el §6.2, con faldones en ROAD.
3. **Puentes**: `bridge: true` no se drapea al terreno (se cruza un río/barranco).
   Decidí algo razonable y **declaralo**; si no lo hacés, decilo también.
4. **Cablear en `src/main.ts`**, respetando la estructura de la FASE 4 (modo
   vehículo, cámara, `window.__game`).
5. **Agrupar en pocas mallas.** 139 km a 5 m son ~28.000 tramos. Los triángulos no
   son el problema (el terreno ya tiene 240.360); **los draw calls sí**. Fusioná por
   clase en **≤ 3 mallas** (`mergeMeshes` o vertex data propia). Si terminás con
   cientos de draw calls, está mal.
6. **Medir y reportar** lo del §8, con números crudos.

### NO hagas

- **No toques**: `public/roads/**`, `public/terrain/**`, `data/**`,
  `scripts/roads/*.py`, `docs/geo/**`, `docs/audit/**`, ni el repo de referencia.
  `roads.json` es dato de entrada: **se lee, no se escribe.**
- **No agregues dependencias.** Cero. Si creés que necesitás una, **pará y
  escribilo en el informe.**
- **No cambies el esquema de los tiles** ni la interpolación de `heightfield.ts`.
- **No toques `src/vehicle/**`.** Si necesitás algo de ahí, escribilo en el informe.
- **No hagas streaming ni LOD.** Los 36 tiles se cargan al arrancar (heredado de
  FASE 2, fuera de alcance). Las vías se cargan enteras igual.
- **No hagas commits.** Yo valido y commiteo.

---

## 8. Validación obligatoria — medir, no afirmar

**Construir no es validar.** Un build exitoso no dice si la cinta está sobre el
terreno o atravesándolo. Tenés que **correr la aplicación** y medir.

Para capturas hay patrones ya resueltos en `scripts/terrain/capture_terrain.mjs` y
`scripts/vehicle/capture_vehicle.mjs`: Chrome headless + CDP con el WebSocket
nativo de Node, **cero dependencias nuevas**. Copiá el patrón.

### Mediciones que tenés que entregar

1. **La cinta está sobre el terreno, no dentro ni flotando.** Muestreá a lo largo de
   toda la red: para cada vértice de la cinta, `|y_cinta − (terrain.heightAt(x,z) + offset)|`.
   Reportá **p50, p95 y máximo**, y la tolerancia que declarás. En TRACK/PATH el
   residual tiene que ser ~0 por construcción (§6.1); si no lo es, hay un bug.
2. **Faldones de ROAD**: verificá que el borde libre del faldón **llega al
   terreno** (no deja hueco). Medilo, no lo mires.
3. **Triángulos y draw calls**: el número **antes y después** de agregar las vías,
   para saber cuánto costaron. El terreno solo daba 13 draw calls / 240.360
   triángulos. **Este es el primer test real del presupuesto de render.**
4. **FPS / tiempo de cuadro**: registralos, pero **Chrome headless sin GPU usa
   SwiftShader y NO es señal de rendimiento del juego**. Declaralo explícitamente,
   como hizo la FASE 4. **draw calls y triángulos sí son válidos.**
5. **El coche conduce por el camino**: teleportá el 4x4 sobre una TRACK y sobre una
   ROAD, y **capturá con el coche encima**. Que se vea la cinta bajo las ruedas.
6. **Capturas en `output/`**: al menos (a) una TRACK de tierra vista desde cerca con
   el coche, (b) una ROAD asfaltada, (c) una vista amplia donde se lea la red.
7. **Un caso difícil**: buscá y capturá un tramo con pendiente transversal fuerte
   (p95 TRACK son 17,7°) y mostralo. Si se ve mal, **mostralo igual y decilo**.

### Dónde mirar

El pueblo está al noreste, en el bajo (945 m). El terreno sube al **SUDOESTE**. El
spawn está en `x=3097, z=3945`. La vía más cercana al spawn es **Calle Mayor a
8,51 m**, clase ROAD. Hay 22,295 km de TRACK en el cuadrante noreste
(`x≥3000, z≥3000`) — buen lugar para la captura de tierra.

---

## 9. Entregables

| Archivo | Qué |
| --- | --- |
| `src/*.ts` | módulo(s) de geometría drapeada + cableado en `main.ts` |
| `scripts/roads/draping/*.mjs` | medición y captura por CDP |
| `docs/roads/DRAPING_FASE3B.md` | informe: qué hiciste, **qué NO**, y los números crudos |
| `output/*.png` | capturas |

## 10. Definición de hecho

- [ ] Las vías se ven sobre el terreno y **no lo atraviesan** (medido, con
      p50/p95/máx y tolerancia declarada).
- [ ] ROAD se distingue de TRACK/PATH (aplanado parcial + faldones).
- [ ] El 4x4 conduce por una TRACK y por una ROAD sin que la cinta desaparezca bajo
      las ruedas.
- [ ] Draw calls y triángulos reportados, antes y después.
- [ ] El informe dice explícitamente **qué NO quedó hecho** (puentes, cruces,
      LOD/streaming, lo que sea).
- [ ] Se respetó la trampa del §4: toda altura de terreno sale de
      `terrain.heightAt`.

## 11. Cómo correr

```bash
cd /home/kiri_/projects/montes-de-oca-offroad
npm test          # typecheck + aserción del datum + validador de vías
npm run build
npm run preview -- --port 4173   # luego el script de captura por CDP
```

## 12. Memoria

Si descubrís algo no obvio —un comportamiento raro del sampler, un límite de la
geometría, un parámetro que importa más de lo esperado— **guardalo en Engram con
`mem_save`**, proyecto `montes-de-oca`, antes de terminar. El detalle completo lo
tenés vos; yo después no lo puedo reconstruir.

Y **no adornes**: si un tramo se ve mal, mostralo con la captura y el número. Un
informe honesto con un defecto medido vale muchísimo más que uno optimista sin
números.
