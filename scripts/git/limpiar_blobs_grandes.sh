#!/usr/bin/env bash
# Saca dos blobs grandes de TODA la historia de git.
#
# POR QUE EXISTE COMO SCRIPT Y NO COMO UN COMANDO SUELTO
# ------------------------------------------------------
# Es la operacion mas peligrosa del repo: reescribe el hash de TODOS los commits.
# Como comando de chat no es auditable, no es re-ejecutable y no lleva guardas.
# Aca las lleva, y esa es la mitad del valor:
#
#   GUARDA 1 - arbol limpio. `git filter-repo` actualiza el arbol de trabajo al
#              terminar. Correrlo con cambios sin commitear los DESTRUYE. Esto no
#              es teorico: estuvo a punto de pasar con `M src/main.ts` de
#              d1-drapeado. Si el arbol esta sucio, este script ABORTA.
#   GUARDA 2 - backup valido. Exige un bundle verificado antes de tocar nada.
#   GUARDA 3 - el DEM se preserva. El .tif del MDT esta trackeado y deja de
#              estarlo: `git reset --hard` lo borraria del disco. Se copia afuera,
#              se verifica contra el manifiesto y se restaura si desaparecio.
#
# Y al final corre 6 verificaciones. Si alguna falla, sale != 0.
#
# USO
#   scripts/git/limpiar_blobs_grandes.sh check   # solo guardas + estado. NO rompe nada.
#   scripts/git/limpiar_blobs_grandes.sh run     # ejecuta de verdad
#
# Decision registrada en Engram: `git/rewrite-historia`. Autorizado por el usuario.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BLOB_MINERO="data/geo/raw/copernicus_glo30_N42_W004.tif"
BLOB_DEM="data/terrain/raw/mdt05_villafranca_6000m_5m.tif"
BUNDLE="${BUNDLE:-/tmp/opencode/pre-rewrite-20260925-015343.bundle}"
PRESERVADO="${PRESERVADO:-/tmp/opencode/mdt_preservado.tif}"
MODE="${1:-check}"

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
paso()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
abortar(){ rojo "ABORTA: $*"; exit 1; }

# ---------------------------------------------------------------- guardas
paso "GUARDAS"

# 1. arbol limpio (solo importan los archivos TRACKEADOS: untracked no se pierden)
SUCIO="$(git status --porcelain | grep -E '^[ ]?[MADRCU]' || true)"
if [ -n "$SUCIO" ]; then
  rojo "$SUCIO"
  abortar "hay cambios sin commitear en archivos trackeados. Commitearlos o guardarlos ANTES de reescribir."
fi
verde "  OK  arbol limpio en archivos trackeados"

# 2. backup presente y verificado
[ -f "$BUNDLE" ] || abortar "no existe el backup $BUNDLE. Hacelo: git bundle create <archivo> --all"
git bundle verify "$BUNDLE" >/dev/null 2>&1 || abortar "el bundle $BUNDLE NO verifica. No lo uses."
verde "  OK  backup verificado ($(du -h "$BUNDLE" | cut -f1))"

# 3. herramienta
command -v git-filter-repo >/dev/null || abortar "falta git-filter-repo"
verde "  OK  git-filter-repo presente"

# ---------------------------------------------------------------- estado
paso "ESTADO ANTES"
ANTES_BYTES=$(du -sb .git | cut -f1)
ANTES_MB=$(echo "scale=2; $ANTES_BYTES/1048576" | bc)
ANTES_COMMITS=$(git rev-list --count HEAD)
printf '  .git: %s MB · commits: %s\n' "$ANTES_MB" "$ANTES_COMMITS"
printf '  blobs a sacar:\n'
for b in "$BLOB_MINERO" "$BLOB_DEM"; do
  n=$(git rev-list --objects --all | grep -F "$b" | wc -l)
  printf '    %-56s %s refs en la historia\n' "$b" "$n"
done

if [ "$MODE" = "check" ]; then
  paso "MODO CHECK: no se toca nada. Para ejecutar: $0 run"
  exit 0
fi

[ "$MODE" = "run" ] || abortar "modo desconocido '$MODE' (usar check|run)"

# --------------------------------------------------- preservar el DEM
paso "PRESERVAR EL DEM (deja de estar trackeado; el reset lo borraria del disco)"
if [ -f "$BLOB_DEM" ]; then
  ESPERADO=$(awk '{print $1}' "$BLOB_DEM.sha256")
  REAL=$(sha256sum "$BLOB_DEM" | awk '{print $1}')
  [ "$ESPERADO" = "$REAL" ] || abortar "el sha256 del DEM no coincide con el manifiesto. No sigas."
  cp "$BLOB_DEM" "$PRESERVADO"
  verde "  OK  copiado a $PRESERVADO (sha256 verificado: ${REAL:0:16}…)"
else
  rojo "  AVISO: el DEM no esta en disco. Se seguira igual."
fi

# ------------------------------------------------------------- rewrite
paso "REESCRIBIENDO LA HISTORIA"
git filter-repo --invert-paths --path "$BLOB_MINERO" --path "$BLOB_DEM" --force
git reflog expire --expire=now --all
git gc --prune=now --quiet
verde "  filtrado y compactado"

# ------------------------------------------------------- restauraciones
paso "RESTAURAR EL DEM AL DISCO"
if [ ! -f "$BLOB_DEM" ] && [ -f "$PRESERVADO" ]; then
  cp "$PRESERVADO" "$BLOB_DEM"
  ESPERADO=$(awk '{print $1}' "$BLOB_DEM.sha256")
  REAL=$(sha256sum "$BLOB_DEM" | awk '{print $1}')
  [ "$ESPERADO" = "$REAL" ] || abortar "el DEM restaurado no verifica contra el manifiesto"
  verde "  OK  restaurado y verificado (${REAL:0:16}…)"
elif [ -f "$BLOB_DEM" ]; then
  verde "  OK  el reset no lo borro; sigue en disco"
else
  abortar "el DEM desaparecio y no hay copia en $PRESERVADO"
fi

# ------------------------------------------------------- verificaciones
paso "VERIFICACIONES POST-REWRITE"
FALLOS=0
chk() { if [ "$2" = "0" ]; then verde "  OK    $1"; else rojo "  FALLA $1"; FALLOS=$((FALLOS+1)); fi; }

# 1. integridad
git fsck --strict --no-dangling >/dev/null 2>&1
chk "git fsck --strict sin errores" $?

# 2. tamano
DESPUES_BYTES=$(du -sb .git | cut -f1)
DESPUES_MB=$(echo "scale=2; $DESPUES_BYTES/1048576" | bc)
if [ "$DESPUES_BYTES" -lt 10485760 ]; then chk ".git quedo en ${DESPUES_MB} MB (< 10 MB)" 0; else chk ".git quedo en ${DESPUES_MB} MB (esperado < 10)" 1; fi

# 3. los commits siguen
DESPUES_COMMITS=$(git rev-list --count HEAD)
[ "$DESPUES_COMMITS" = "$ANTES_COMMITS" ]; chk "los $ANTES_COMMITS commits siguen ($DESPUES_COMMITS)" $?

# 4. ningun .tif trackeado (el .sha256 SI queda: la politica versiona manifiesto + SHA256)
N_TIF=$(git ls-files | grep -c '\.tif$' || true)
[ "$N_TIF" = "0" ]; chk "0 archivos .tif trackeados" $?
N_SHA=$(git ls-files | grep -c '\.tif\.sha256$' || true)
[ "$N_SHA" -ge 1 ]; chk "el manifiesto .sha256 del DEM sigue trackeado" $?

# 5. los blobs ya no estan en la historia
N_MIN=$(git rev-list --objects --all | grep -cF "$BLOB_MINERO" || true)
N_DEM=$(git rev-list --objects --all | grep -cF "$BLOB_DEM" || true)
[ "$N_MIN" = "0" ] && [ "$N_DEM" = "0" ]; chk "los dos blobs fuera de la historia" $?

# 6. el proyecto sigue funcionando
if npm test >/tmp/opencode/npm-test-post-rewrite.log 2>&1; then chk "npm test verde" 0; else chk "npm test verde (ver /tmp/opencode/npm-test-post-rewrite.log)" 1; fi

paso "RESULTADO"
printf '  .git: %s MB -> %s MB\n' "$ANTES_MB" "$DESPUES_MB"
printf '  commits: %s -> %s\n' "$ANTES_COMMITS" "$DESPUES_COMMITS"
if [ "$FALLOS" = "0" ]; then
  verde "  TODAS LAS VERIFICACIONES OK"
else
  rojo "  $FALLOS verificacion(es) fallaron. El backup $BUNDLE sigue intacto."
  exit 1
fi
