#!/usr/bin/env bash
# Estado de los workers en paralelo del proyecto Montes de Oca.
# Uso:  ./orchestration/status.sh          (resumen)
#       ./orchestration/status.sh t1       (detalle de un worker)
#       ./orchestration/status.sh -f t1    (seguir el log en vivo)
cd "$(dirname "$0")/.." || exit 1
LOGS=orchestration/logs

seguir() {
  [ -f "$LOGS/$1.log" ] || { echo "No existe $LOGS/$1.log"; ls "$LOGS"/*.log 2>/dev/null; exit 1; }
  echo ">>> siguiendo $LOGS/$1.log  (Ctrl-C para salir)"
  tail -f "$LOGS/$1.log"
}

case "$1" in
  -f) seguir "$2"; exit 0 ;;
  "") ;;
  *)  echo "═══════════════ $1 ═══════════════"
      echo "exit : $(cat "$LOGS/$1.exit" 2>/dev/null || echo 'EN CURSO')"
      echo "log  : $LOGS/$1.log  ($(stat -c%s "$LOGS/$1.log" 2>/dev/null) bytes)"
      echo "packet: $(find orchestration -name "$1*.md" 2>/dev/null | head -1)"
      echo
      echo "--- ultimas 25 lineas ---"
      tail -25 "$LOGS/$1.log" 2>/dev/null
      exit 0 ;;
esac

echo "═══ WORKERS ═══  (modelo segun orchestration/workers.tsv, no adivinado del log)"
printf '%-14s %-10s %-9s %-19s %-7s %s\n' WORKER ESTADO LOG MODIFICADO FASE MODELO
for f in "$LOGS"/*.log; do
  n=$(basename "$f" .log)
  e=$(cat "$LOGS/$n.exit" 2>/dev/null || echo "EN CURSO")
  if [ "$e" = "0" ]; then e="listo"; elif [ "$e" = "EN CURSO" ]; then e="corriendo"; else e="FALLO($e)"; fi
  b=$(stat -c%s "$f" 2>/dev/null)
  m=$(stat -c%y "$f" 2>/dev/null | cut -d. -f1 | cut -c6-)
  # join con la tabla de workers: modelo y fase salen de ahi, no del log
  mod=$(awk -F'\t' -v w="$n" '$1==w{print $2}' "$(dirname "$0")/workers.tsv" 2>/dev/null)
  fase=$(awk -F'\t' -v w="$n" '$1==w{print $4}' "$(dirname "$0")/workers.tsv" 2>/dev/null)
  printf '%-14s %-10s %-9s %-19s %-7s %s\n' "$n" "$e" "${b}B" "$m" "${fase:-—}" "${mod:-sin registrar}"
done

echo
echo "═══ PROCESOS VIVOS ═══"
if pgrep -af "opencode run" >/dev/null 2>&1; then
  pgrep -af "opencode run" | sed -E 's/.*(-m [^ ]+).*/\1/' | sort | uniq -c
else
  echo "(ninguno)"
fi

echo
echo "═══ ARTEFACTOS ═══"
find docs public data scripts -type f -newermt '-6 hours' 2>/dev/null \
  | grep -v '\.venv\|node_modules\|package-lock' | sort | head -40

echo
echo "Ver uno:      ./orchestration/status.sh t1"
echo "Seguir en vivo: ./orchestration/status.sh -f t1"
