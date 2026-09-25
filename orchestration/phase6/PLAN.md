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

- [x] **A** · ruta definida desde OSM + pendiente real, verificada en `npm test`
- [ ] **B** · aparición jugable: 4x4 apoyado y orientado a la vía, con instrucción mínima
- [ ] **C** · conducción de extremo a extremo **medida** (no mirada)
- [ ] **D** · vegetación FOREST/GRASS/FIELDS con corredores y spawn/objetivo libres
- [ ] **E** · Villafranca low-poly desde footprints OSM, sin casas flotando
- [ ] **F** · personaje: caminar, correr, entrar/salir del 4x4
- [ ] **G** · instalación ficticia de telecomunicaciones + interacción (E)
- [ ] **H** · misión REPETIDOR SIN SEÑAL, 6 estados
- [ ] **I** · atmósfera mínima: cielo, niebla, sol, sombras razonables
- [ ] · integración en `src/main.ts` + HUD de misión (orquestador)
- [ ] · arnés de validación punta a punta con capturas y camino de error probado
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
- FASE C depende de que la física aguante 1,7 km de pista con p95 18°. Si se traba, es
  un **hallazgo** que hay que reportar, no un fracaso del arnés.
- Las capturas pueden salir negras si la cámara no queda cableada en la integración.
