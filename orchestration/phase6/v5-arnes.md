# TAREA v5-arnes — validación de la milestone 1 de punta a punta

**Modelo**: `opencode-go/deepseek-v4.1-flash`
**Proyecto**: `/home/kiri_/projects/montes-de-oca-offroad`
**Referencia (SOLO LECTURA, jamás escribir)**: `/home/kiri_/projects/montes-de-oca`

## Por qué existís

La milestone `VILLAFRANCA → PISTA → OBJETIVO → REGRESO` **no se puede cerrar con
`npm test` y `npm run build`**. Hay que jugarla. Tu trabajo es que eso sea
verificable sin una persona apretando teclas, y que **cuando algo falle, falle
ruidosamente y con un número útil**.

Un arnés que no puede fallar es peor que no tener arnés: da confianza falsa.

## Tus archivos (ÚNICOS, sos el único escritor)

- `scripts/milestone/drive_milestone.mjs`
- `docs/milestone1/ARNES.md` — **máximo 30 líneas**.

**PROHIBIDO tocar**: `src/**`, `index.html`, `package.json`, `public/**`,
`scripts/**` salvo tu archivo, y **cualquier cosa que ya exista** en
`scripts/vehicle/`, `scripts/roads/draping/`, `scripts/terrain/`.
Si algo del juego no se puede validar porque falta una API, **NO la agregues vos**:
describí exactamente qué necesitás y fallá el check correspondiente.

## Patrón del repo que tenés que seguir (leelo, no lo reinventes)

- `scripts/vehicle/capture_vehicle.mjs` y
  `scripts/roads/draping/capture_draping.mjs`: levantan el server, lanzan Chrome
  headless por CDP con un WebSocket nativo de Node y sacan capturas.
  **NO uses Playwright.** Cero dependencias nuevas.
- `scripts/vehicle/measure_physics.mjs`: el patrón de **medición determinista**:
  se maneja la física desde el script con `window.__game.vehicle.step(segundos, dt)`
  y `setInput(...)`, sin depender del reloj del render.

## La API de depuración que el juego expone en `window.__game`

El orquestador la está cableando. Va a estar disponible apenas se integre:

```ts
window.__game = {
  terrainHeightAt(x, z): number,
  terrainNormalAt(x, z): { x, y, z },
  perf(): { fps, frameTimeMs, drawCalls, triangles, vertices, activeMeshes },
  auditDatum(): { ok, maxAbsDiffM, verticalDatum },
  route: FirstRoute | null,        // src/gameplay/first-route.ts
  vehicle: {
    telemetry(): VehicleTelemetry, // x,z,y,yawDeg,speedKmh,slopeForwardDeg,
                                   // wheelResidualMaxM, airborne, contacts, ...
    setInput(input | null): void,
    teleport(x, z, yaw): void,
    step(seconds, dt?): void,      // paso manual determinista
    reset(): void,
  } | null,
  player: {
    mode(): 'on-foot' | 'driving',
    telemetry(): { mode, x, y, z, yawDeg, speedMps, interact, distanceToVehicleM, canEnter },
    toggleVehicle(): 'on-foot' | 'driving',
    step(seconds, dt?): void,      // paso manual determinista
    teleport(x, z, yaw): void,
  } | null,
  mission: {
    snapshot(): MissionSnapshot,   // state, hint, distanceToTargetM,
                                   // distanceToReturnM, repairProgress,
                                   // repaired, elapsedS, completed
    reset(): void,
  } | null,
};
```

`FirstRoute` (`src/gameplay/first-route.ts`): `start`, `startYaw`, `polyline`
(densa, cada 10 m), `waypoints` (con `role` e `atM`), `trackEntry`, `target`,
`targetYaw`, `returnPoint`, `checkpoints`, `profile`.

**Si alguna de esas APIs no existe cuando corras, FALLÁ el check con un mensaje que
diga cuál falta.** No la simules ni la parches desde afuera.

## Qué tiene que hacer `drive_milestone.mjs`

```
node scripts/milestone/drive_milestone.mjs [--out-dir output/milestone1] [--port 4183]
                                           [--base http://127.0.0.1:4183] [--budget-s 300]
```

1. **Levantar el server** (build previo si hace falta) y Chrome headless por CDP.
   Esperar a que exista `window.__game` y `window.__game.route`.
2. **FASE B — aparición.** Esperar a que el terreno y el 4x4 estén listos.
   Comprobar y reportar:
   - `|vehicle.y − terreno.heightAt(x, z)|` chico (el 4x4 no está enterrado ni flotando)
   - distancia del vehículo al `route.start` (debe ser ~0; el spawn sale de la ruta)
   - captura `01_spawn_villafranca.png`
3. **Entrar al 4x4**: `player.toggleVehicle()` → modo `driving`. Falla si no.
4. **FASE C — conducir.** Conducir la ruta por tramos, con pure-pursuit sobre
   `route.polyline`, avanzando la física con `vehicle.step(...)` en dt fijo (1/60):
   - capturas `02_road.png` (sobre el asfalto), `03_track_entry.png` (en `trackEntry`),
     `04_offroad.png` (a mitad de pista), `05_target.png` (al llegar)
   - registrar por frame: tiempo simulado, velocidad, `slopeForwardDeg`,
     `wheelResidualMaxM`, `airborne`, `contacts`
   - **fallar ruidosamente** si: no llega al objetivo dentro de `--budget-s` (reportá
     la distancia restante y la última pose), o si queda atascado (velocidad < 0,5 m/s
     durante más de 5 s simulados). Un atasco silencioso es el peor resultado posible.
   - al llegar, `mission.snapshot().state` tiene que ser `TARGET_REACHED`
5. **FASE F/G — a pie e interacción.** `player.toggleVehicle()` → `on-foot`. Caminar
   hasta el objetivo. Captura `06_interaction.png`. Mantener `interact` hasta que
   `repairProgress` llegue a 1 y el estado sea `REPAIRED`. Falla si repara desde el
   coche (comprobá que NO se puede: intentá reparar antes de bajarte y verificá que el
   estado no cambia).
6. **FASE H — regreso.** Entrar al 4x4, conducir de vuelta por la polilínea
   invertida hasta `returnPoint`. Captura `07_return.png`. Estado `COMPLETED`.
7. **Errores de consola**: enganchá `Runtime.exceptionThrown` y `console.error`.
   Cualquier excepción no atrapada **hace fallar** el arnés. Reportá el texto.
8. **Escribir `output/milestone1/drive_report.json`** con: el checklist de
   aserciones (nombre, ok, valor real, umbral), las métricas del recorrido
   (tiempo simulado, distancia, pendiente p95/máx, frames `airborne`, `wheelResidualMaxM`
   máximo, velocidad media/máx), y `perf()` antes/después.
9. **Imprimir un checklist legible** y **salir 0 sólo si pasó todo**.
10. **FPS**: reportá el número pero **etiquetálo explícitamente como NO señal de
    rendimiento** (headless usa SwiftShader, CPU). El único número de rendimiento que
    vale acá son draw calls y triángulos. Dejá dicho en el reporte que el FPS real
    hay que medirlo en la GPU del usuario a 1920×1080 (objetivo ~60 fps en RTX 2070).

### Parámetros de partida del seguidor (ajustá si oscila)

- `lookahead = clamp(12 + 0.7 * v, 12, 25)` m sobre la polilínea
- velocidad objetivo ≈ 15 m/s (54 km/h); en pista, si la pendiente baja es fuerte,
  bajala
- `throttle = clamp((vTarget − v) / 4, −1, 1)`; `steer = clamp(errAng / 0.6, −1, 1)`
- si el error angular > 1,2 rad, frená y giré fuerte
- **acelerar y frenar son simétricos en la física**: verificalo en los números, no lo
  asumas

## Verificación (obligatoria, y honesta)

- `npm run typecheck` y `npm run build` limpios.
- **El arnés tiene que correr de verdad** y producir `drive_report.json` + las 7
  capturas en `output/milestone1/`. Pegá en tu reporte el checklist tal cual salió.
- **PROBÁ EL CAMINO DE ERROR.** Corré el arnés con un presupuesto imposible
  (`--budget-s 3`) y comprobá que **falla con un mensaje útil** (salida ≠ 0, distancia
  restante reportada). Pegá esa salida. Un arnés cuyo fallo no probaste no está probado.
- Si el recorrido **no se completa**, NO lo maquilles: reportá dónde se traba, con
  números, y si hace falta achicá el presupuesto para llegar antes al diagnóstico.
  Un hallazgo honesto vale más que un verde falso. Si el problema es de física,
  **no toques `src/vehicle/**`**: reportalo.
- **Mirá las 7 capturas** y describí qué se ve en cada una. Si una sale negra, o el
  coche está enterrado, o el objetivo no se ve, decilo.
- **No declares éxito por compilar.**

## Al terminar

Guardá en Engram (`mem_save`, `project: "montes-de-oca"`) los hallazgos no obvios
(sobre todo: dónde se traba el recorrido y por qué).
Después respondé, corto:

```
FILES: <archivos>
WHAT: <qué hiciste, 3-6 líneas>
VERIFY: <comandos + checklist real; qué se ve en cada captura>
NUMBERS: tiempo simulado, distancia, pendiente máx, frames airborne, wheelResidualMax,
         draw calls y triángulos antes/después
FAIL PATH: <la salida real del --budget-s 3>
RISKS: <lo que no está probado>
```

---

## API de depuración YA INTEGRADA (usá esto; no la inventes ni la modifiques)

Todo cuelga de `window.__game`, con la página servida normal (el personaje está activo
por defecto; `?player=0` lo apaga y es el camino legado de medición de la FASE 4).

```js
__game.route                   // { start, startYaw, polyline[], waypoints[], trackEntry,
                               //   target, targetYaw, returnPoint, checkpoints[],
                               //   targetClearRadiusM, ... }
__game.player.mode()           // 'on-foot' | 'driving'
__game.player.telemetry()      // { mode, x, y, z, yawDeg, speedMps, running, moving,
                               //   interact, distanceToVehicleM, canEnter }
__game.mission.name            // 'REPETIDOR SIN SEÑAL'
__game.mission.snapshot()      // { name, state, objective, hint, distanceToTargetM,
                               //   distanceToReturnM, repairProgress, repaired,
                               //   elapsedS, completed }
__game.terrainHeightAt(x, z)   // Y de mundo (no la cota absoluta)
__game.vehicle?.telemetry()    // telemetría del 4x4 (ver src/vehicle/index.ts)

// ENTRADA INYECTADA: no hace falta teclear nada. `null` devuelve el control al teclado.
__game.player.inject({ toggle: true })               // pulsar F (se consume una vez)
__game.player.inject({ throttle: 1, steer: 0.05 })   // conducir
__game.player.inject({ handbrake: true })            // freno de mano
__game.player.inject({ forward: 1, run: true })      // caminar / correr
__game.player.inject({ interact: true })             // mantener E (NIVEL, no flanco)
__game.player.inject({})                             // soltar todo
__game.player.inject(null)                           // devolver el control al teclado

// AVANCE DETERMINISTA: avanza MUNDO **y MISIÓN** con el mismo dt, igual que el render
// loop. Llamalo en tramos chicos (0,25 s), no de un saque de 40 s.
__game.player.step(seconds, dt = 1/60)

__game.player.toggleVehicle()
__game.player.teleport(x, z, yaw)
__game.mission.reset()
```

`__game.vehicle.setInput` / `__game.vehicle.step` siguen existiendo pero **no avanzan la
misión**: son el camino legado de medición. Para la milestone usá `player.inject` +
`player.step`.

### El bucle que tiene que funcionar

Está implementado en `src/gameplay/mission.ts` (48/48 checks propios, ya verificado):

```
NOT_STARTED --(driving)--> ACTIVE --(distanceToTargetM <= reachRadiusM)--> TARGET_REACHED
TARGET_REACHED --(onFoot && en alcance && E mantenida repairSeconds)--> REPAIRED
REPAIRED --(driving)--> RETURNING --(distanceToReturnM <= reachRadiusM)--> COMPLETED
```

Los valores por defecto de `reachRadiusM` y `repairSeconds` son constantes al inicio de
`src/gameplay/mission.ts`: leelos, no los adivines.

- De `NOT_STARTED` se sale **conduciendo**. El primer gesto del juego es entrar al 4x4.
- La reparación exige estar **A PIE** y con **E a nivel** (mantenida, no un toque).
- Completar **no** exige bajarse: alcanza con volver conduciendo y acercarse al punto de
  regreso. Pero en las capturas SÍ queremos el ciclo completo: bajarse en el objetivo,
  reparar, volver a subir, volver, y recién ahí completar.

### Reglas

- `src/main.ts` está **CONGELADO** para vos. Si encontrás un bug de integración, **no lo
  arregles**: reportalo con la reproducción exacta (llamada, estado esperado, estado real).
- Medí y guardá NÚMEROS, no impresiones.
- El camino de error se prueba a propósito (`--budget-s 3`): un arnés cuyo fallo no probaste
  no está probado.
- Elegí un puerto LIBRE y verificalo antes de levantarlo: hay otros procesos vivos en la
  máquina y pelearse por el puerto hace que se maten entre ellos.
