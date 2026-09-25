# PACKET r1-revision-critica — segunda opinión independiente (solo lectura)

## GOAL
Revisión **adversarial** del bucle jugable de la milestone 1, hecha por una familia de modelos DISTINTA de la que escribió el código. No venís a aprobar: venís a encontrar lo que el autor no ve.

## CONTEXT
Juego 3D de off-road rural sobre Babylon.js 8 + TypeScript + Vite. El bucle es:
`Villafranca → carretera (ROAD) → pista (TRACK) → objetivo → bajar del 4x4 → mantener E → reparar → volver → COMPLETED`.

El código lo escribió DeepSeek/OpenCode, con un orquestador integrando. Ya hay un arnés que corre el bucle entero en Chrome headless y da 24/24. **Eso es exactamente el problema a atacar**: si el arnés dice que todo está bien, ¿qué es lo que el arnés NO mira?

## QUÉ REVISAR (leé el código; no confíes en los comentarios ni en este packet)
- `src/main.ts` — integración: spawn, loop de render (tiene 3 caminos: `manualStep`, `manualInput`, jugador), envoltorio de input, API de depuración `window.__game`, HUD.
- `src/player/index.ts`, `src/player/movement.ts`, `src/player/controls.ts` — teclado, entrar/salir del 4x4, movimiento a pie.
- `src/gameplay/mission.ts`, `objective.ts`, `interact.ts` — máquina de estados, radios de alcance, progreso de reparación.
- `scripts/milestone/drive_milestone.mjs` — el arnés. **Preguntate si verifica lo que dice verificar.**
- `index.html` — HUD.

## BUSCÁ ESPECÍFICAMENTE ESTO (es lo que vale)
1. **Bugs de entrada, del tipo que ya apareció**: un flanco o tecla que se levanta y nadie consume; dos lectores de la misma tecla; estado que queda pegado entre frames o entre cambiar de modo.
2. **Agujeros de la máquina de estados**: ¿se puede completar sin reparar? ¿se puede reparar desde el coche? ¿qué pasa si bajás y subís lejos del objetivo? ¿si apretás F dos veces en el mismo frame? ¿si mantenés E y caminás? ¿si recargás la página a mitad de misión?
3. **Lo que cambia en el navegador REAL y no en el arnés**: el arnés avanza el mundo a mano con `player.step(seconds, dt)` y un `dt` fijo de 1/60. En el navegador es `requestAnimationFrame` con `dt` variable, teclado real, 60–120 fps, y pestañas que se ocultan. Decí **qué se le escapa al arnés por eso**.
4. **HUD**: ¿le dice al jugador qué hacer en cada estado? ¿el prompt de tecla aparece cuando corresponde?
5. **`exactOptionalPropertyTypes: true`** está activo y el proyecto es estricto: ¿ves algo que rompa con eso?

## NO HAGAS
- **No modifiques NINGÚN archivo.** Sos de solo lectura.
- **No corras builds, servidores ni tests largos.** Si querés correr algo, que sea de lectura.
- No reportes estilo, formato ni refactors ("podrías extraer una función"). Solo bugs, riesgos y huecos de verificación.

## DELIVERABLE (máximo 25 líneas)
Tabla ordenada por severidad:

| SEVERIDAD | archivo:línea | qué pasa | cómo se reproduce | por qué el arnés no lo ve |
|---|---|---|---|---|

Severidades: CRÍTICO (rompe el bucle o el juego) · ALTO (se nota jugando) · MEDIO (rincón raro).
Si no encontrás nada crítico, **decilo**. No inventes hallazgos para llenar la tabla: un informe vacío y honesto vale más que uno inflado.
