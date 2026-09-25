# Auditoría del orquestador — FASE 3b (drapeado de la red vial)

Validación **independiente** del trabajo de `d1-drapeado`
(`opencode-go/deepseek-v4.1-flash`). No repite su informe: verifica qué de lo que
declaró se sostiene, qué no, y qué consecuencias tiene.

- Implementación auditada: commit `bff7ea6` (era `7a6a380` antes del rewrite de
  historia; ver `docs/git/REWRITE_HISTORIA.md`)
- Informe del worker: `docs/roads/DRAPING_FASE3B.md`
- Mediciones crudas: `output/roads_draping.json`
- Reproducción por otro modelo: `docs/roads/VERIFICACION_FASE3B.md`

---

## 1. La trampa del §4: superada, y con evidencia dura

El riesgo real de esta fase era que alguien "drapeara" usando una interpolación
propia (bilineal) en vez de la triangular SO→NE que se dibuja. Eso da 0,2 m de
discrepancia **falsa** y, peor, las ruedas quedan fuera de la superficie.

No hace falta creerle al worker. Se verifica en el código:

| Comprobación | Resultado |
| --- | --- |
| Llamadas a `terrain.heightAt` en `src/road-draping.ts` | **10** |
| Expresiones de mezcla de esquinas (`sw +`, `heights[`, `(1−fx)*…`) | **0** |
| Importa `./heightfield` o `./terrain`? | **No** — recibe el terreno como parámetro estructural |

`road-draping.ts` declara la interfaz `heightAt(x, z)` y la usa. **No puede
reimplementar una interpolación que no importa ni cuyas esquinas conoce.** Es la
forma más fuerte de probar esto: no por confianza, por imposibilidad de acceso.

## 2. Verificación mecánica

| Comprobación | Resultado |
| --- | --- |
| `npm test` | **verde** — 33/33 terreno + 27/27 vías + aserción del datum |
| `npm run build` | **exit 0**, 2,43 s |
| Alcance respetado | solo `src/**`, `scripts/roads/draping/**`, `docs/roads/DRAPING_FASE3B.md`, `output/` |

## 3. Revisión visual propia (no delegable)

Mirada sobre las capturas, no sobre los números:

- `roads_road.png` — el 4x4 está **encima del asfalto**, con `ruedas residual
  máx 0,000 m` y `pendiente lateral +1,8°`. Pasa.
- `roads_pendiente_transversal.png` — la app eligió una TRACK de **40,1° de
  pendiente transversal** (p95 de la red = 17,7°) y el 4x4 aparece **alabeado
  −40,4°**, casi volcado, encima de la cinta marrón. Pasa: es el micro-relieve
  real y la decisión §6.1 de seguir el terreno, no un bug.
- `roads_vista_pueblo.png` — **falla**, ver §4.

## 4. DEFECTO 1 — las vías flotan contra el cielo (severidad: alta)

En la vista amplia el HUD dice `draw calls 7` y `mallas 7`: **4 tiles de terreno
+ las 3 mallas viales**. Las 3 mallas contienen la red **entera de los 6×6 km** y
no tienen culling ni LOD, así que siguen mucho más allá de donde llega el terreno
dibujado. En la imagen se ven **finas líneas contra el azul**, arriba y a la
izquierda, sin nada debajo.

El worker lo declaró (su gotcha 6) como consecuencia del mandato sin
LOD/streaming. Confirmarlo cambia la severidad: **no es un detalle de encuadre,
es la red extendiéndose fuera del mundo dibujado.** Cualquier vista con horizonte
—o sea, cualquier captura que un jugador haga— lo muestra.

Fix real (próxima fase del tramo vial): **trocear las 3 mallas por celda
espacial** (una por celda de 1000 m y clase, o una rejilla de chunks) para que el
frustum culling de Babylon tenga qué descartar. Una malla única que abarca todo
el mapa es, por definición, incullingible.

## 5. DEFECTO 2 — `frameTimeMs` no es una medición de rendimiento

`output/roads_draping.json` publica `fps 9,09 / frameTimeMs 116,9` y
`fps 8,74 / frameTimeMs 34,4`. La segunda pareja es inconsistente: 34,4 ms son
~29 fps.

Causa verificada en `src/diagnostics.ts:38-41`: `frameTimeMs` es
`engine.getDeltaTime()` — **la última muestra** — mientras `fps` es
`engine.getFps()`, un promedio. Comparar un promedio contra una muestra suelta no
dice nada.

**No invalida `drawCalls` ni `triangles`**: esos se cuentan del grafo de escena en
un instante concreto y son deterministas (y la reproducción independiente los
confirma). Invalida la lectura de `frameTimeMs` como rendimiento. El FPS sigue sin
ser medible acá: SwiftShader es CPU y no representa una GPU.

## 6. HALLAZGO NUEVO — el coche apoya en el terreno, el asfalto está 0,12 m arriba

No lo reportó el worker. Verificado leyendo el código:

`src/vehicle/physics.ts:264` y `src/vehicle/attitude.ts:74-77` reciben una
`surface` con `heightAt`/`normalAt` — **el terreno** — y muestrean las 4 ruedas
contra ella. La capa vial dibuja ROAD a `terreno + 0,12 m` (TRACK +0,10, PATH
+0,08).

Consecuencia: **el plano de contacto del 4x4 está por debajo de la calzada
dibujada.** En el centro de la vía son ~0,12 m (las ruedas entran en el asfalto);
en los bordes, donde el aplanado ROAD se despega (residual máx **1,32 m**), la
discrepancia es mucho mayor.

No es un bug de la FASE 3b: es la frontera entre dos capas construidas en fases
distintas, y cada una hace lo que su mandato pedía. **La FASE 3b no podía
arreglarlo porque el vehículo estaba fuera de su alcance de escritura.**

Fix (próxima fase): la capa vial ya calcula la cota por clase; exponer un
`roadSurfaceAt(x, z)` que la física consulte primero y caiga al terreno si no hay
vía. Eso resuelve de una sola vez el hundimiento de 0,12 m y el despegue de 1,32 m
en los bordes.

## 7. Reproducción independiente: el núcleo reproduce IDÉNTICO

Otro modelo (`mimo-v2.6-flash-free`) re-corrió la captura sobre un build limpio
escribiendo en `output/draping_verify/reproduccion/`, sin tocar la evidencia
publicada: `output/roads_draping.json` sigue con sha256 `238b6e4d…` y los PNG son
byte a byte los mismos que preservé antes.

Comparados los dos JSON campo por campo:

| | |
| --- | --- |
| Campos idénticos | **214** |
| Campos que difieren | **35 — TODOS dentro de `residual_verificacion_independiente`** |

Idénticos **hasta el último decimal**: draw calls 13/13 y 16/16, triángulos
240360/240360 y 317666/317666, vértices 1524508/1524508, y **todos** los
residuales de `audit_app` — `ROAD.pavement.max` `1.3235180664063364`,
`TRACK.pavement.p95` `4.272460918741672e-05`, `ROAD.skirt.p95`
`4.165649409770822e-05`. Eso es una reproducción real, no una coincidencia de
magnitudes.

### Por qué difieren esos 35 — verificado en el código, no supuesto

`residual_verificacion_independiente` no sale de `audit()` (que recorre los
9066 + 39450 + 11896 vértices y es determinista) sino de
`window.__game.roads.probe(n)`. Y `src/road-draping.ts:587-590` hace:

```js
const cls = CLASSES[Math.floor(Math.random() * CLASSES.length)]!;
const vertex = Math.floor(Math.random() * (positions.length / 3));
```

`probe()` **elige clase y vértice al azar, sin semilla**. Por eso los `count` cambian
en cada corrida (1051/966, 1997/1987, 1015/1032) y los puentes salen en número
distinto (ROAD 7/4, TRACK 1/3, PATH 2/5): son raros y una muestra de ~1000 vértices
los toca a veces sí y a veces no.

Lo que importa de esto: ese bloque publica **percentiles calculados sobre muestras
diminutas** — `TRACK/puente.p50` = `1.5e-06` sale de **n = 1**. Un p50 de una sola
muestra es un dato, no un percentil, y se lee como si fuera robusto. No invalida
nada (sus valores concuerdan con el audit completo: TRACK/calzada p95 `4.1e-5`
contra `4.27e-5`), pero **mezcla mediciones deterministas con no deterministas en el
mismo archivo sin etiquetarlas**, y eso rompe el diff ingenuo del artefacto — el
que acabo de hacer yo.

Fix: sembrar el PRNG de `probe()`, o etiquetar el bloque como muestra aleatoria con
su `n`. Y no hornear el `n` en la prosa: `clamp_nota` dice *"7 de 6000"* o *"6 de
6000"* según la corrida.

### Y el log miente sobre dónde escribe

`capture_draping.mjs:334` imprime la ruta con `output/${file}` **hardcodeada**,
ignorando `--out-dir`. La captura escribió en
`output/draping_verify/reproduccion/` y el log dice `output/`. El archivo está bien;
el log no. En un artefacto de evidencia, un log que nombra el lugar equivocado es
una falla de trazabilidad, no un detalle cosmético.

## 8. Lo que NO está verificado acá

- **FPS en GPU real.** El 7–9 fps es SwiftShader (CPU) y no es señal de
  rendimiento del juego. Requiere el hardware del usuario.
- **Aspecto de las vías a distancia de conducción real** (cámara a 2,4 m, no en
  picado). Las capturas amplias están encuadradas en picado; el defecto 1 se ve
  igual, pero no hay una captura a altura de jugador sobre una ROAD lejana.
- **Topología de cruces.** El worker declara que dos vías se cruzan como cintas
  apiladas por jerarquía, sin empalme de calzada. No lo medí.

## 9. Veredicto

**La fase pasa**, y ahora con dos vías independientes de confirmación: la
auditoría de código (§1) y la reproducción por otro modelo (§7), que dio el núcleo
determinista **idéntico hasta el último decimal**. Los residuales de TRACK/PATH en
el piso de `Float32` prueban que la cinta coincide con la superficie dibujada.

**Y deja tres cosas que no son cosméticas:**

| # | Qué | Fix |
| --- | --- | --- |
| §4 | La capa vial no tiene culling: la red de 6×6 km se dibuja entera y flota contra el cielo | Trocear las 3 mallas por celda espacial |
| §6 | El coche apoya en el terreno y el asfalto se dibuja 0,12 m arriba (hasta 1,32 m en los bordes) | Exponer `roadSurfaceAt(x,z)` y que la física lo consulte primero |
| §7 | El artefacto mezcla mediciones deterministas y aleatorias sin etiquetar; publica percentiles de n = 1 | Sembrar el PRNG de `probe()`, o etiquetar con su `n` |

Las dos primeras son de la próxima fase del tramo vial. La tercera es de la próxima
corrida de evidencia, y cuesta diez minutos.
