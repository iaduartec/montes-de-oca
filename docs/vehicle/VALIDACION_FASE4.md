# Validación independiente FASE 4 — vehículo

Escrito por el **orquestador**, no por el worker. Registra qué se comprobó por
cuenta propia, **qué comprobación mía estuvo mal**, y qué queda abierto. El
informe del worker es `VEHICLE_FASE4.md`; esto es la auditoría de ese informe.

---

## 1. Lo que se reprodujo (no se creyó)

### 1.1 Se volvió a correr todo desde cero

| Comprobación | Comando | Resultado |
| --- | --- | --- |
| Tipos | `npm run typecheck` | exit 0 |
| Build | `npm run build` | exit 0 (2.52 s) |
| Aserción del datum | `node scripts/vehicle/assert_heightfield_datum.mjs` | exit 0, 5/5 pass contra `crosscheck.json` |
| Mediciones de física | `node scripts/vehicle/measure_physics.mjs` | exit 0 |
| App real (build fresco + Chrome + CDP) | `scripts/vehicle/capture_vehicle.mjs` | exit 0 |

**Determinismo de las mediciones**: dos corridas consecutivas de `measure_physics.mjs`
comparadas clave por clave → **331 claves, 0 distintas**. Los números de física no
son el resultado de una corrida afortunada.

### 1.2 La captura publicada se reproduce exacta

Rebuild + re-captura, comparado contra `output/vehicle_captures.json` publicado:

| Métrica | Publicado | Recién medido | Dif |
| --- | --- | --- | --- |
| `datum_audit.ok` / muestras / diff | true / 37 / 0 | true / 37 / 0 | 0 |
| residual spawn | 0.01471 | 0.01471 | 0.00000 |
| residual fuerte_40 | 0.15988 | 0.15988 | 0.00000 |
| residual moderada_22 | 0.06362 | 0.06362 | 0.00000 |
| residual oeste_32 | 0.12545 | 0.12545 | 0.00000 |
| residual sur_40 | 0.17241 | 0.17241 | 0.00000 |
| residual este_40 | 0.21871 | 0.21871 | 0.00000 |
| draw calls / triángulos / vértices | 13 / 240360 / 1454892 | 13 / 240360 / 1454892 | 0 |
| FPS | 9.00 | 9.34 | ruido (no representativo) |

`intento_subida_40` idéntico: `slipping=true`, `μN=10785 N`, `gravedad=−11404 N`,
`v=−0.316 m/s`. **El artefacto publicado no miente y no está stale.**

### 1.3 La física es coherente con la teoría, no solo con el código

El worker no lo dijo así, pero sus números son verificables analíticamente:

| Cantidad | Teoría | Medido |
| --- | --- | --- |
| Pendiente máxima escalable | `atan(μ) = atan(0.8) = 38.66°` | 38.5° (barrido de 0.5°) |
| Derrape lateral en llano | `μ·g = 7.848 m/s²` | 7.85 |
| Vuelco lateral en llano | `g·(vía/2)/h_cg = 9.81·0.81/0.78 = 10.19` | 10.19 |
| Vuelco en ladera lateral | `atan((vía/2)/h_cg) = 46.08°` | 48° |
| Resbalar hacia atrás a 40° | `μN = 10821 < mg·sinθ = 11350` | `10785 < 11404` |

Que cinco cantidades independientes caigan donde la teoría dice **no es
coincidencia**: el modelo de fuerzas está bien construido.

---

## 2. Una comprobación MÍA que estuvo mal (y por qué importa)

Mientras auditaba el residual de contacto construí un modelo del terreno
interpolando **bilinealmente** los tiles y concluí que:

- el terreno tenía una torsión de **0.0224 m** en el spawn,
- los `contacts` publicados tenían torsión **0**,
- por lo tanto los `contacts` no eran muestras del terreno y el residual no medía lo que decía.

**Eso era falso, y las tres fuentes que consulté para confirmarlo lo desmintieron:**

| Fuente | Valor en RL del spawn | Torsión |
| --- | --- | --- |
| Mi ensamblado bilineal | 944.5101 | 0.02236 |
| Tile crudo, interp. bilineal | 944.5101 | 0.02236 |
| GeoTIFF IGN `mdt05_..._5m.tif` | 944.5101 | 0.02236 |
| **`heightAt` real de la app** | **944.4285** | **0.00000** |
| **Malla triangular SO→NE (mía)** | **944.4285** | **0.00000** |

El `heightfield` del proyecto **interpola por triángulos sobre la diagonal SO→NE**,
no bilinealmente. Comprobación analítica de los 4 puntos del spawn:

```
FL: 945 − 0.29546 = 944.70454      FR: 945 − 0.61940 = 944.38060
RR: 944 + (0.724 − 0.61940) = 944.10460
```

Y validado contra la app en **4.000 puntos aleatorios del mapa**: diferencia máxima
**2.3e-13 m** (ruido de coma flotante).

**Por qué importa**: la malla renderizada ES triangular. El `heightAt` que usa el
vehículo para apoyarse coincide **exactamente** con la geometría que se ve en
pantalla. Un `heightAt` bilineal sería el bug: pondría las ruedas fuera de la
superficie dibujada. La trampa era mía, y queda anotada para que nadie más la
repita.

Consecuencia: el residual de contacto del worker **sí mide lo que dice medir**, y su
explicación (cuerpo rígido, sin suspensión por rueda, DEM de 5 m) es correcta.

---

## 3. Lo que SÍ queda abierto: la tolerancia de 0,5 m es alcanzable

El worker declara tolerancia de 0,5 m y midió **0,219 m de máximo en 6 puntos**.
Esos 6 puntos son su muestra, no el mapa. Escaneando el mapa entero con la malla
triangular **validada** (357.604 puntos × 12 orientaciones):

```
max   0.7215 m        (x=2840, z=290 — a 3.664 m del spawn, en el alto del SO)
p99   0.1409 m
p95   0.0996 m
p50   0.0571 m

15 puntos (0,004%) por ENCIMA del umbral 'airborne' de 0,5 m
539 puntos (0,151%) por encima de los 0,219 m reportados
```

**Traducción**: en ~15 lugares del mapa el apoyo de 4 puntos está tan lejos de ser
plano que `state.airborne = lastResidual > 0.5` se dispara **con el coche apoyado**.
El instrumento avisa "SIN CONTACTO" donde sí hay contacto. No es catastrófico
(0,004% del mapa, y `airborne` hoy solo pinta un aviso en el HUD: no hay dinámica
vertical), pero es un número que el próximo que toque esto tiene que conocer.

Matices, para no inflar el hallazgo:

- Mi barrido mide el residual del **plano de 4 puntos en offsets sin rotar**; la app
  lo mide sobre las posiciones **rotadas** del buje. Mismo orden de magnitud, no
  bit a bit. Establece que el umbral **es alcanzable**, no que el valor exacto de la
  app en esos puntos sea ese.
- Muestreo cada 10 m y 12 orientaciones: es una muestra, no un censo. El conteo real
  puede variar algo.
- El peor punto está en el alto del suroeste, que es **hacia donde el juego quiere
  mandar al jugador**. No es una esquina irrelevante.

---

## 4. Precisión injustificada detectada

En §4.1 el informe afirma: *"la pendiente máxima que sube desde parado en el terreno
es ≈33°"*. Los datos crudos **no sostienen esa precisión**: 32,6° sube y 40,3° no,
así que el número real está **entre 32,6° y 40,3°**, con un hueco de 8° sin medir.
Decir "≈33°" sugiere una resolución que el barrido no tiene. El informe muestra los
números crudos, así que el lector puede verlo — pero la frase de resumen y la lista
de confianza (§8) lo presentan como medido. Es el único número del informe que
afirmaría por encima de su evidencia.

---

## 5. Detalle menor: dos pendientes distintas en el HUD

En el spawn el HUD muestra `pendiente +3.1° (avance)` y `actitud cabeceo −5.6°`.
No es un bug: la primera viene de la **normal** del terreno y la segunda del **ajuste
de 4 puntos**, y el terreno no es plano en la huella (el eje delantero cae en una
celda plana y el trasero en una con pendiente). Pero un lector que compare las dos
líneas va a pensar que una está mal. Conviene un comentario en el HUD.

---

## 6. Veredicto

| Aspecto | Veredicto |
| --- | --- |
| Física de pendiente (gravedad, tracción, arrastres, punto muerto, freno) | **PASA** — verificada contra teoría y reproducible |
| Actitud de 4 puntos | **PASA** — coincide con la malla renderizada |
| Footgun de los dos `heightAt` | **PASA** — aserción real, corre en el arranque de la app |
| No atraviesa ni flota | **PASA CON RESERVA** — residual ≤ 0,219 m en la muestra; alcanza 0,72 m en el mapa y cruza el umbral `airborne` en ~15 puntos |
| Rendimiento | draw calls y triángulos **válidos**; FPS **no válido** (SwiftShader) y así está declarado |
| Alcance respetado | **PASA** — solo `src/**` + `scripts/vehicle/**`; cero solapamiento con `t2-rutas` |
| Honestidad del informe | **ALTA** — declara 10 cosas no hechas, el FPS inválido y sus desvíos grandes |
| Precisión de "≈33°" | **CORREGIR** — es un intervalo 32,6–40,3° |

**No es un rewrite ni un parche cosmético: es un modelo de fuerzas propio que hace
lo que la tarea pedía.** Lo que falta (suspensión por rueda, contacto por rueda en
vez de plano rígido) es exactamente lo que bajaría el residual y eliminaría el
hallazgo del §3 — y es fase siguiente, no un tuneo.
