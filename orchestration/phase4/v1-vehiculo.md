# TAREA v1-vehiculo — 4x4 con física de pendiente sobre el terreno real de Villafranca

**Modelo**: `opencode-go/deepseek-v4.1-flash`
**Fase**: FASE 4 (conducción)
**Proyecto**: `/home/kiri_/projects/montes-de-oca-offroad`
**Referencia (SOLO LECTURA, jamás escribir)**: `/home/kiri_/projects/montes-de-oca`

Eres el **único escritor** de `src/**` y `scripts/vehicle/**`. Nadie más está tocando
esos directorios. A cambio: **no toques nada fuera de ellos.**

---

## 1. Misión

El terreno real de Villafranca Montes de Oca ya está construido y verificado (36 tiles a 5 m,
copia 1:1 del DEM del IGN). **Falta el vehículo.** Hoy no existe: no hay coche, no hay física,
no hay nada que conducir.

Tu misión: **un 4x4 manejable sobre ese terreno, cuya física SIENTA las pendientes.**

El motor de referencia tiene un modelo de coche **puramente 2D**: no hay gravedad, no hay fuerza
de pendiente, y `grip` es sólo un techo de velocidad (`53 * grip`). El coche se *inclina*
visualmente pero **no siente la cuesta**. Eso es exactamente lo que hay que reemplazar.
Leé el veredicto completo en `docs/audit/03-conduccion-jugador-fisica.md` (paso 3 del §2).

---

## 2. Leé primero (en este orden)

1. `docs/audit/03-conduccion-jugador-fisica.md` — el veredicto sobre `stepCar` y por qué es
   REWRITE y no REUSE. Es tu documento de diseño principal.
2. `docs/terrain/TERRAIN_FASE2.md` — qué hay construido del terreno y con qué números.
3. `docs/ENGINE_SCAFFOLD.md` — el andamiaje del proyecto.
4. Nuestro código: `src/main.ts`, `src/terrain.ts`, `src/heightfield.ts`, `src/diagnostics.ts`, `src/config.ts`.
5. En la referencia (solo leer): `src/driving.ts`, `src/city-world.ts` (mirá la línea 513, el
   `atan2` que da el cabeceo visual), `src/controls*.ts`, `src/navigation.ts`.

**No leas los `.glb` de la referencia**: son punteros de Git LFS de 129 bytes, no hay malla usable.

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
| `viewRadius` | 900 (en `public/terrain/config.json`) |
| **Spawn** | `worldX = 3097.258`, `worldZ = 3945.020` → cota 944.5484 m → **Y de mundo 74.5484** |

Fuente de verdad del spawn y de la cota: `docs/terrain/crosscheck.json`, punto `pueblo_villafranca`.
Está verificado contra el ráster del IGN con diferencia **0**.

---

## 4. ⚠️ TRAMPA CRÍTICA: hay DOS `heightAt` y difieren en 870 m

Esto te va a arruinar la corrida si no lo lees. **Hay dos funciones con el mismo nombre:**

| Función | Devuelve | Ejemplo en el pueblo |
| --- | --- | --- |
| `createHeightfield(grid, scale).heightAt(x, z)` | **metros ABSOLUTOS** | `944.5484` |
| `terrain.heightAt(x, z)` (el que exporta `src/terrain.ts:337`) | **Y de mundo** (resta el datum) | `74.5484` |

`src/heightfield.ts` **no** resta el datum: `surfaceMeters(...) * worldScale`.
`src/terrain.ts:337-339` **sí**: `sampler.heightAt(x, z) - datumOffset`.

**Para apoyar el vehículo en el suelo querés Y de mundo → usá el de `terrain.ts`.**
Si usás el de `heightfield.ts` sin restar 870, el coche aparece 870 m bajo tierra o en el cielo.

**Requisito**: dejá esto blindado. Agregá una aserción o test que verifique que los dos difieren
exactamente en `verticalDatum`, con un comentario que explique cuál es cuál. Es un footgun real,
no una prolijidad.

Fuera de todos los tiles, `terrain.heightAt` devuelve **0** (que es el Y de mundo de la cota mínima
del mapa, 870 m). No es un bug, pero tenelo presente en los bordes del mundo.

---

## 5. Alcance

### Hacé

1. **Modelo de fuerzas propio para el 4x4** (reemplaza `stepCar`). Mínimo:
   - **Componente de gravedad a lo largo de la pendiente.** Es el punto central de la tarea.
   - **Agarre/tracción dependiente de la pendiente**: en pendiente fuerte y con poca velocidad,
     el vehículo debe **perder tracción y resbalar**, no subir pegado como si tuviera orugas.
   - **Arrastre de rodadura y aerodinámico** separados (hoy no existen).
   - **Freno de mano** y **punto muerto** (para poder medir el deslizamiento en bajada).
   - Diferencial/ bloqueo NO: fuera de alcance.
2. **Actitud del vehículo desde el terreno de verdad**: cabeceo (pitch) y alabeo (roll) muestreados
   en **los cuatro puntos de apoyo**, no con los dos puntos y el `atan2` de la referencia. El coche
   tiene que *apoyarse* en la pendiente, no estimarla.
3. **Un 4x4 procedural con primitivas de Babylon** (carrocería, cabina, 4 ruedas). Las ruedas giran
   según la velocidad. **Declaralo como placeholder** para un modelo de Blender futuro — no es la
   versión final y no lo presentes como tal.
4. **Controles** de teclado (adelante/atrás/izquierda/derecha/freno de mano). Reusá el patrón de
   controles de la referencia; no inventes un sistema nuevo.
5. **HUD en `src/diagnostics.ts`**: velocidad (km/h), pendiente actual en grados (y su signo),
   Y de mundo, X/Z, y si hay tracción o está resbalando. El HUD es tu instrumento de medición:
   sin él no podés validar nada.

### NO hagas

- **No toques**: `public/terrain/**`, `public/roads/**`, `data/**`, `scripts/terrain/**`,
  `scripts/roads/**`, `docs/audit/**`, `docs/geo/**`, ni el repo de referencia.
- **No agregues dependencias.** Ni motor de física (Havok, Ammo, Cannon), ni Playwright, ni nada.
  El modelo de fuerzas es propio, como en la referencia. Si creés que necesitás una dependencia,
  **pará y escribilo en el informe** en vez de instalarla.
- **No cambies el esquema de los tiles** ni la interpolación SW→NE de `heightfield.ts`. Está
  verificada carácter por carácter contra la referencia.
- **No renderices las vías OSM todavía** (eso es otra tarea).
- **No hagas commits.** Yo valido y commiteo.

---

## 6. Validación obligatoria — medir, no afirmar

**Construir no es validar.** Tenés que **correr la aplicación** y medir. Un build exitoso no dice
nada sobre si el coche se comporta como un vehículo.

Para las capturas hay un patrón ya resuelto en `scripts/terrain/capture_terrain.mjs`: Chrome
headless + CDP con el WebSocket nativo de Node, **cero dependencias nuevas**. Copiá ese patrón
en `scripts/vehicle/capture_vehicle.mjs` y pasale los ángulos del coche por parámetros de URL
(o el mecanismo que prefieras).

### Mediciones que tenés que entregar

1. **Pendiente máxima escalable.** Barrido: encontrá el ángulo a partir del cual el 4x4 ya no sube
   (se detiene o resbala). Reportá el número en grados, y si sube a menos de 10 km/h decilo.
   Hacelo **en el terreno real** y también en un **plano sintético** de pendiente conocida para
   control. Los dos números.
2. **Deslizamiento en bajada.** Punto muerto, sin acelerar, en una pendiente conocida: medí la
   aceleración resultante en m/s². Con gravedad real debería acercarse a `g · sin(θ)` menos
   pérdidas. Decí cuánto se desvía y por qué.
3. **Pérdida de tracción.** En pendiente fuerte arrancando desde parado: ¿resbala, patina, o
   sube? Reportá el comportamiento, no una opinión.
4. **Estabilidad.** A qué velocidad vuelca o derrapa. Si no vuelca, decilo.
5. **El coche NO debe atravesar el terreno ni flotar.** Verificá que la distancia entre la rueda
   y `terrain.heightAt()` en su posición sea ~0 dentro de tolerancia. Medilo en varios puntos.
6. **FPS, tiempo de cuadro, draw calls y triángulos** de una corrida real. **Advertencia**: Chrome
   headless sin GPU da un número que **NO es señal de rendimiento del juego**. Si ese es tu único
   dato, **decilo explícitamente** en vez de presentarlo como rendimiento. El dato de draw calls
   y triángulos sí es válido.
7. **Capturas**: el 4x4 parado en el pueblo (spawn) y **subiendo una pendiente fuerte de costado
   a la pendiente**, para que se vea el alabeo. Guardalas en `output/`.

### Dónde está la pendiente fuerte de verdad

Mapa medido: el terreno sube **hacia el SUDOESTE**. El pueblo está a 945 m, en el bajo del noreste;
hay farallones naturales (pendientes de 60–78°) confinados a la banda **980–1145 m**. Cumbres de
referencia: `worldX 165, worldZ 0` (1194 m) y `worldX 1670, worldZ 3840` (1126 m).
No intentes subir un farallón: son paredes reales y es correcto que el coche no pueda.

---

## 7. Entregables

| Archivo | Qué |
| --- | --- |
| `src/vehicle/*.ts` | modelo de fuerzas, actitud, 4x4 procedural, controles |
| `src/main.ts` | cableado del vehículo en la escena |
| `src/diagnostics.ts` | HUD con velocidad, pendiente, tracción |
| `scripts/vehicle/capture_vehicle.mjs` | captura + medición por CDP |
| `scripts/vehicle/measure_physics.mjs` | las mediciones del §6 |
| `docs/vehicle/VEHICLE_FASE4.md` | informe: qué hiciste, **qué NO**, y las mediciones crudas |
| `output/*.png` | capturas |

## 8. Definición de hecho

- [ ] El 4x4 se maneja con teclado sobre el terreno real.
- [ ] **La pendiente se siente**: cuesta abajo acelera solo, cuesta arriba pierde velocidad, y en
      pendiente fuerte pierde tracción.
- [ ] El coche se apoya en la pendiente con cabeceo y alabeo de los 4 puntos.
- [ ] No atraviesa ni flota el terreno (medido, con tolerancia declarada).
- [ ] Las mediciones del §6 están en el informe **con sus números**, incluidas las que salieron mal.
- [ ] El footgun de los dos `heightAt` está documentado y con aserción.
- [ ] El informe dice explícitamente **qué NO quedó hecho** y qué es placeholder.

## 9. Cómo correr

```bash
cd /home/kiri_/projects/montes-de-oca-offroad
npm run dev        # o: npx vite --port 4173  (ver package.json)
npm test
npm run build
```

## 10. Memoria

Si descubrís algo no obvio —un comportamiento raro del sampler, un límite de la física, un
parámetro que importa más de lo esperado— **guardalo en Engram con `mem_save`**, proyecto
`montes-de-oca`, antes de terminar. El detalle completo lo tenés vos; yo después no lo puedo
reconstruir.

Y **no adornes**: si algo no funciona, decilo con el número que lo muestra. Un informe honesto
con un fracaso medido vale muchísimo más que uno optimista sin números.
