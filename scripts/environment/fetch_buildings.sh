#!/usr/bin/env bash
# Descarga los footprints de edificios de Villafranca Montes de Oca desde Overpass.
#
# Por qué un radio de 900 m alrededor del nodo del pueblo
# (42.3883784, -3.3086147, ver data/geo/raw/osm_village_node.json): el casco urbano
# de un pueblo de 110 habitantes mide few cientos de metros; 900 m lo cubren con
# margen (incluye alguna masía suelta) sin traer media provincia de Burgos.
# La ventana jugable es de 6000 x 6000 m y el pueblo cae en (3088, 3935), asi que
# el bbox entero queda bien dentro del dominio del terreno.
#
# El POST real lo hace scripts/geo/overpass.sh (User-Agent propio, reintentos ante
# 429/504 y reporte HTTP/bytes/sha256). Acá sólo se arma la query y el manifiesto,
# siguiendo el formato de scripts/roads/fetch_osm_roads.py.
#
# Uso: scripts/environment/fetch_buildings.sh [--force]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RAW="$ROOT/data/gameplay/raw"
QUERY_FILE="$RAW/osm_buildings_villafranca_query.txt"
OUT_FILE="$RAW/osm_buildings_villafranca.json"
MANIFEST_FILE="$RAW/osm_buildings_villafranca_manifest.json"

# Centro del pueblo (nodo OSM place=village) y radio de cobertura del casco.
CENTER_LAT="42.3883784"
CENTER_LON="-3.3086147"
RADIUS_M="900"
# Grados -> metros a la latitud del proyecto (public/terrain/config.json):
#   900 / 111090.4 = 0.0081016   900 / 82355.71 = 0.0109282
LAT_SPAN="0.0081016"
LON_SPAN="0.0109282"

mkdir -p "$RAW"

if [ -f "$OUT_FILE" ] && [ "${1:-}" != "--force" ]; then
  echo "Ya existe ${OUT_FILE#"$ROOT"/}; use --force para volver a bajar."
  exit 0
fi

# bbox (S,W,N,E) alrededor del nodo. `way["building"]` trae los tags y la geometria
# completa de cada node (`out geom`), que es lo que build_village.mjs convierte a
# poligonos de mundo.
{
  echo "[out:json][timeout:180];"
  echo "way[\"building\"]($(awk "BEGIN{printf \"%.6f\", $CENTER_LAT - $LAT_SPAN}"),$(awk "BEGIN{printf \"%.6f\", $CENTER_LON - $LON_SPAN}"),$(awk "BEGIN{printf \"%.6f\", $CENTER_LAT + $LAT_SPAN}"),$(awk "BEGIN{printf \"%.6f\", $CENTER_LON + $LON_SPAN}"));"
  echo "out tags geom qt;"
} >"$QUERY_FILE"

echo "Query -> ${QUERY_FILE#"$ROOT"/}"
cat "$QUERY_FILE"

"$ROOT/scripts/geo/overpass.sh" "$QUERY_FILE" "$OUT_FILE"

# Manifiesto: misma forma que data/roads/raw/osm_highways_window_manifest.json
# (endpoint, query, timestamp OSM, bytes, sha256). Sin manifiesto no hay forma de
# saber despues si el JSON commiteado sigue correspondiendo a la fuente.
MANIFEST_FILE="$MANIFEST_FILE" OUT_FILE="$OUT_FILE" QUERY_FILE="$QUERY_FILE" \
CENTER_LAT="$CENTER_LAT" CENTER_LON="$CENTER_LON" RADIUS_M="$RADIUS_M" \
LAT_SPAN="$LAT_SPAN" LON_SPAN="$LON_SPAN" ROOT="$ROOT" \
node -e '
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = process.env.ROOT;
const out = process.env.OUT_FILE;
const queryFile = process.env.QUERY_FILE;
const body = fs.readFileSync(out);
const payload = JSON.parse(body.toString("utf8"));
if (payload.remark) {
  console.error("FALLO: Overpass devolvio un runtime error: " + payload.remark);
  process.exit(1);
}
const kinds = {};
for (const el of payload.elements ?? []) kinds[el.type] = (kinds[el.type] ?? 0) + 1;
if (!payload.elements || payload.elements.length === 0) {
  console.error("FALLO: la consulta devolvio 0 elementos.");
  process.exit(1);
}
const rel = (p) => path.relative(root, p);
const manifest = {
  endpoint: "https://overpass-api.de/api/interpreter",
  url: "https://overpass-api.de/api/interpreter",
  method: "POST application/x-www-form-urlencoded",
  user_agent: "MontesDeOcaOffroad-GeoBot/1.0 (offline game geo research)",
  query_file: rel(queryFile),
  query: fs.readFileSync(queryFile, "utf8"),
  centro_wgs84: { lat: Number(process.env.CENTER_LAT), lon: Number(process.env.CENTER_LON) },
  radio_m: Number(process.env.RADIUS_M),
  bbox_wgs84_s_w_n_e: [
    Number(process.env.CENTER_LAT) - Number(process.env.LAT_SPAN),
    Number(process.env.CENTER_LON) - Number(process.env.LON_SPAN),
    Number(process.env.CENTER_LAT) + Number(process.env.LAT_SPAN),
    Number(process.env.CENTER_LON) + Number(process.env.LON_SPAN),
  ],
  overpass_timestamp_osm_base: payload.osm3s?.timestamp_osm_base ?? null,
  overpass_generator: payload.generator ?? null,
  fetched_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  file: rel(out),
  bytes: body.length,
  sha256: crypto.createHash("sha256").update(body).digest("hex"),
  elements: { total: payload.elements.length, by_type: kinds },
  license: "ODbL-1.0 (OpenStreetMap contributors)",
  remark: payload.remark ?? null,
};
fs.writeFileSync(process.env.MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
console.log("elementos = " + manifest.elements.total + " " + JSON.stringify(kinds));
console.log("osm3s.timestamp_osm_base = " + manifest.overpass_timestamp_osm_base);
console.log("bytes = " + manifest.bytes + "  sha256 = " + manifest.sha256);
console.log("-> " + rel(process.env.MANIFEST_FILE));
'
