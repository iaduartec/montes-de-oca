#!/usr/bin/env bash
# Orquestador de workers — FASE 0 (audit) + FASE 1 (geo)
# Un worker = un task packet = un archivo de salida. Sin solapamiento de escritura.
set -uo pipefail

ROOT="/home/kiri_/projects/montes-de-oca-offroad"
LOG="$ROOT/orchestration/logs"
mkdir -p "$LOG"

# nombre | modelo | prompt
JOBS=(
  "w1-runtime|opencode/muse-spark-1.3-contributor-free|orchestration/phase0/w1-runtime.md"
  "w2-pipeline|opencode/muse-spark-1.3-contributor-free|orchestration/phase0/w2-pipeline.md"
  "w3-driving|opencode/muse-spark-1.3-contributor-free|orchestration/phase0/w3-driving.md"
  "w4-assets|opencode/muse-spark-1.3-contributor-free|orchestration/phase0/w4-assets.md"
  "w5-coupling|opencode/muse-spark-1.3-contributor-free|orchestration/phase0/w5-coupling.md"
  "w6-geo|opencode/mimo-v2.6-flash-free|orchestration/phase1/w6-geo.md"
)

cd "$ROOT"
pids=()
for job in "${JOBS[@]}"; do
  IFS='|' read -r name model prompt <<< "$job"
  echo "[launch] $name  model=$model"
  (
    cd "$ROOT"
    timeout 5400 opencode run -m "$model" --auto "$(cat "$prompt")" \
      > "$LOG/$name.log" 2>&1
    echo "$?" > "$LOG/$name.exit"
  ) &
  pids+=($!)
  sleep 3   # arranque escalonado, para no golpear el rate limit del modelo free
done

echo "[wait] esperando ${#pids[@]} workers..."
for p in "${pids[@]}"; do wait "$p"; done

echo "===== RESULTADO ====="
for job in "${JOBS[@]}"; do
  IFS='|' read -r name model prompt <<< "$job"
  code=$(cat "$LOG/$name.exit" 2>/dev/null || echo "?")
  printf "%-12s exit=%-4s log=%s\n" "$name" "$code" "$(wc -l < "$LOG/$name.log" 2>/dev/null || echo 0)"
done

echo "===== ARTEFACTOS ====="
find "$ROOT/docs" "$ROOT/data" -type f -newermt '-12 hours' 2>/dev/null | sort
