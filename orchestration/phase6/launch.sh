#!/usr/bin/env bash
# Lanza un worker en un proceso aparte y deja rastro auditable.
#   orchestration/phase6/launch.sh <nombre> <modelo> <packet.md>
#
# Por qué un script y no un comando suelto: el registro en `workers.tsv` es lo que
# permite auditar después el reparto real de modelos contra la política de costos
# (`orchestration/MODEL_POOL.md`). Un lanzamiento a mano no deja rastro.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

N="${1:?usage: launch.sh <nombre> <modelo> <packet.md>}"
M="${2:?falta el modelo}"
P="${3:?falta el packet}"

mkdir -p orchestration/logs
printf '%s\t%s\t%s\t%s\n' "$N" "$M" "$P" "milestone1" >> orchestration/workers.tsv

echo "[launch] $N model=$M"
timeout 7200 opencode run -m "$M" --auto "$(cat "$P")" >"orchestration/logs/$N.log" 2>&1
echo $? >"orchestration/logs/$N.exit"
echo "[done] $N exit=$(cat "orchestration/logs/$N.exit")"
