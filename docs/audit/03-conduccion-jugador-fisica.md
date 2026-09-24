# Auditoría 03 — Conducción, jugador y física del vehículo

Repo referencia: `/home/kiri_/projects/montes-de-oca` (READ-ONLY). Proyecto: Montes de Oca Offroad (DEM real, superficies ASPHALT/GRAVEL/DIRT/GRASS).

## 1. Modelo de vehículo: ecuaciones exactas de `stepCar`

Fuente completa: `src/driving.ts:2-16`. Estado y firma:

```ts
export type CarState={x:number;z:number;yaw:number;speed:number;steer:number;distance:number}; // driving.ts:2
export function stepCar(s:CarState,input:{throttle:number;steer:number;handbrake:boolean},dt:number,grip=1){ // driving.ts:6
```

Entradas: `throttle ∈ [-1,1]`, `steer ∈ [-1,1]`, `handbrake: boolean`, `dt` clampado a `[0,.05]` (`driving.ts:7`), `grip=1` (default, **ningún llamador lo pasa** — ver §3).
Estado: posición 2D `(x,z)`, `yaw`, velocidad escalar `speed` (m/s de juego), ángulo de rueda `steer`, odómetro `distance`. **No hay `y`, `vy`, pitch, roll, ni velocidad lateral.**

Ecuaciones (una por línea, `v = s.speed` previo):

1. Rueda con lag de primer orden y límite dependiente de velocidad (`driving.ts:7`):
   `desired = steer_input·0.48/(1+|v|·0.026)`; `s.steer += (desired−s.steer)·min(1,dt·7)`.
2. Fuerza longitudinal (`driving.ts:8-12`):
   - `throttle≥0 → throttle·9`; `throttle<0 → throttle·18` si `v>1`, si no `throttle·5`; reversa-forzada `force=18` si `throttle>0 && v<−.5`.
   - Arrastre: `force −= v·0.038 + v·|v|·0.0022` (lineal + cuadrático).
   - Coast: `−sign(v)·min(|v|/dt, 0.8)`; freno de mano: `−sign(v)·min(|v|/dt, 10)`.
3. Integración Euler explícito (`driving.ts:13`): `s.speed = clamp(v+force·dt, −10, 53·grip)`.
4. Guiñada cinemática tipo bicicleta sin deslizamiento (`driving.ts:14`):
   `s.yaw += s.speed/3.2·tan(s.steer)·dt·(handbrake?1.3:1)` — `3.2` = batalla implícita.
5. Traslación (`driving.ts:15`): `x += sin(yaw)·speed·dt; z += cos(yaw)·speed·dt`.

Timestep: **no hay timestep fijo ni substepping dentro de `stepCar`**; el `dt` es el del frame, clampado a 0.05 s (`driving.ts:7`, `city-autopilot.ts:294` hace lo mismo). El único substepping existe **fuera**, en la resolución de colisión de `city-world.ts:509` (avanza por tramos de ≤0.7 m para no tunelar). Autopilot predice con `stepCar(..., .05)` a 20 Hz (`city-autopilot.ts:194,277`).

Entrada manual: `manualSteeringInput(direction,speed)` = `clamp(dir)·(0.76−0.22·min(1,|v|/26))` (`driving.ts:5`); bindeo de teclas en `city-world.ts:503-504` (W/S throttle ±1, A/D steer ±1, Space handbrake; autopilot cancela ante input manual, `city-world.ts:204,505`).

## 2. ¿Gravedad, pendiente, pitch/roll? — NO. Modelo 2D sobre plano ★

**Respuesta sin ambigüedad: `stepCar` ignora por completo la altura del terreno. No hay término de gravedad, ni fuerza por pendiente, ni pitch/roll en la dinámica. El auto es un punto 2D (x, z, yaw, speed); la Y se pega después, fuera de la física, como efecto visual.**

Evidencia:

- `stepCar` (`driving.ts:6-16`) no recibe `heightAt`, ni `y`, ni normal del terreno, ni pendiente. Ninguna de sus 10 líneas menciona altura.
- La Y se asigna **después** de integrar, en `city-world.ts:513`:
```ts
const ground=this.groundHeight(s.x,s.z);
this.car.position.set(s.x,ground+.115+Math.sin(this.time*7)*Math.min(.008,Math.abs(s.speed)*.0004),s.z);
```
  Offset constante `+.115` (en puentes/vías usa `.14` para tráfico, `traffic.ts:23,29`). El micro-bob `sin(time·7)` es cosmético.
- El "pitch" es **puramente visual**, calculado por diferencias de altura fuera del integrador (`city-world.ts:513`):
```ts
const front=this.groundHeight(s.x+Math.sin(s.yaw)*1.5,s.z+Math.cos(s.yaw)*1.5),
      rear=this.groundHeight(s.x-Math.sin(s.yaw)*1.5,s.z-Math.cos(s.yaw)*1.5);
this.car.rotation.set(-Math.atan2(front-rear,3),s.yaw,-s.steer*s.speed*.0025);
```
  Roll = `-steer·speed·0.0025`, también cosmético (inclinación en curva, no vuelco).
- Consecuencia física: en una cuesta del DEM el auto subiría a la misma velocidad que en llano (fuerza de tracción `9·throttle` sin componente `−g·sin(θ)`), no rodaría hacia atrás al soltar el acelerador (el coast `0.8` es fricción constante, no gravedad), y en ladera lateral no deslizaría ni volcaría: el modelo ni siquiera tiene lateralidad.

Nota: el terreno **sí** existe como sampler (`groundHeight` compuesto por capas: landmark detail → montañas → ground-relief → puentes, `city-world.ts:250,261`; el auto Y lo lee de ahí), y el peatón a pie usa `heightAt` con tolerancia de escalón (`.48`/`.55` m, `city-walk.ts:21,48`), pero el coche no consulta pendiente en ningún punto de su dinámica.

## 3. Agarre / superficie: parámetro muerto, superficie solo visual

- `stepCar(..., grip=1)` solo aparece en el tope de velocidad: `clamp(v+force·dt, −10, 53·grip)` (`driving.ts:13`). **Ningún llamador pasa `grip`**: `city-world.ts:507` (`stepCar(this.state,this.drivingInput,dt)`), `city-autopilot.ts:194,277` (probes sin grip). El agarre real es, por tanto, constante e igual a 1 en todo el mapa.
- No hay fricción por superficie en `driving.ts`, `traffic.ts`, `navigation.ts` ni `city-autopilot.ts` (grep `friction|surface.*grip|surfaceAt` sin resultados en física; solo `ROAD_CRUISE` por `road.kind`, `city-autopilot.ts:23,355`).
- `src/city-road-surface.ts` es **100% sombreado**: plugin `AsphaltDryFilm` que ajusta albedo/roughness/specular por modo día/atardecer/noche y lluvia (`city-road-surface.ts:14-23,79-85`), con texturas normal/ORM. No expone ninguna función de consulta de superficie ni alimenta la física. La detección `offroad` de `city-world.ts:502` (`!n || n.d > width/2+1`) solo alimenta el **audio** (`audio.update({...,offroad:this.offroad})`, `city-world.ts:536`), no la dinámica.
- Dificultad de agregar ASPHALT/GRAVEL/DIRT/GRASS: **baja-moderada**. El gancho natural es el 4º parámetro `grip` ya existente + una función `surfaceAt(x,z) → coeficiente` (el repo nuevo tiene DEM + máscara de superficies por diseñar). Pero el `grip` actual solo escala `vmax`, no tracción/frenada/lateral; para tierra suelta creíble habría que tocar `force` (tracción y frenada por superficie) y el `tan(steer)` (derrape), no solo el tope. Estimación: 1–2 días para grip→tracción/frenada/vmax + polvo por superficie; el derrape lateral exige estado lateral nuevo (ver §9).

## 4. Colisión (`CityCollision`, `driving.ts:20-36`)

- Índice espacial: segmentos viales en celdas de 90 m (`cells`, `driving.ts:21,25`), anillos de edificios en `bCells` (`driving.ts:27`).
- `nearest(x,z)` (`driving.ts:29`): solo busca **en la celda propia** (sin vecinas) — segmentos largos se duplican en celdas ±1 al construir (`driving.ts:25`), truco que funciona para viales continuos pero es frágil en pistas aisladas.
- `blocked(x,z)` (`driving.ts:30-35`):
```ts
if(near&&near.d<near.road.width/2-.65)return false;          // sobre calzada: libre
// ... anillos de edificios (inRing + distancia <1.15), landmarks altos ...
return !this.data.land.some(...) || this.data.water.some(...); // tierra vs agua
```
  Lógica: exención sobre calzada → edificios → landmarks → **dentro de tierra Y fuera de agua**.
- Qué se rompe en mapa rural sin edificios: nada catastrófico, pero (a) `bCells`/landmarks quedan vacíos = costo inútil, no error; (b) `blocked` depende de polígonos `land`/`water` (`driving.ts:34`): sin `land` que cubra el DEM, **todo fuera de calzada = bloqueado** y el off-road sería imposible — hay que poblar `land` con el extent del DEM o invertir la regla; (c) el radio de exención `width/2−.65` con pistas de 3 m deja ~0.85 m de margen — razonable; (d) el mundo además frena contra tráfico/peatones/props (`city-world.ts:509-511`), subsistemas que en rural se simplifican o eliminan.

## 5. Altura / snap: fuera de `stepCar`

- Dentro de `stepCar`: **nada** (ver §2).
- Fuera, en el frame (`city-world.ts:513`): `groundHeight(x,z)+.115` + pitch visual por `front−rear`. `walkingSurfaceHeight` (`city-world.ts:318-328`) añade `+.105` sobre calzada / `+.065` sobre acera — el comentario lo dice explícito: *"as the vehicle already does for wheels"* (`city-world.ts:323`).
- Tráfico NPC: `heightAt(x,z)+.14` en `traffic.ts:23,29`; ebikes `+.01` (`city-ebikes.ts:86,91`); peatones `groundY` solo para impacto (`city-world.ts:510`).
- `groundHeight` es cadena de samplers (detail → mountains → relief → coastal/puentes, `city-world.ts:250`; café añade `floorAt`, `city-world.ts:261`). En el proyecto nuevo colapsa a **un sampler DEM + offset de calzada**.

## 6. Grafo vial + AI (`navigation.ts`, `traffic.ts`, `city-autopilot.ts`)

- `RoadGraph` (`navigation.ts:2-4`): de `roads[].points` crea nodos con cuantización **3 m** (`Math.round(p/3)`) y aristas bidireccionales con longitud euclídea. Acepta además grafo precocido `{nodes, edges}` (`navigation.ts:4`). `nearestEdge`/`route` = Dijkstra con heap propio (`navigation.ts:6-18`); autopilot usa su propio A* con replanificación por tramos (`city-autopilot.ts:94-127`) + densificación a pasos de 4 m (`city-autopilot.ts:135`).
- `CityTraffic` (`traffic.ts:4-32`): 40 coches en aristas con `edges[i].size>1` a 14–600 m del jugador (`traffic.ts:14-16`), velocidad constante `7–13` m/s (`traffic.ts:16`), avance paramétrico `t += dt·speed/len` con frenada por semáforo (`signalHold`) o coche a <8 m delante (`traffic.ts:26`), giro con preferencia a seguir recto + jitter (`traffic.ts:27`), offset lateral fijo `+1.15` (conducción por derecha, `traffic.ts:28`), respawn si el jugador se aleja >450 m (`traffic.ts:26`).
- ¿Funciona en pistas rurales? **Sí, con condiciones**: el grafo no asume topología urbana (cualquier polilínea vale; `service`/`unclassified` ya existen como kinds), pero (a) necesita nodos con grado ≥2 para spawnear (`traffic.ts:14`) — una pista lineal sin cruces apenas genera tráfico; (b) `directionAllowed` usa `oneway` + `nearest().yaw` (`city-world.ts:295`) — en rural casi todo es bidireccional, simplificar; (c) velocidades `ROAD_CRUISE` por kind (`city-autopilot.ts:23,355`) hay que recalibrar para pista (service=10 ya sirve de base); (d) `place()` respawnea por distancia al jugador — en un valle lineal funciona igual.

## 7. Controles y cámara del jugador

- Bindeo: `keydown` global en `city-world.ts:204` — WASD/flechas conducir, Space freno, `Enter/Space` (modo tanque), `F` caminar (`toggleWalking`), `C` vista (coche) / 1ª-3ª persona (a pie), `R` volver a vía (`resetRoad`), `V` foto, `B` vuelo, `T` tanque, `G` dron, `L` luces, `Y` lluvia. `wheel` = zoom a pie (`city-world.ts:217`). Cualquier input de conducción cancela autopilot (`city-world.ts:204,505`; `cancel()` en `city-autopilot.ts:85-86`).
- Cámaras (`city-world.ts:517-534`): `view 0` persecución (`−8.6`, h `1.75`, lookahead `+5`, `city-world.ts:517-519`), `view 1` **cabina** (`CITY_DRIVER_POSE` pos `[0,1.12,.05]` look `[0,1.08,18]`, `city-cockpit.ts:3`; cámara pegada al `car.computeWorldMatrix`, `city-world.ts:533`), `view 2` panorámica (`−18`, h `9`). Cabina = geometría derivada del GLB (tablero, volante que gira `rotor.rotation.z = −steer·2.6`, display 1024×384 a ≤10 Hz, `city-cockpit.ts:59-77,93-102`).
- A pie (`city-walk.ts:7-56`): estado independiente del coche; salir exige `|speed|<1` y puerta libre con escalón ≤.55 m (`exitCar`, `city-walk.ts:16-25`); entrar radio 5 m + senda libre (`canEnter`, `city-walk.ts:26-36`); WASD + flechas giran `yaw/pitch`, Shift corre (`1.6/4.2` m/s, `city-walk.ts:2-3,39-53`); ojo a `heightAt+1.53` (`city-walk.ts:55`). Avatar esquelético con blend idle/walk/run (`city-rider.ts:64-77`).
- Vehículo visual: GLB `car` + ruedas con pivote en `wheelCentresGltf` y `wheelRadius` del manifest (`city-world.ts:264`, `city-vehicle-manifest.ts:4-10`); giro `rotation.x = wheelSpin`, delanteras `rotation.y = −steer` (`city-world.ts:513`); materiales hero (pintura/cristal/cromo, `city-vehicle-materials.ts:6-25`) y matrícula proyectada (`city-vehicle-finish.ts:9-102`) — todo cosmético, reutilizable tal cual para otro GLB.

## 8. Veredicto de reutilización por subsistema

| Subsistema | Veredicto | Justificación |
|---|---|---|
| `stepCar` (longitudinal + yaw bicicleta) | **REWRITE** (conservar firma/arquitectura) | Sin gravedad/pendiente/lateral (§2); sirve como esqueleto (entradas, lag de dirección, coast, topes) pero la física off-road exige término `−g·sinθ`, modelo lateral y superficies. |
| `CityCollision` (índice + `blocked`) | **REUSE-WITH-PARAMS** | Lógica válida; poblar `land` con extent DEM, quitar edificios/landmarks, revisar `nearest` monocelda y margen `width/2−.65` para pistas de 3 m. |
| Snap de altura + pitch/roll visual | **REUSE-WITH-PARAMS** | `groundHeight+.offset` + `atan2(front−rear)` (`city-world.ts:513`) funciona sobre DEM; añadir roll lateral por pendiente + suspensión (media de 4 ruedas, no 2 puntos). |
| `RoadGraph` + `route` | **REUSE-AS-IS** | Agnóstico a topología; cuantización 3 m y Dijkstra valen para pistas. Solo recalibrar `ROAD_CRUISE` y kinds rurales. |
| `CityTraffic` NPC | **REUSE-WITH-PARAMS** | Funciona en grafo rural; bajar densidad/velocidad, simplificar `directionAllowed`, aceptar pistas lineales (grado 1). Opcional para MVP. |
| `CityAutopilot` (controlador puro) | **REUSE-WITH-PARAMS** | Puro y testeable (`city-autopilot.ts:25-28`); reutilizar `plan/ahead/clearance`; retocar velocidades de curva y `poseClear` (tolerancia off-road), y añadir coste por superficie. |
| Controles + cámaras + cabina | **REUSE-AS-IS** | Bindeo, ciclo de vistas, `CITY_DRIVER_POSE`, volante/instrumentos funcionan con cualquier GLB 4x4. Solo re-anclar pose del conductor. |
| Walk/exit/enter + rider | **REUSE-AS-IS** | `exitCar/canEnter/step` + tolerancias de escalón ya resuelven "bajar al objetivo e interactuar". Reutilizar sin cambios. |
| Materiales/acabado/road-surface | **REUSE-AS-IS** ( diferido ) | Cosmética del hero y asfalto cinematográfico; para MVP rural priorizar fango/polvo sobre clearcoat. `city-road-surface.ts` no toca física. |

## 9. Huecos off-road: qué hay que construir

1. **Fuerza por pendiente (`−m·g·sinθ`)** — NO EXISTE. `stepCar` no recibe pendiente (`driving.ts:6-16`). Construir: muestrear `heightAt` delante/detrás (patrón ya usado en `city-world.ts:513`), `θ=atan2(Δh,Δs)`, restar `g·sinθ` a `force`. Base: el sampler `groundHeight` + el snippet de pitch.
2. **Gravedad lateral en ladera / deslizamiento** — NO EXISTE (velocidad escalar, sin lateral). Construir: estado lateral (modelo bicicleta con sideslip) o al menos deriva `−g·sinφ` lateral. Base: ninguna en dinámica; solo el roll cosmético (`city-world.ts:513`).
3. **Pitch/roll dinámico + suspensión** — Solo visual y con 2 puntos (`city-world.ts:513`). Construir: 4 alturas de rueda (usar `wheelCentresGltf`, `city-vehicle-manifest.ts:4-10`), pitch/roll por plano de apoyo + spring visual por rueda, reteniendo `rotation.x=wheelSpin` (`city-world.ts:513`).
4. **Contacto de ruedas / despeque / altura libre** — NO EXISTE (snap rígido `+.115`). Construir: comparar plano de ruedas vs chasis; opcional: airborne si las 4 pierden contacto. Base: `groundHeight` + offsets de calzada (`city-world.ts:318-328`).
5. **Torque en reducida / marchas** — NO EXISTE (una curva `9·throttle`, vmax 53 m/s ≈ 190 km/h, `driving.ts:8,13`). Construir: modo 4L (más fuerza a baja velocidad, vmax ~8-12 m/s) + primera corta para subir. Base: constantes de `force` y `ROAD_CRUISE` por kind (`city-autopilot.ts:23`).
6. **Fricción por superficie (ASPHALT/GRAVEL/DIRT/GRASS)** — NO EXISTE (grip muerto, §3). Construir: `surfaceAt(x,z)` + tabla (tracción, frenada, vmax, derrape). Base: parámetro `grip` + detección `offroad` (`city-world.ts:502`) + kinds viales (`city-types.ts:2`).
7. **Polvo/barro/fango visual y sonoro** — Parcial: hay `offroad`→audio (`city-world.ts:536`) y charcos de lluvia (`city-rain-puddles.ts`), pero nada de polvo en suspensión ni salpicadura. Construir: emisor de partículas por superficie/velocidad + huella. Base: hook `offroad` + `speed`.
8. **Riesgo de vuelco** — NO EXISTE (roll cosmético `-steer·speed·.0025`). Construir: criterio `|a_lat·h_cg| vs vía` con pendiente lateral, aviso + vuelco visual. Base: ninguna; estado lateral del punto 2 es prerrequisito.
9. **Colisión rural (rocas, árboles, taludes, agua)** — Parcial: `blocked` cubre edificios/agua/tierra (`driving.ts:30-35`) pero no props discretos (árboles/rocas van por `propBlocked`/`canopy.trunkNear`, `city-world.ts:298,267`). Construir: capa de obstáculos discretos + talud intransitable por pendiente (>~30° bloquea a pie: umbral `.48` m existe en `city-walk.ts:48`; extender al coche).
10. **AI/tráfico en pista de tierra** — Parcial: grafo y tráfico funcionan (§6) pero asumen calzada ancha y semáforos. Construir: velocidades de pista, sin `signalHold`, comportamiento de encuentro en vía estrecha (apartarse). Base: `CityTraffic` + `directionAllowed` (`city-world.ts:295`).

Orden sugerido MVP: 1 (pendiente) → 6 (superficies) → 5 (reducida) → 3 (suspensión visual) → 9 (obstáculos) → 2+8 (lateral/vuelco) → 7 (polvo) → 10 (AI rural).

## Confianza

- **Alta**: ecuaciones `stepCar` (§1), ausencia de gravedad/pendiente (§2, snippet citado), snap de Y fuera del integrador (§5), `grip` muerto (§3), `CityCollision` (§4), grafo/tráfico (§6), controles/cámaras (§7). Todo con `archivo:línea` verificada por lectura directa.
- **Media**: calibración exacta de `ROAD_CRUISE`/costos autopilot en pista (requiere prueba con DEM real); costo de polvo/partículas (depende del pipeline del proyecto nuevo).
- **UNKNOWN**: parámetros finales del DEM (resolución, pendiente máxima de la pista) — el diseño de la reducida y del criterio de vuelco dependen de esos números; no se pudieron determinar desde el repo de referencia.
