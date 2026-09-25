# VERIFICACIÓN FASE 3b — reproducción independiente del drapeado

**Verificador**: `opencode/mimo-v2.6-flash-free` (rol VERIFICADOR, sin implementar)
**Fecha**: 2026-09-25
**Línea de base**: `output/draping_verify/publicado_d1.json`
sha256 = `238b6e4d6cb5db6962752051a00d713f6c68646aa38919084410bf6d6cc8e0ea`
(verificado **antes y después** de la corrida: idéntico, no fue tocado)

---

## 1. Veredicto

**Las 15 mediciones pedidas se reproducen con delta = 0 (exactas), y lo mismo vale
para todo el bloque `audit_app` y todo el bloque `stats`.** Corrí el capture
completo **dos veces** de cero (build limpio → server → Chrome headless → JSON) y
los únicos campos que no reproducen son, en este orden:

| Bloque | Hojas que no coinciden | Causa |
| --- | --- | --- |
| `fecha` | 1 | hora de la corrida (no comparable) |
| `perf_*.fps` / `perf_*.frameTimeMs` | 4 | muestreo no determinista en SwiftShader |
| `residual_verificacion_independiente.*` | 34–35 | **muestra aleatoria** (`Math.random()` en el código, ver §6.2) |

Es decir: de **234 hojas numéricas**, la corrida 1 reproduce **196 exactas** y la
corrida 2 **197 exactas**; las 37–38 que difieren están **enteramente** dentro de
`perf_*` + `residual_verificacion_independiente`. Fuera de esas dos secciones y de
`fecha`, **no hay una sola diferencia**.

---

## 2. Método (todo repetible)

```bash
npm run build                                   # exit 0 (tsc --noEmit + vite build)
npm run preview -- --port 4173 &                # curl → HTTP 200 confirmado
node scripts/roads/draping/capture_draping.mjs \
  --out-dir output/draping_verify/reproduccion  # exit 0, sin excepciones
node scripts/roads/draping/capture_draping.mjs \
  --out-dir output/draping_verify/reproduccion2 # 2ª corrida, exit 0
node output/draping_verify/compare_draping.mjs  # comparador propio, recursivo
kill <preview>                                  # server abajo, HTTP 000 confirmado
```

- Comparador propio: `output/draping_verify/compare_draping.mjs` (recorre los dos
  JSON hoja por hoja, imprime delta y detecta claves presentes en uno y no en el
  otro). Salidas:
  - `output/draping_verify/comparacion.txt` — publicado vs corrida 1
  - `output/draping_verify/comparacion_publicado_vs_corrida2.txt`
  - `output/draping_verify/comparacion_corrida1_vs_corrida2.txt`
- Claves presentes en un archivo y no en el otro: **ninguna** (mismo esquema).
- Proveniencia del build: el último cambio de `src/*` fue 01:57:09 y `dist/` se
  escribió 02:04:02; el commit de d1 (`bff7ea6`) es 02:04:19 → mi build corresponde
  exactamente al contenido commiteado.
  > **Nota del orquestador.** Este informe citaba el hash `7a6a380`. Después de
  > escribirlo se reescribió la historia de git (para sacar dos blobs grandes), así
  > que **ese commit es ahora `bff7ea6`**: el hash cambió, y también el árbol, por
  > una única entrada — el `.tif` del MDT que estaba trackeado y dejó de estarlo
  > (era el objetivo del rewrite). Ni una línea de código, documentación o evidencia
  > cambió. La comprobación de que nada más se movió es que `npm test` pasa sobre
  > el árbol actual y que `output/roads_draping.json` y los PNG publicados siguen
  > con el mismo sha256 que tenían antes del rewrite.
  >
  > (No pude comparar los árboles directamente: el bundle de seguridad se creó 4
  > commits antes y no contiene `7a6a380`. Es un agujero que tenía la guarda de
  > backup, ya corregido en `scripts/git/limpiar_blobs_grandes.sh`.)
- No modifiqué `src/**`, `public/**`, `data/**`, `scripts/roads/**` ni
  `docs/roads/DRAPING_FASE3B.md`. No agregué dependencias. No commiteé.

---

## 3. Tabla principal — los 15 campos pedidos

Corrida 1 (`output/draping_verify/reproduccion/roads_draping.json`). La corrida 2
da exactamente los mismos valores.

| campo | publicado | reproducido | delta |
| --- | --- | --- | --- |
| `perf_sin_vias.drawCalls` | 13 | 13 | **0** |
| `perf_con_vias.drawCalls` | 16 | 16 | **0** |
| `perf_sin_vias.triangles` | 240360 | 240360 | **0** |
| `perf_con_vias.triangles` | 317666 | 317666 | **0** |
| `perf_con_vias.vertices` | 1524508 | 1524508 | **0** |
| `stats.meshes` | 3 | 3 | **0** |
| `stats.vertices` | 69616 | 69616 | **0** |
| `stats.triangles` | 77306 | 77306 | **0** |
| `stats.roads` | 438 | 438 | **0** |
| `stats.bridges` | 20 | 20 | **0** |
| `audit_app.classes.TRACK.pavement.p95` | 4.272460918741672e-05 | 4.272460918741672e-05 | **0** |
| `audit_app.classes.PATH.pavement.p95` | 4.394531248408384e-05 | 4.394531248408384e-05 | **0** |
| `audit_app.classes.ROAD.skirt.p95` | 4.165649409770822e-05 | 4.165649409770822e-05 | **0** |
| `audit_app.classes.ROAD.pavement.p50` | 0.18359863281250455 | 0.18359863281250455 | **0** |
| `audit_app.classes.ROAD.pavement.max` | 1.3235180664063364 | 1.3235180664063364 | **0** |

**15/15 con delta exactamente 0.**

### 3.1 Preguntas del mandato

- **¿Coinciden exacto los draw calls y los triángulos?** **SÍ.** 13/16 draw calls
  y 240.360/317.666 triángulos, delta 0 en las dos corridas. También son exactos
  `costo_vias.*` completo (deltas 3 y 77306).
- **¿Los residuales de TRACK/PATH dan ~4e-5 m (piso de `Float32`)?** **SÍ.**
  `TRACK.pavement.p95` = 4.272461e-05 y `PATH.pavement.p95` = 4.394531e-05, con
  delta **0** contra lo publicado (mucho mejor que el criterio de 1e-6). El piso
  se sostiene: `ROAD.skirt.p95` = 4.165649e-05. Todos los valores viven en
  4,1–4,4e-05 m, que es el orden de 1–2 ULP de un `Float32` en cotas de 100–200 m.
- **¿Coincide el `stats` de la red?** **SÍ, entero**: 438 vías, 3 mallas, 69616
  vértices, 77306 triángulos, 20 puentes, y también `byClass` completo
  (ROAD 131/4560/18186/26490 · TRACK 213/19752/39504/39078 · PATH 94/5963/11926/11738)
  y `constants` completo — todo delta 0.

### 3.2 Coherencia interna verificada (no la pedí, pero cierra)

| Comprobación | Valor |
| --- | --- |
| `perf_con_vias.vertices − perf_sin_vias.vertices` | 1524508 − 1454892 = **69616** = `stats.vertices` ✅ |
| `perf_con_vias.triangles − perf_sin_vias.triangles` | 317666 − 240360 = **77306** = `stats.triangles` = `costo_vias.triangulos_delta` ✅ |
| `draw_calls_delta` vs `stats.meshes` | 3 = 3 ✅ |
| suma `byClass.*.vertices` | 18186 + 39504 + 11926 = **69616** ✅ |
| suma `byClass.*.triangles` | 26490 + 39078 + 11738 = **77306** ✅ |
| conteo de vértices por rol vs `audit` | ROAD 9066+9066+54 = 18186 · TRACK 39450+54 = 39504 · PATH 11896+30 = 11926 ✅ |

---

## 4. Lo que NO coincide, con números

### 4.1 `perf_*.fps` y `perf_*.frameTimeMs` (4 hojas)

| campo | publicado | corrida 1 | corrida 2 | delta (c1) |
| --- | --- | --- | --- | --- |
| `perf_sin_vias.fps` | 9.086778736933912 | 9.04977375565611 | 8.721701869472907 | −0.0370 |
| `perf_con_vias.fps` | 8.745845723281441 | 8.982035928143711 | 8.433249000841021 | +0.2362 |
| `perf_sin_vias.frameTimeMs` | 116.90000000037253 | 187.19999999925494 | 216.60000000149012 | +70.30 |
| `perf_con_vias.frameTimeMs` | 34.40000000037253 | 122.5 | 135.59999999962747 | +88.10 |

**Causa (verificada en el código, no supuesta):** `createDiagnostics` en
`src/diagnostics.ts:38-41` devuelve `frameTimeMs = engine.getDeltaTime()` (el delta
del **último frame**, una sola muestra) y `fps = engine.getFps()` (promediado de
Babylon). En Chrome headless con SwiftShader (CPU) eso es ruido de una muestra.
Los contadores (`drawCalls`, `triangles`, `vertices`, `activeMeshes`) sí son
exactos, igual que ya advertía el propio JSON con `perf_nota`.

### 4.2 `residual_verificacion_independiente.*` (34–35 hojas)

Ejemplos (publicado → corrida 1 → corrida 2):

| campo | publicado | corrida 1 | corrida 2 |
| --- | --- | --- | --- |
| `summary.TRACK/calzada.count` | 1997 | 1987 | 2023 |
| `summary.TRACK/calzada.p95` | 4.196167e-05 | 4.119873e-05 (Δ 7.6e-07) | 4.272461e-05 (Δ 7.6e-07) |
| `summary.PATH/calzada.count` | 1927 | 2003 | 1910 |
| `summary.PATH/calzada.p95` | 4.150391e-05 | 4.150391e-05 (Δ 1.1e-13) | 4.394531e-05 (Δ 2.4e-06) |
| `summary.ROAD/calzada.count` | 1051 | 966 | 1014 |
| `summary.ROAD/calzada.p50` | 0.17516296386713748 | 0.1989620971679642 (Δ +0.0238) | 0.17783081054687955 (Δ +0.0027) |
| `summary.ROAD/faldon.p95` | 4.241943e-05 | 4.531860e-05 (Δ 2.9e-06) | 4.455566e-05 (Δ 2.1e-06) |
| `vertices_fuera_de_ventana` | 7 | 6 | 3 |
| `summary.ROAD/puente.count` | 7 | 4 | 3 |

**Causa:** `probe()` en `src/road-draping.ts:584-600` hace **dos `Math.random()`
por sonda** (elegir clase + elegir vértice). La muestra es aleatoria e
irrepetible por diseño (d1 lo documenta como "muestra aleatoria"). La prueba
definitiva está en mis propias dos corridas: comparando **corrida 1 vs corrida 2**
( mismo build, mismo hardware, mismo código ), las únicas hojas que difieren son
`fecha`, `perf_*` y `residual_verificacion_independiente.*` — **cero** diferencias
en `audit_app`, `stats`, `captura_*`, `caso_dificil` ni `puntos_captura`.

**Contra el criterio de éxito (1e-6):**

- `audit_app.*` (la medición real sobre **todos** los vértices): **delta 0**, no
  hace falta 1e-6.
- En la muestra aleatoria: `TRACK/calzada.p95` Δ = 7.6e-07 ✅ (< 1e-6) y
  `PATH/calzada.p95` Δ = 1.1e-13 ✅ en la corrida 1; en la corrida 2
  `PATH/calzada.p95` Δ = 2.4e-06 ❌ y `ROAD/faldon.p95` Δ = 2.1e-06 ❌.
  **Explicación**: todos los valores caen en la misma banda 4,1–4,4e-05 m (el piso
  de `Float32`); la diferencia es de ±1 ULP de muestreo entre
  subconjuntos distintos de vértices, no una discrepancia de drapeo. El
  requisito "dentro de 1e-6" **no puede cumplirse jamás** sobre esta sección
  mientras sea aleatoria: ni el propio d1 podría repetir sus números.

---

## 5. Rarezas y observaciones (lo más valioso del informe)

### R1 — `perf_con_vias.frameTimeMs` publicado (34.4 ms) es internamente imposible

Dos problemas en el mismo número:

1. **Se contradice con su propio `fps`**: 1000 / 8.7458 = **114.34 ms**, pero
   publica 34.4 ms. Un frame de 34 ms con 317.666 triángulos en SwiftShader no
   convive con un promedio de 8.7 fps.
2. **Implica que "con vías" renderiza MÁS RÁPIDO que "sin vías"** (34.4 vs
   116.9 ms) con +3 draw calls y +77306 triángulos: físicamente imposible como
   efecto real.

No es un error de d1 puntual: **las tres corridas muestran la misma dirección**
(publicado 34.4/116.9 · mía1 122.5/187.2 · mía2 135.6/216.6), o sea que
`sin_vías > con_vías` aparece siempre. Hipótesis (no la probé): la primera
navegación (`/?drape=0`) es la carga en frío de la sesión (shaders, caché HTTP) y
la muestra de `getDeltaTime()` a los 2500 ms cae en un frame enturbiado, mientras
que la segunda navegación ya va con caché caliente.

**Recomendación**: no publicar `frameTimeMs` (es una sola muestra de
`engine.getDeltaTime()`), o promediarlo sobre N frames. `fps` es usable con la
advertencia ya escrita; `drawCalls`/`triangles`/`vertices` son sólidos.

### R2 — El JSON **nunca** va a ser byte-reproducible, y no solo por `fecha`

La sección `residual_verificacion_independiente` cambia en 34–35 hojas por
corrida, incluido el **texto libre** `clamp_nota`, que incrusta el contador
("7 de 6000" publicado, "6" y "3" en mis corridas). Cualquiera que intente
verificar este JSON contra el suyo va a "fallar" en esas 35 hojas y no va a saber
cuál es ruido y cuál es un problema real. **Fix de una línea**: RNG con semilla
fija en `probe()` (p. ej. mulberry32 con constante) y el archivo queda
reproducible al 100 % salvo `fecha`. No lo hago yo: `scripts/roads/**` es de solo
lectura para mí.

### R3 — Las filas de **puente** de la verificación independiente son estadísticamente vacías

`ROAD/puente n=7`, `TRACK/puente n=1`, `PATH/puente n=2` en lo publicado; en mi
corrida 1: 4 / 3 / 5; en mi corrida 2: 3 / 3 / 4. Con n = 1..7, `p50/p95/max` de
esa sección saltan como tarot: `ROAD/puente.p95` fue 1.489 (publicado) → 1.572
(mía1) → 0.980 (mía2), Δ de **0.51 m** contra lo publicado y **0.59 m** entre mis
dos corridas. No es un defecto de drapeo: es n chico sobre una distribución con
cola larga. Las filas de puente **con valor** son las de
`audit_app` (n = 54/54/30, todas exactas). Si el JSON publica ambas, conviene
marcar las de la muestra como "n < 30, informativo".

### R4 — El "tolerancia 1×10⁻³ m" NO aplica a ROAD/calzada ni a puentes (y d1 lo documenta, pero el checklist puede leerse mal)

Números exactos, reproducidos con delta 0:

| rol | p50 | p95 | máx | vs tolerancia 1e-3 |
| --- | --- | --- | --- | --- |
| ROAD/calzada | 0.18359863281250455 | 0.6748034667969023 | 1.3235180664063364 | **184×/675×/1324× por encima** |
| ROAD/puente | 0.2966145324706986 | 1.5719113159181006 | 1.708781127929683 | 297×/1572× por encima |

Es **por diseño**, no un bug: en `src/road-draping.ts:271` la calzada ROAD usa
`terrainY + roadFlattenLerp·(centerY − terrainY) + offset` con
`roadFlattenLerp = 0.6`, así que el residual contra `heightAt(x,z) + offset` es
literalmente `0.6·|centerY − terrainY|` — el aplanado parcial. El doc de d1 lo
explica bien (§4 "residual por diseño ≠ 0"). Mi observación es de **lectura**:
cualquiera que mire solo la línea "Tolerancia declarada: 1×10⁻³ m" y la tabla
`audit_app` puede concluir que 0,675 m es un fallo. Sugerencia: acotar la
tolerancia a "TRACK/PATH + faldón ROAD" **en la propia línea de tolerancia**.

### R5 — Solo ROAD tiene faldón; TRACK y PATH devuelven `skirt: null`

`useSkirt = isRoadClass && !road.bridge` (`src/road-draping.ts:226`). Reproducido
exacto (null en las 3 corridas). Coherente con el doc, pero si la especificación
de drapeado quería borde blend en todas las clases, **no está implementado**; el
JSON lo dice con `null` y no con un 0, así que un comparador tonto lo trataría
como "falta el dato".

### R6 — `ROAD.bridge.count` y `TRACK.bridge.count` son ambos 54 (coincidencia que investigué)

54 vértices = 27 estaciones por clase (layout de 2 vértices/estación en puente).
Las sumas cierran (54+54+30 = 138 vértices de puente; `stats.bridges = 20`
puentes ≈ 3,45 estaciones/puente). **No hay evidencia de doble conteo**, pero la
igualdad exacta 54 = 54 es coincidencia y la dejo anotada por si alguien la ve
antes que yo.

### R7 — Determinismo total del resto de la app

`audit_app` completo (incluidas las coordenadas `worst.x/y/z/terrainY` en
Float32), `stats`, `caso_dificil` (40.11638553842403° de transversal), 
`puntos_captura` y las **tres telemetrías** de captura (`captura_track`,
`captura_road`, `captura_caso_dificil`) salieron **idénticas byte a byte** en 3
corridas independientes. Eso es fuerte: la cadena parseo → subdivisión →
drapeado → auditoría → física es determinista al milésimo.

### R8 — Menores

- El `perf` de las vistas amplias (`draw=7 tris=397306`, idéntico en las dos
  vistas y en mis 2 corridas) **solo va a consola, no al JSON**: no es verificable
  contra lo publicado.
- Los PNG difieren en tamaño entre corridas (p. ej. `roads_track.png` 97137 vs
  97318 bytes) — rendering no determinista. **No los interpreté**, como se
  indicó.
- La telemetría de la captura TRACK deja el 4x4 a `y = 75.221` con terreno en
  `75.244` (`wheelResidualMaxM = 0.083`) y en el caso difícil `83.628` vs
  `83.909` (`0.136`): el vehículo "se hunde" 8–14 cm respecto del terreno. Es
  física de FASE 4, no drapeo, y se reproduce exacto; lo señalo por si a alguien
  le chirría el número.

---

## 6. Criterio de éxito

| Ítem | Resultado |
| --- | --- |
| `npm run build` exit 0 | ✅ |
| server arriba (HTTP 200 en 4173) | ✅ |
| capture corre sin excepción y escribe su JSON | ✅ ×2 (`reproduccion/` y `reproduccion2/`) |
| draw calls: coincidencia **EXACTA** | ✅ 13 y 16, delta 0 |
| triángulos: coincidencia **EXACTA** | ✅ 240360 y 317666, delta 0 |
| residuales dentro de 1e-6 o explicados | ✅ `audit_app` delta 0; la muestra aleatoria difiere hasta 2.9e-06 (p95) y 2.4e-02 (p50 ROAD) — **explicada en §4.2** por `Math.random()` |
| server abajo al terminar | ✅ HTTP 000, sin procesos `vite preview` |
| baseline `publicado_d1.json` intacta | ✅ sha256 idéntico antes/después |
| sin dependencias nuevas, sin commits, sin tocar `src/`, `scripts/roads/`, `data/`, `public/` | ✅ |

## 7. Artefactos

- `output/draping_verify/reproduccion/` — JSON + 5 PNG de mi corrida 1
- `output/draping_verify/reproduccion2/` — JSON + 5 PNG de mi corrida 2
- `output/draping_verify/compare_draping.mjs` — comparador recursivo
- `output/draping_verify/comparacion*.txt` — las 3 comparaciones impresas

**Conclusión**: los números de la FASE 3b están replicados. Lo único que un
tercero no puede reproducir es (a) la sección muestreada al azar y (b) los
timing de SwiftShader — y ambas cosas ya están explicadas por el código, no por
fe.
