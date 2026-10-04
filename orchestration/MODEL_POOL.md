# Pool de modelos — Montes de Oca: Offroad Stories

Política vigente de despacho. Complementa `AGENTS.md` (reglas permanentes), `OBJECTIVE.md`
(backlog actual) y `orchestration/ORQUESTADOR-PRINCIPAL.md` (metaprompt activo).
Ante una configuración global de OpenCode distinta, esta política rige el trabajo de este
proyecto; no edites la configuración global para aplicarla. Las instrucciones del usuario y
del entorno de ejecución tienen precedencia. Ningún prompt puede revocar `AGENTS.md`.

## Roles y vías de ejecución

| Rol | Modelo / herramienta | Responsabilidad |
| --- | --- | --- |
| Orquestador principal | GPT-6.1 Sol / Codex | Prioridades, arquitectura, packets, ownership, integración, verificación final, ACCEPT / FIX / REVERT y commits. Puede resolver cambios pequeños, archivos compartidos y conflictos. |
| Analista / reviewer | GPT-6 Luna / Codex | Exploración profunda, debugging, Babylon.js, diseño técnico, rendimiento y revisión independiente. No decide la aceptación final. |
| Implementador | OpenCode | Implementaciones acotadas, refactors y tests dentro del ownership; seleccionar un modelo realmente disponible y registrar su identificador. |
| Worker gratuito prioritario | WorkBuddy AI + DeepSeek V4.1 Flash | Inventarios, búsquedas, normalizaciones, documentación, transformaciones repetitivas y cambios mecánicos aislados con contrato cerrado. No arquitectura ni integración transversal. |

## Coste y selección

- Prioriza **WorkBuddy AI + DeepSeek V4.1 Flash** para trabajo mecánico/aislado si la cuenta
  del usuario confirma acceso gratuito, cuota y modelo disponibles. Esta condición fue
  indicada por el usuario; no es una comprobación de precios ni de disponibilidad realizada
  por este documento. No actives consumo de pago como fallback automático.
- OpenCode conserva la implementación que requiere contexto de código o razonamiento;
  Luna concentra análisis/review y Sol coordinación/integración. No hay cuotas porcentuales
  obligatorias: el coste se evalúa según la vía real y el trabajo asignado.
- `opencode-go/deepseek-v4.1-flash` es una vía OpenCode distinta de WorkBuddy. No se registra
  como gratuita por usar el mismo nombre de modelo.
- Muse/MiMo/Space Bunny y Kimi/Qwen/Grok de los packets históricos no constituyen el pool
  prioritario actual. Reutilizarlos requiere disponibilidad comprobada y motivo en el packet;
  cualquier coste adicional requiere autorización previa del usuario.
- Si WorkBuddy no está disponible, reporta el bloqueo. Reasigna solo a una vía autorizada
  que respete ownership, coste y verificación. No inventes IDs de proveedor ni comandos.

## Ownership y despacho

1. **Un writer por archivo**, también para salidas generadas, reportes y logs. Antes del
   despacho, Sol expande globs a rutas concretas y comprueba todos los packets activos y
   `git status`. Si se comparte una ruta o dependencia, serializa el trabajo. Los reviewers
   leen sin escribir código; su informe tiene una ruta exclusiva.
2. Cada packet se guarda en `orchestration/phaseN/<id>.md` e incluye modelo/vía real, contexto
   cerrado, baseline (HEAD y diff inicial relevante), archivos propios, prohibiciones,
   dependencias, contratos, comandos exactos, resultado esperado y formato de reporte.
3. Solo Sol escribe `orchestration/workers.tsv`. Mantener las cuatro columnas existentes:
   `worker`, `modelo`, `packet`, `fase`. Añadir una fila por despacho real, nunca por planes
   ni pruebas de conectividad. No reescribir las filas históricas.
4. En la columna `modelo`, registrar herramienta y modelo **observados**. Para WorkBuddy:
   `WorkBuddy AI / DeepSeek V4.1 Flash` si la interfaz confirma ese modelo. Es una etiqueta
   de auditoría, no un ID invocable. Para Codex registrar GPT-6.1 Sol o GPT-6 Luna junto al
   ID real mostrado por el entorno; para OpenCode usar su `provider/model` real.
5. Documentar en el packet los estados PREPARED / RUNNING / REVIEW / ACCEPTED / FIX /
   BLOCKED / REVERTED, el modo de entrega y la evidencia. Solo Sol actualiza estos estados;
   reserva ownership hasta que el worker haya parado y Sol libere explícitamente las rutas.
6. Quien implementa no revisa su propio resultado. Luna hace el cross-review y Sol reproduce
   los gates pertinentes y revisa el diff antes de aceptar. REVERT afecta exclusivamente
   cambios del packet; nunca usar reset/checkout sobre modificaciones ajenas.

## Uso de WorkBuddy AI

Abrir el checkout WSL correcto mediante la vía soportada por la instalación del usuario,
seleccionar DeepSeek V4.1 Flash y confirmar acceso gratuito. Si no accede al checkout,
entregar el packet y recibir un patch/reporte para que Sol lo integre: el worker no escribe
el repo en ese modo. El packet debe declarar quién escribe las rutas finales y dónde se
guarda el patch; nunca conceder dos writers a la vez.

No se ha verificado aquí una CLI/API de WorkBuddy ni se presupone que exista. El launcher
`orchestration/phase6/launch.sh` ejecuta **solo OpenCode** y escribe el registro; no usarlo
para WorkBuddy ni lanzarlo concurrentemente con otros writers del registro. Para nuevos
despachos, Sol registra la fila y coordina la ejecución por la vía real disponible.

Antes de una corrida larga, comprobar una respuesta mínima y el modelo seleccionado en la
herramienta real. No afirmar que el worker está conectado por haber redactado el packet.

## Historia y arranque

`phase0`…`phase6`, `run-phase0.sh`, los logs y las filas previas de `workers.tsv` documentan
ejecuciones anteriores. No relanzarlas automáticamente: sus modelos, backlog y ownership
deben revisarse contra esta política y `OBJECTIVE.md`. `status.sh` muestra procesos/logs de
OpenCode; no demuestra actividad de WorkBuddy ni de Codex. No existe un MASTER_PROMPT
separado: usar el metaprompt activo citado arriba, sin duplicarlo.
