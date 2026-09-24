#!/usr/bin/env bash
# overpass.sh <query-file> <output-file>
# POST a Overpass API con User-Agent obligatorio y reintentos ante 429/504.
# Convención: siempre reportar HTTP code real, bytes y SHA-256 del resultado.
set -uo pipefail
QF="${1:?usage: overpass.sh query.overpassql out.json}"
OF="${2:?usage: overpass.sh query.overpassql out.json}"
UA="MontesDeOcaOffroad-GeoBot/1.0 (offline game geo research)"
for attempt in 1 2 3 4; do
  code=$(curl -sS -X POST https://overpass-api.de/api/interpreter \
    -A "$UA" --max-time 180 \
    --data-urlencode "data@${QF}" \
    -o "$OF" -w '%{http_code}' 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then
    bytes=$(stat -c%s "$OF")
    sha=$(sha256sum "$OF" | cut -d' ' -f1)
    echo "HTTP $code  bytes=$bytes  sha256=$sha  file=$OF"
    exit 0
  fi
  echo "intento $attempt -> HTTP $code (reintento en 8 s)" >&2
  sleep 8
done
echo "FALLO tras 4 intentos, ultimo HTTP $code" >&2
exit 1
