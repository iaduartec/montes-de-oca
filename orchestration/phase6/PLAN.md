# Milestone 1 — VILLAFRANCA → PISTA → OBJETIVO → REGRESO

Tablero de la fase. Se marca `[x]` **solo con la verificación hecha**, nunca porque el
worker dice que terminó. Dueño: orquestador.

## La ruta (FASE A) — HECHA

`src/gameplay/first-route.ts` (generado) + `route-types.ts` (contrato a mano).
**Repetidor sin señal** · 2.361 m por tramo · 4,7 km ida y vuelta · ~9-11 min.

```
inicio     (3088, 3935) yaw -3,037  cota  75 m  sobre la N-120, en Villafranca
carretera    661 m saliendo del pueblo hacia el sur
entrada a pista (3269, 3372) a 661 m            <-- checkpoint propio
pista      1.700 m subiendo 164 m netos
objetivo   (4178, 2060) yaw -0,527  cota 239 m  fondo de pista, a 1.295 m de
                                                cualquier carretera
pendiente  p95 18,0° · máx 21,8° · 2 tramos de 5 m sobre 20° · PATH 0 m
```

`npm test` la re-deriva y falla si el archivo no coincide o si dejó de ser conducente.

## Fases

`[~]` = código integrado y typecheck/build verdes, **verificación real pendiente**.

- [x] **A** · ruta definida desde OSM + pendiente real, verificada en `npm test`
- [x] **B** · aparición. Commit `f468819`. Verificado en Chrome headless con `--dump-dom` y
      `--screenshot`: el HUD se llena (⇒ el render loop corre), el 4x4 aparece en
      `x=3087.5 z=3935.1 yaw=-174°` sobre `Y mundo 75.000` con `ruedas residual máx 0.000`,
      el jugador queda **a pie al costado**, `#accion` muestra "F — entrar al 4x4" y la
      misión arranca en `SIN EMPEZAR`. Captura `output/milestone1/00_boot_spawn.png`.
      **Los dos bugs de esta fase salieron de MIRAR la captura**, no del código: el jugador
      nacía dentro del chasis (79% del cuadro casi negro → 2,8%) y `#controls` mostraba las
      teclas de la cámara libre mientras conducías. Typecheck y build estaban verdes en los
      dos casos
- [ ] **C** · conducción de extremo a extremo **medida** (no mirada)
- [ ] **D** · vegetación FOREST/GRASS/FIELDS con corredores y spawn/objetivo libres — `v1` en vuelo
- [ ] **E** · Villafranca low-poly desde footprints OSM, sin casas flotando — `v2` en vuelo
- [~] **F** · personaje: caminar 3,4 / correr 6,8 m/s, entrar/salir. 20/20 checks propios.
      Falta la captura
- [~] **G** · objetivo de telecomunicaciones + interacción (E). La captura de v3 ya verifica
      que la base apoya en el terreno (`floating: false`). Falta el ciclo completo
- [~] **H** · misión REPETIDOR SIN SEÑAL, 6 estados. 48/48 checks con los caminos negativos
      (soltar E resetea, alejarse resetea, 26 m no alcanza / 24 m sí). Falta recorrerla
- [ ] **I** · atmósfera mínima: cielo, niebla, sol, sombras razonables
- [x] · integración en `src/main.ts` + HUD de misión (orquestador) — commit `62c22f1`
- [ ] · arnés de validación punta a punta con capturas y camino de error probado — `v5` en vuelo
- [ ] · cross-review de cada packet por **otro** modelo
- [ ] · evidencia en `output/milestone1/` + commits atómicos

## Paquetes en vuelo

| worker | modelo | escribe | packet |
| --- | --- | --- | --- |
| `v1-vegetacion` | mimo-v2.6-flash-free | `src/environment/vegetation.ts`, `scripts/environment/build_vegetation.mjs`, `public/vegetation/` | `phase6/v1-vegetacion.md` |
| `v2-pueblo` | mimo-v2.6-flash-free | `src/environment/village.ts`, `scripts/environment/build_village.mjs`, `public/village/` | `phase6/v2-pueblo.md` |
| `v3-mision` | deepseek-v4.1-flash | `src/gameplay/{interact,mission,objective}.ts` | `phase6/v3-mision.md` |
| `v4-jugador` | deepseek-v4.1-flash | `src/player/**`, `scripts/player/test_movement.mjs` | `phase6/v4-jugador.md` |

Congelados para todos: `src/main.ts`, `index.html`, `package.json`, `src/terrain.ts`,
`src/heightfield.ts`, `src/config.ts`, `src/road-draping.ts`, `src/vehicle/**`,
`src/gameplay/route-types.ts`, `src/gameplay/first-route.ts`.

## Reglas de esta fase

- **Un solo escritor por archivo.** Los cuatro paquetes escriben archivos disjuntos.
- Ningún packet se marca `[x]` sin: `typecheck` + `build` + su check propio + **una
  captura mirada**. El `d1` de la fase anterior encontró un bug que el build no vio.
- **Cross-review obligatoria**: el que implementa no se revisa. Los paquetes de
  DeepSeek los revisa un modelo free, y al revés.
- **El arnés tiene que saber fallar.** Su camino de error se prueba a propósito
  (`--budget-s 3`): un arnés cuyo fallo no probaste no está probado.
- Nada se declara por compilar.

## Riesgos conocidos

- Los cuatro workers comparten árbol de trabajo: un `typecheck` ve los archivos a
  medio escribir de los otros tres. Está mitigado con dueños disjuntos, no eliminado.
- `vite build` concurrente escribe el mismo `dist/`. No afecta a los tests; puede dar
  un error confuso dentro de un worker.
- **Un worker que levanta un servidor puede morir por SIGINT si otro proceso pelea por el
  mismo puerto.** `v4-jugador` terminó con exit 130 *después* de entregar todo su código y
  sin llegar a la captura. Lección: un puerto por worker, y elegirlo libre antes de
  levantarlo, en vez de asumir 5173.
- `output/` está en `.gitignore`: la evidencia de las capturas vive en disco, no en git. Es
  la convención del repo (coherente con la reescritura de historia que bajó `.git` a
  3,7 MB), pero un `git clean -x` se la lleva.
- **`objective_preview.html` quedó suelto en la raíz** del repo (herramienta de preview de
  v3). Es inofensivo para el build, pero es basura en la raíz: hay que reubicarlo.
- FASE C depende de que la física aguante 1,7 km de pista con p95 18°. Si se traba, es
  un **hallazgo** que hay que reportar, no un fracaso del arnés.
- Las capturas pueden salir negras si la cámara no queda cableada en la integración.
