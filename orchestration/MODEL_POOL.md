# Pool de modelos — Montes de Oca: Offroad Stories

Registro explícito de qué modelos puede usar el orquestador en este proyecto y para qué.
Existe porque hasta ahora el pool era **implícito** (se deducía de `workers.tsv`), y un pool
implícito no se puede auditar ni respetar.

Complementa la tabla de asignaciones del orquestador global
(`~/.config/opencode/opencode.json` → `agent.sdd-orchestrator.prompt`). **Si hay conflicto, el
pool de este archivo manda para el trabajo de este proyecto.**

## Política de costos (objetivo de reparto, no decoración)

| Banda | Cuota objetivo |
| --- | --- |
| Muse Spark free | 50–60% |
| MiMo free | 20–30% |
| DeepSeek Flash | 15–25% |
| Modelos fuertes (Kimi / Qwen / Grok) | <10% |
| OpenAI / GPT-6 Astra | **0%** — no autorizado |
| Codex / `codex-orch` | **0%** — no autorizado |

El reparto se audita contra `workers.tsv`, que registra el modelo real de cada worker.

## Roster

| Modelo | Coste | Banda | Para qué |
| --- | --- | --- | --- |
| `opencode/muse-spark-1.3-contributor-free` | 0 | free | Exploración, auditoría, redacción, data. El caballo de tiro. |
| `opencode/mimo-v2.6-flash-free` | 0 | free | Igual que Muse, más volumen de datos y consultas geo. |
| `opencode/space-bunny-free` | 0 | free | **Nuevo.** Trabajo mecánico y cross-review. Variantes de esfuerzo. |
| `opencode-go/deepseek-v4.1-flash` | bajo | flash | Implementación de código: el coder por defecto. |
| `opencode-go/kimi-k2.7-code` | alto | fuerte | Escalación: sólo con motivo concreto y escrito. |
| `opencode-go/qwen3.8-max` | alto | fuerte | Escalación. |
| `opencode-go/grok-4.7` | alto | fuerte | Escalación. |

## Space Bunny Free — lo que verifiqué

No se cablea un modelo sin probarlo. Comprobado en esta sesión:

| Comprobación | Resultado |
| --- | --- |
| `opencode/space-bunny-free` responde | OK (exit 0) |
| `opencode-go/space-bunny-free` responde | OK (exit 0) |
| Sufijo de variante `#low` | OK (exit 0) |
| Sufijo de variante `#high` | OK (exit 0) |
| Coste declarado | 0 input / 0 output en ambos providers |

Variantes disponibles: `low`, `medium`, `high`, `xhigh`, `max`. Se pasan con sufijo:
`opencode/space-bunny-free#low`.

**Criterio de uso**: `#low` o `#medium` para trabajo puramente mecánico (reformateos, refactors
repetitivos, normalización de datos, revisión de listas de verificación). Subir el esfuerzo si la
tarea requiere criterio. **No** usarlo en decisiones de arquitectura: para eso están Muse/MiMo con
contexto completo o se escala.

## Reglas de despacho

1. **Un worker por archivo.** Dos workers nunca escriben el mismo archivo. Los archivos compartidos
   tienen un único escritor.
2. **Quien implementa no revisa.** El cross-review lo hace otro modelo, aunque sea de la misma banda
   de coste. Es gratis tener revisión independiente: usarla.
3. **Escalación con motivo escrito.** Si se escala a Kimi/Qwen/Grok, el motivo va en el packet.
   "No me salió" no es motivo.
4. **El veredicto del worker no es la validación.** Un worker dice `status: ok`; el orquestador
   verifica por su cuenta. Ya pasó dos veces en este proyecto que el resumen del worker era
   correcto pero incompleto, y una vez que un invariante "fallaba" y era redondeo a milímetros.

## Cómo verificar que un modelo sirve antes de despacharlo

```bash
timeout 100 opencode run -m "<provider>/<modelo>" --auto \
  "Responde unicamente con la palabra OK y nada mas."
```

Si no devuelve `OK` con exit 0, no se despacha. Barato y evita una corrida perdida.
