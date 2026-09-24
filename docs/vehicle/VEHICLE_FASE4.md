# VEHICLE FASE 4 — 4x4 con física de pendiente sobre el terreno real

TASK PACKET v1-vehiculo. Reemplaza el modelo 2D de `stepCar` (verdicto REWRITE en
`docs/audit/03-conduccion-jugador-fisica.md`) por un modelo de fuerzas propio:
gravedad a lo largo de la pendiente, tracción limitada por `μ·N`, arrastres
separados, punto muerto y freno de mano. Actitud de 4 puntos y 4x4 procedural.

> Este documento separa **lo que se midió** (con números crudos) de **lo que no
> quedó hecho**. Nada de lo de abajo es una estimación: todo sale de
> `output/vehicle_measurements.json` (Node, física pura + terreno real) y
> `output/vehicle_captures.json` (app real en Chrome vía CDP).

---

## 1. Qué se construyó

| Archivo | Rol |
| --- | --- |
| `src/vehicle/physics.ts` | Modelo de fuerzas puro (sin Babylon). Reemplaza `stepCar`. |
| `src/vehicle/attitude.ts` | Cabeceo/alabeo desde los **4** puntos de apoyo. |
| `src/vehicle/model.ts` | 4x4 procedural con primitivas (**placeholder**). |
| `src/vehicle/controls.ts` | Teclado (patrón `Set` de la referencia). |
| `src/vehicle/index.ts` | Fachada: física + actitud + modelo + controles. |
| `src/main.ts` | Cableado: modo vehículo + cámara de persecución + API `window.__game`. |
| `src/diagnostics.ts` | HUD con velocidad, pendiente, tracción, residual de ruedas. |
| `src/terrain.ts` | `worldHeightFromSampler` + `auditVerticalDatum` (footgun). |
| `scripts/vehicle/measure_physics.mjs` | Mediciones §6 sin navegador. |
| `scripts/vehicle/capture_vehicle.mjs` | Capturas + medición en la app (CDP). |
| `scripts/vehicle/assert_heightfield_datum.mjs` | Aserción de los dos `heightAt`. |

La convención es la fija: **6000×6000 m**, `+X` este · `+Z` norte · `+Y` arriba,
`worldScale=1`, EPSG:25830, `verticalDatum=870`. Spawn `worldX=3097.258`,
`worldZ=3945.020` → cota 944.5484 m → Y de mundo **74.5484**.

---

## 2. El footgun de los dos `heightAt` (blindado)

| Función | Devuelve | En el pueblo |
| --- | --- | --- |
| `createHeightfield(grid, scale).heightAt(x,z)` | metros **absolutos** | `944.5484` |
| `terrain.heightAt(x,z)` (`src/terrain.ts`) | **Y de mundo** (datum restado) | `74.5484` |

La única traducción es `worldHeightFromSampler(sampler, datumOffset, x, z)`
(`src/terrain.ts`), que el `heightAt` del mundo usa. Se blindó con:

1. **Aserción en el arranque de la app** (`main.ts`): `auditVerticalDatum()` recorre
   el centro de cada tile + el spawn y exige `|mundo − (absoluto − datum)| < 1e-9`.
   Si falla, tira error y el HUD lo muestra. En la corrida real: `diff_max = 0`,
   `ok = true` (37 muestras, `output/vehicle_captures.json`).
2. **Script standalone** `scripts/vehicle/assert_heightfield_datum.mjs`: transpila
   el `worldHeightFromSampler` REAL y lo contrasta contra los valores ya
   verificados de `docs/terrain/crosscheck.json` (datos independientes):

```
pueblo_villafranca   abs=944.5484 mundo=74.5484 (abs−mundo=870.0000) pass=true
cumbre_max           abs=1194.0000 mundo=324.0000 (abs−mundo=870.0000) pass=true
cumbre_secundaria    abs=1126.0000 mundo=256.0000 (abs−mundo=870.0000) pass=true
punto_bajo_min       abs=870.0000  mundo=0.0000  (abs−mundo=870.0000) pass=true
punto_bajo_secundario abs=927.0000 mundo=57.0000 (abs−mundo=870.0000) pass=true
=> OK
```

Para apoyar el vehículo se usa **siempre** Y de mundo (el de `terrain.ts`). El de
`heightfield.ts` sin restar 870 dejaría el coche 870 m bajo tierra.

---

## 3. Modelo de fuerzas (`src/vehicle/physics.ts`)

Módulo **puro** (cero imports, corre en Node). Parámetros default:

```
mass 1800 kg · wheelBase 2.8 m · track 1.62 m · cgHeight 0.78 m · wheelRadius 0.38 m
maxDriveForce 14000 N · maxSpeed 32 m/s · brakeForce 12000 N · handbrakeForce 14000 N
engineBrakeForce 1200 N · rollingResistance 0.025 · dragCoefficient 0.66
grip 0.8 (longitudinal) · gripLateral 0.8
```

### Pendiente (lo central)

La normal del terreno da el gradiente; se proyecta la gravedad sobre el plano
tangente y se descompone en los ejes del cuerpo:

```
a_long = −g·gF / (S·√(1+gR²))        a_lat = −g·gR / (S·√(1+gF²))
S = √(1+gF²+gR²)                     gF/gR = gradiente en avance/derecha
```

En cuesta arriba `a_long < 0` frena solo; en bajada acelera solo. No depende del
acelerador: es gravedad de verdad.

### Tracción dependiente de la pendiente

`N = m·g/S` (la normal **disminuye** con la pendiente) y el límite es `μ·N`. Si la
fuerza pedida lo supera, se recorta y `slipping = true` (la rueda patina). La
consecuencia física directa: la pendiente máxima escalable tiende a **`atan(μ)`**,
porque arriba de ahí `m·g·sinθ > μ·m·g·cosθ` y ningún motor alcanza. Con `μ=0.8`,
`atan(0.8) = 38.66°`.

### Arrastres separados, punto muerto y freno

- Rodadura `Crr·N` (proporcional a la normal), aerodinámico `−k·v·|v|`.
- Freno de motor al soltar el acelerador; punto muerto lo desactiva.
- Freno de mano con **fricción estática**: sostiene si `μ·N` (o el drivetrain)
  alcanza; si no, el coche resbala igual.

### Lateral y estabilidad

- Gravedad lateral + amortiguamiento del neumático saturado en `μ_lat·N`.
- Guiñada tipo bicicleta limitada por agarre: si la aceleración centrípeta pedida
  supera `μ_lat·N/m`, el coche **subvirala** (`skidding = true`).
- Vuelco: el CG vuelca si `|a_lat_centrípeta + a_lat_gravedad| > g·n.y·(vía/2)/h_cg`.
  En llano el umbral (≈1.04 g) es mayor que el derrape (0.8 g) ⇒ **derrapa antes de
  volcar**. En ladera lateral equivale a `tanθ > (vía/2)/h_cg ≈ 46°`.

### Actitud (`src/vehicle/attitude.ts`)

Cuatro alturas de rueda → cabeceo y alabeo reales, más el residual no-planar del
apoyo. A diferencia de la referencia (2 puntos + `roll = −steer·speed·0.0025`,
cosmético), acá el coche se apoya en la pendiente.

---

## 4. Mediciones §6 — números crudos

### 4.1 Pendiente máxima escalable

**Plano sintético (control analítico).** Desde parado, acelerador a fondo 25 s,
barrido de 0.5° (`output/vehicle_measurements.json`):

| Pendiente | v final (m/s) | ¿sube? |
| --- | --- | --- |
| 37.5° | 6.063 | sí |
| 38.0° | 3.577 | sí |
| **38.5°** | **0.874 (3.1 km/h)** | **sí (el límite)** |
| 39.0° | −1.854 | no (resbala) |
| 40.0° | −7.185 | no |

- **Pendiente máxima escalable: 38.5°**, y a esa pendiente sube a **3.1 km/h: SÍ,
  sube a menos de 10 km/h**. A 39° ya no sube (termina en −1.85 m/s).
- Teoría `atan(μ) = 38.66°`. Coincide dentro de la resolución del barrido.

**Terreno real.** Arrancando **desde parado** en el punto, mirando a la máxima
pendiente local, 22 s:

| Punto real | Pendiente local | v final | ΔY | ¿subió? |
| --- | --- | --- | --- | --- |
| x=3320 z=3705 | 40.5° | −0.375 | −1.39 m | **no** (resbala) |
| x=2280 z=4100 | 32.6° | 28.107 | +45.19 m | sí |
| x=2690 z=4350 | 40.3° | −0.514 | −0.47 m | no |
| x=3685 z=3365 | 40.7° | 0.432 | −0.21 m | no |
| x=2795 z=2935 | 43.5° | −0.910 | −3.52 m | no |

**Número real: la pendiente máxima que sube desde parado en el terreno es ≈33°** (el
punto de 32.6° sube; todo lo de 40°+ resbala). Es consistente con el control
sintético y con `atan(0.8)`; la diferencia es que el DEM no tiene una cara
uniforme de 38.5° sostenida.

> Aclaración honesta: las caras de 40° del DEM son **cortas** (decenas de metros).
> Con carrera, la energía cinética permite “saltarlas”. Con el mismo test pero
> arrancando 40 m pendiente abajo, el 4x4 cruzó la cara de 40.5° ganando 81 m de
> cota. Eso es correcto físicamente, pero NO cuenta como “pendiente escalable
> desde parado”; por eso el número de arriba se mide desde parado.

### 4.2 Deslizamiento en bajada (punto muerto)

Aceleración entre t=1 s y t=5 s, sin acelerar, mirando pendiente abajo.

**Sintético:**

| Pendiente | a medida (m/s²) | `g·sinθ` (m/s²) | desvío |
| --- | --- | --- | --- |
| 10° | 1.451 | 1.703 | −14.8% |
| 15° | 2.275 | 2.539 | −10.4% |
| 25° | 3.844 | 4.146 | −7.3% |
| 40° | 5.927 | 6.306 | −6.0% |

El desvío es siempre **negativo** (menos aceleración que el ideal), como debe ser:
`Crr·g·cosθ` más el arrastre aerodinámico. A 10° la rodadura pesa más; a 40° el
término `cosθ` baja y el aero empieza a compensar. Modelo correcto.

**Terreno real** (4 s):

| Punto | Pendiente local | a medida | `g·sinθ` local | desvío |
| --- | --- | --- | --- | --- |
| x=3025 z=3950 | 22.4° | 2.589 | 3.739 | −30.8% |
| x=3320 z=3705 | 40.5° | 3.441 | 6.372 | −46.0% |
| x=2280 z=4100 | 32.6° | −0.172 | 5.290 | −103.2% |

**Estos desvíos son grandes y hay que explicarlos, no esconderlos**: el gradiente
del DEM cambia a lo largo del recorrido. El `g·sinθ` de referencia usa **solo la
pendiente del punto inicial**; a los pocos metros el coche sale de esa cara y
entra en terreno más plano (o incluso en contrapendiente, como el punto de 32.6°,
donde el coche terminó frenando). El control limpio es el **sintético** (desvío
−6% a −15%); en el DEM el número es dependiente del camino. Para una superficie
uniforme el modelo reproduce `g·sinθ` a menos de 15%.

En la app real, misma bajada (`output/vehicle_captures.json`, `bajada_app`): de
0 a 9.67 m/s en 3 s con pendiente local pasando de −22.7° a −4.0°.

### 4.3 Pérdida de tracción desde parado (pendiente fuerte)

Sintético, acelerador a fondo 12 s:

| Pendiente | Resultado | v final | ¿patinó? |
| --- | --- | --- | --- |
| 25° | sube | 13.07 m/s | sí (rueda recortada) |
| 30° | sube | 10.20 m/s | sí |
| 35° | sube | 7.22 m/s | sí |
| 38° | sube (lento) | 1.73 m/s | sí |
| 40° | **resbala hacia atrás** | −3.51 m/s | sí |

En el terreno real, el intento de subida frontal a la cara de 40.2° desde parado
(`output/vehicle_captures.json`, `intento_subida_40`): el HUD marca
**“PATINA (rueda recortada por tracción)”**, con `μN = 10785 N` aplicados,
`gravedad = −11404 N` y `v = −0.32 m/s`. Es decir: no sube pegado como orugas,
patina y se escurre hacia atrás. Captura: `output/vehicle_traccion.png`.

### 4.4 Estabilidad

Llano, giro a fondo (`steer=1`):

| v (km/h) | a_lat máx (m/s²) | ¿derrapa? | ¿vuelco? |
| --- | --- | --- | --- |
| 18 | 4.26 | no | no |
| 36 | 7.85 | sí | no |
| 54–108 | 7.85 | sí | no |

- Derrape satura en `μ_lat·g = 7.85 m/s²` (coherente).
- **En llano NO vuelca**: el umbral de vuelco (10.19 m/s²) es mayor que el de
  derrape, así que a cualquier velocidad primero derrapa. Lo mismo ocurre en
  curvas sobre pendiente.

Ladera lateral (de costado, punto muerto):

| Pendiente | v_lat máx | ¿se escurre? | ¿vuelco? |
| --- | --- | --- | --- |
| 30° | 0.22 m/s | no | no |
| 40° | 1.70 m/s | sí | no |
| 45° | 7.10 m/s | sí | no |
| 48° | 10.33 m/s | sí | **sí** |

Umbrales teóricos: escurrimiento `atan(μ)=38.7°`, vuelco `atan((vía/2)/h_cg)=46.1°`.
La simulación los respeta (30° sostiene, 40° escurre, 48° marca riesgo de vuelco).

**Conclusión de estabilidad: en llano derrapa antes de volcar; solo marca riesgo de
vuelco en laterales > ~46°, que en el mapa son farallones.**

### 4.5 Contacto rueda-terreno (no atraviesa ni flota)

Residual = `terreno(x,z) − (centro_rueda.y − radio)`, medido en la app real con la
transformación completa (`output/vehicle_captures.json`, sección `contacto`):

| Punto | Residual máx (m) |
| --- | --- |
| spawn (3097, 3945) | **0.0148** |
| moderada 22° (3025, 3950) | 0.0636 |
| oeste 32° (2280, 4100) | 0.1255 |
| fuerte 40° (3320, 3705) | 0.1601 |
| sur 40° (2690, 4350) | 0.1725 |
| este 40° (3685, 3365) | **0.2187** |

**Tolerancia declarada: 0.5 m.** Máximo medido: **0.219 m** en el punto más
quebrado. No hay penetración masiva ni flotación. El residual es inevitable con un
cuerpo rígido y un DEM de 5 m: las 4 ruedas no son coplanares. El ajuste de plano
reparte el error; el modelo no tiene suspensión independiente por rueda (fuera de
alcance). En el arranque el residual es de 1.5 cm.

### 4.6 Rendimiento (advertencia explícita)

Corrida real (`output/vehicle_captures.json`, `perf`):

| Métrica | Valor | Válido |
| --- | --- | --- |
| draw calls | **13** | sí |
| triángulos | **240 360** (3 tiles) / 320 000 (4 tiles) | sí |
| vértices | 1 454 892 | sí |
| FPS | ~9–10 | **NO** |
| frame time | ~100–130 ms | **NO** |

**Chrome headless sin GPU usa SwiftShader (CPU): ese FPS NO es rendimiento del
juego.** Es el único dato de FPS disponible y por eso se declara explícitamente
como no representativo. El 4x4 procedural agrega ~360 triángulos (6 cajas + 4
cilindros) y ~8 draw calls sobre el terreno; el costo geométrico es despreciable
frente a los 240 000 triángulos del terreno.

---

## 5. Capturas (`output/`)

| Archivo | Qué muestra |
| --- | --- |
| `vehicle_spawn.png` | 4x4 parado en el pueblo (spawn exacto, Y≈74.4, residual 1.5 cm). |
| `vehicle_pendiente.png` | 4x4 sobre la pendiente fuerte de 40.5° **de costado**, con alabeo real de **−39.4°** (HUD `pend. abs 37.8°`). |
| `vehicle_traccion.png` | 4x4 de frente al 40.2° desde parado: HUD **PATINA**, `μN=10785 N`, gravedad −11404 N, v=−0.32 m/s (se escurre). |

---

## 6. Qué NO quedó hecho (y qué es placeholder)

1. **El 4x4 es un PLACEHOLDER.** Son cajas y cilindros de Babylon
   (`CreateBox`/`CreateCylinder`). No es la versión final ni lo pretende: falta el
   GLB de Blender, materiales (pintura/cristal/cromo) y el manifiesto de ruedas.
2. **Sin suspensión independiente por rueda.** La actitud es un plano rígido de 4
   puntos; de ahí el residual de hasta 0.22 m. No hay resortes ni amortiguadores.
3. **Sin dinámica vertical / saltos (airborne).** El coche no despega ni cae en
   parábola; `airborne` existe como bandera (residual > 0.5 m) pero no hay vuelo.
4. **Sin vuelco dinámico simulado.** `rolloverRisk` es un criterio de riesgo
   calculado; el coche no gira sobre su eje. En llano nunca se alcanza porque
   derrapa antes.
5. **Sin fricción por superficie** (ASPHALT/GRAVEL/DIRT/GRASS). No hay datos de
   superficies todavía; `grip` es un único coeficiente parametrizable. Era
   requisito de otra tarea.
6. **Sin colisiones** (árboles, rocas, taludes, agua). El coche atraviesa todo.
7. **Sin caja de cambios/reducida real.** La fuerza de tracción cae linealmente con
   la velocidad; no hay marchas ni modo 4L.
8. **Sin streaming de terreno**: se cargan los 36 tiles al arrancar (heredado de
   la FASE 2, fuera de alcance).
9. **No hay script `npm test`.** El `package.json` está fuera de mi alcance de
   escritura (§5). Las aserciones se corren con:
   `node scripts/vehicle/assert_heightfield_datum.mjs` (y la del datum corre
   además en el arranque de la app).
10. **Cámara**: se usan persecución (modo vehículo) y cámara libre (si hay
    `px/py/pz`, para no romper las capturas de terreno). No hay cabina.

---

## 7. Cómo reproducir

```bash
cd /home/kiri_/projects/montes-de-oca-offroad
npm run typecheck && npm run build

# Aserción del footgun de los dos heightAt
node scripts/vehicle/assert_heightfield_datum.mjs

# Mediciones §6 (Node, sin navegador): física pura + terreno real
node scripts/vehicle/measure_physics.mjs          # -> output/vehicle_measurements.json

# Capturas + medición en la app real (Chrome headless + CDP, cero deps)
npx vite preview --host 127.0.0.1 --port 4173 &
node scripts/vehicle/capture_vehicle.mjs          # -> output/vehicle_*.png + vehicle_captures.json
```

Controles: **W/S** acelerar/frenar · **A/D** girar · **Espacio** freno de mano ·
**N** punto muerto · **R** reposicionar. Modo vehículo por defecto; `?px=..&pz=..`
activa la cámara libre histórica.

---

## 8. Confianza

- **Alta (medida):** pendiente máxima 38.5° sintético / ≈33° real desde parado;
  coincidencia con `atan(μ)`; desvío de bajada −6% a −15% en el control sintético;
  tracción limitada por `μN` con `μN=10785 N < mg·sinθ=11404 N` en 40.2°; derrape
  antes de vuelco en llano; residual de contacto ≤ 0.219 m; auditoría de datum = 0.
- **Media:** números de bajada en el terreno real, porque dependen del camino
  (explicado en §4.2). Calibración fina de `grip` por superficie, pendiente de datos.
- **No válida como rendimiento:** FPS/frame time de Chrome headless (§4.6).
