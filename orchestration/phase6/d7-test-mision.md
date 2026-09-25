# PACKET d7-test-mision — test de la máquina de estados de la misión

## GOAL
Escribir `scripts/gameplay/validate_mission.mjs`: un validador de Node que pruebe la
máquina de estados de `src/gameplay/mission.ts`. Es la lógica CENTRAL de la milestone
y **hoy no tiene un solo test unitario** (la cadena de `npm test` cubre terreno, vías,
ruta y datum, pero no la misión).

## CONTEXT
- `src/gameplay/mission.ts` es **PURO**: no importa Babylon. Por eso se puede transpilar
  y correr en Node. Esa decisión de diseño existe justamente para poder testearlo —
  falta el test.
- **Patrón obligatorio**: mirá `scripts/terrain/validate_terrain.mjs` y
  `scripts/gameplay/build_first_route.mjs`. Transpilan TS con el paquete `typescript` y
  llaman al módulo REAL. **NO reimplementes la lógica de la misión en el test**: si la
  reescribís, estás testeando tu copia, no el juego.
- Semántica REAL (leela del código; no la inventes ni la asumas):
  - `reachRadiusM` (default **25**) = radio de las TRANSICIONES de estado.
  - `repairRadiusM` (default **6**) = radio del interactuable: desde dónde `E` repara.
  - Bucle: `NOT_STARTED --driving--> ACTIVE --d<=reach--> TARGET_REACHED --(a pie && d<=repair && interact, durante repairSeconds)--> REPAIRED --driving--> RETURNING --d<=reach--> COMPLETED`.
  - `MissionContext` = `{ x, z, onFoot, driving, interact, dt }`.
  - `repairProgress` vale 1 desde `REPAIRED` (la baliza queda verde).

## CASOS QUE TIENE QUE VERIFICAR
Cada uno es una carta que **se rompió de verdad** o que puede romperse:
1. `NOT_STARTED → ACTIVE` sólo al conducir.
2. `ACTIVE → TARGET_REACHED` a `<= reachRadiusM` (25 m) y **no** antes.
3. `TARGET_REACHED` + `driving` + `interact:true` → el progreso **no avanza nunca**
   (reparar desde el coche no vale, y el progreso debe quedar en 0).
4. `TARGET_REACHED` + **a pie a 20 m** (dentro de reach, fuera de repair) + `E`
   mantenida → **NO repara**. Éste es el agujero recién arreglado: antes reparaba a 25 m.
5. `TARGET_REACHED` + a pie a **3 m** + `E` durante `repairSeconds` → `REPAIRED`.
6. Soltar `E` a mitad de camino **resetea** el progreso (no se puede "cocinar").
7. Al reparar, `repairProgress === 1`.
8. `REPAIRED → RETURNING` sólo al conducir.
9. `RETURNING → COMPLETED` a `<= reachRadiusM` del punto de regreso, y no antes.
10. `reset()` deja `NOT_STARTED`, `elapsedS` en 0 y el progreso en 0.
11. Los estados son **terminales donde corresponde**: `COMPLETED` no vuelve atrás.

**NO verifiques el tope de `dt`**: ese tope vive en el llamador (`src/main.ts`), no en
la misión. Si lo testearas acá estarías afirmando algo que este módulo no promete.

## FILES — OWNERSHIP
**SOS EL ÚNICO ESCRITOR DE: `scripts/gameplay/validate_mission.mjs` (archivo NUEVO).**
PROHIBIDO escribir en cualquier otro archivo. En particular **NO toques `package.json`**
(lo cablea el orquestador) ni nada bajo `src/**`. Podés leer todo.

## DELIVERABLE
- `scripts/gameplay/validate_mission.mjs`, con `exit != 0` si algún caso falla.
- Salida con el mismo estilo que los validadores existentes: una línea por caso con
  `[OK  ]` / `[FALLA]`, el valor medido y el esperado.

## VALIDATION (obligatoria; pegá las salidas crudas)
1. `node scripts/gameplay/validate_mission.mjs` → todo `[OK  ]`.
2. **Ejercitá el camino de fallo**: cambiá a mano una expectativa para que falle,
   corré, confirmá que sale con código distinto de 0, y **revertí el cambio**. Un
   validador cuyo camino de fallo nunca se corrió no es un validador: es una promesa.
   Reportá las DOS salidas y el código de salida de cada una.

## REPORTÁ AL FINAL (máximo 20 líneas)
`STATUS` · `FILES` · `TESTS` (los dos comandos + salidas crudas + exit codes) · `RISKS`.
