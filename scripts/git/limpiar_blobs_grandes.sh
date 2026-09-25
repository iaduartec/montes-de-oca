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
# DOS BUGS PROPIOS QUE ESTE SCRIPT TUVO Y QUE VALEN COMO LECCION
# --------------------------------------------------------------
# 1) El chequeo de blobs usaba `grep -F "$ruta"`. Como
#    `.../mdt05_villafranca_6000m_5m.tif.sha256` CONTIENE como substring
#    `.../mdt05_villafranca_6000m_5m.tif`, daba un falso positivo: reportaba que
#    el blob seguia en la historia cuando ya no estaba. Un prefijo no es una
#    identidad. Ahora se compara el campo de ruta COMPLETO (awk + grep -Fxc).
# 2) `set -e` + `[ A = B ] && [ C = D ]; chk $?` aborta el script en cuanto el
#    test FALLA, antes de que `chk` pueda reportarlo. O sea: el verificador no
#    podia informar un fallo, solo morir en silencio. Por eso `npm test` nunca
#    llego a correr la primera vez. Ahora las verificaciones no usan `set -e`,
#    y el camino de error esta ejercitado de verdad.
#
# USO
#   scripts/git/limpiar_blobs_grandes.sh check    # guardas + estado. NO rompe nada.
#   scripts/git/limpiar_blobs_grandes.sh run      # ejecuta el rewrite de verdad
#   scripts/git/limpiar_blobs_grandes.sh verify   # solo las 6 verificaciones
#
# Decision registrada en Engram: `git/rewrite-historia`. Autorizado por el usuario.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

BLOB_MINERO="data/geo/raw/copernicus_glo30_N42_W004.tif"
BLOB_DEM="data/terrain/raw/mdt05_villafranca_6000m_5m.tif"
BUNDLE="${BUNDLE:-/tmp/opencode/pre-rewrite-20260925-015343.bundle}"
PRESERVADO="${PRESERVADO:-/tmp/opencode/mdt_preservado.tif}"
MODE="${1:-check}"

rojo()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
ambar() { printf '\033[33m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m%s\033[0m\n' "$*"; }
paso()  { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }
abortar(){ rojo "ABORTA: $*"; exit 1; }

# Cuenta las entradas de la historia cuya RUTA es exactamente esta.
# El formato de `rev-list --objects` es "<sha> <ruta>", asi que se compara el
# campo 2 completo: un prefijo no es una identidad (ver bug 1 arriba).
refs_de_ruta() { git rev-list --objects --all | awk '{print $2}' | grep -Fxc "$1" || true; }

# ---------------------------------------------------------------- guardas
guardas() {
  paso "GUARDAS"
  local sucio
  sucio="$(git status --porcelain | grep -E '^[ ]?[MADRCU]' || true)"
  if [ -n "$sucio" ]; then
    rojo "$sucio"
    abortar "hay cambios sin commitear en archivos trackeados. Commitearlos o guardarlos ANTES de reescribir."
  fi
  verde "  OK  arbol limpio en archivos trackeados"

  [ -f "$BUNDLE" ] || abortar "no existe el backup $BUNDLE. Hacelo: git bundle create <archivo> --all"
  git bundle verify "$BUNDLE" >/dev/null 2>&1 || abortar "el bundle $BUNDLE NO verifica. No lo uses."
  verde "  OK  backup verificado ($(du -h "$BUNDLE" | cut -f1))"

  command -v git-filter-repo >/dev/null || abortar "falta git-filter-repo"
  verde "  OK  git-filter-repo presente"
}

estado() {
  paso "ESTADO"
  local bytes mb commits
  bytes=$(du -sb .git | cut -f1)
  mb=$(echo "scale=2; $bytes/1048576" | bc)
  commits=$(git rev-list --count HEAD)
  printf '  .git: %s MB · commits: %s\n' "$mb" "$commits"
  printf '  blobs a sacar (refs exactas en la historia):\n'
  printf '    %-52s %s\n' "$BLOB_MINERO" "$(refs_de_ruta "$BLOB_MINERO")"
  printf '    %-52s %s\n' "$BLOB_DEM" "$(refs_de_ruta "$BLOB_DEM")"
}

# ------------------------------------------------------- verificaciones
# Sin `set -e`: un check que falla tiene que REPORTARSE, no matar el script.
verificar() {
  paso "VERIFICACIONES"
  local fallos=0
  chk() { if [ "$2" = "0" ]; then verde "  OK    $1"; else rojo "  FALLA $1"; fallos=$((fallos+1)); fi; }

  if git fsck --strict --no-dangling >/dev/null 2>&1; then chk "git fsck --strict sin errores" 0
  else chk "git fsck --strict sin errores" 1; fi

  local bytes mb
  bytes=$(du -sb .git | cut -f1); mb=$(echo "scale=2; $bytes/1048576" | bc)
  if [ "$bytes" -lt 10485760 ]; then chk ".git quedo en ${mb} MB (< 10 MB)" 0
  else chk ".git quedo en ${mb} MB (esperado < 10 MB)" 1; fi

  # "El rewrite no perdio commits" SOLO es una afirmacion valida en el contexto
  # del rewrite: despues, que haya mas commits es normal y correcto. Un `verify`
  # suelto no puede afirmar eso sin una referencia, asi que sin ella solo informa.
  local n_commits
  n_commits=$(git rev-list --count HEAD)
  if [ -n "${COMMITS_ANTES:-}" ]; then
    if [ "$n_commits" = "$COMMITS_ANTES" ]; then chk "los $COMMITS_ANTES commits sobrevivieron al rewrite" 0
    else chk "los $COMMITS_ANTES commits sobrevivieron al rewrite (hay $n_commits)" 1; fi
  else
    info "  INFO  commits actuales: $n_commits (sin referencia no se afirma nada)"
  fi

  # El blob del DEM tiene que estar fuera, pero su MANIFIESTO (.sha256) tiene que
  # seguir: la politica del .gitignore versiona manifiesto + SHA256, no el bytes.
  local n_min n_dem n_sha
  n_min=$(refs_de_ruta "$BLOB_MINERO")
  n_dem=$(refs_de_ruta "$BLOB_DEM")
  n_sha=$(git ls-files | grep -c '\.tif\.sha256$' || true)
  if [ "$n_min" = "0" ] && [ "$n_dem" = "0" ]; then chk "los dos blobs .tif objetivo fuera de la historia" 0
  else chk "los dos blobs .tif objetivo fuera de la historia (minero=$n_min dem=$n_dem)" 1; fi
  if [ "$n_sha" -ge 1 ]; then chk "el manifiesto .sha256 del DEM sigue trackeado" 0
  else chk "el manifiesto .sha256 del DEM sigue trackeado" 1; fi

  # Que los dos objetivos esten fuera NO significa que la historia este libre de
  # .tif, y un check con ese nombre se puede leer como si lo significara. Se
  # declara explicitamente lo que queda en vez de dejarlo implicito.
  local restantes
  restantes=$(git rev-list --objects --all | awk '{print $2}' | grep -E '\.tif$' | sort -u || true)
  if [ -n "$restantes" ]; then
    ambar "  NOTA  .tif que AUN quedan en la historia (no objetivo, se declaran):"
    local r o b
    while read -r r; do
      [ -z "$r" ] && continue
      o=$(git rev-list --objects --all | grep -F "$r" | awk '{print $1}' | head -1)
      b=$(git cat-file -s "$o" 2>/dev/null || echo 0)
      ambar "          $r — $(echo "scale=2; $b/1048576" | bc) MB"
    done <<< "$restantes"
    ambar "        No se sacan: otro rewrite vuelve a reescribir TODOS los commits, y"
    ambar "        ninguno de estos llega a 0,1 MB. El costo supera la ganancia."
  fi

  # El DEM tiene que seguir EN DISCO y verificar contra su manifiesto: es el
  # insumo del pipeline de terreno y dejo de estar versionado.
  if [ -f "$BLOB_DEM" ]; then
    local esperado real
    esperado=$(awk '{print $1}' "$BLOB_DEM.sha256")
    real=$(sha256sum "$BLOB_DEM" | awk '{print $1}')
    if [ "$esperado" = "$real" ]; then chk "el DEM sigue en disco y verifica (${real:0:16}…)" 0
    else chk "el DEM en disco NO verifica contra el manifiesto" 1; fi
  else chk "el DEM sigue en disco" 1; fi

  if npm test >/tmp/opencode/npm-test-post-rewrite.log 2>&1; then chk "npm test verde" 0
  else chk "npm test verde (ver /tmp/opencode/npm-test-post-rewrite.log)" 1; fi

  paso "RESULTADO"
  if [ "$fallos" = "0" ]; then verde "  TODAS LAS VERIFICACIONES OK"; return 0; fi
  rojo "  $fallos verificacion(es) fallaron. El backup $BUNDLE sigue intacto."
  return 1
}

case "$MODE" in
  check)
    guardas; estado
    paso "MODO CHECK: no se toca nada. Para ejecutar: $0 run"
    ;;
  verify)
    verificar || exit 1
    ;;
  run)
    guardas; estado

    paso "PRESERVAR EL DEM (deja de estar trackeado; el reset lo borraria del disco)"
    if [ -f "$BLOB_DEM" ]; then
      ESPERADO=$(awk '{print $1}' "$BLOB_DEM.sha256")
      REAL=$(sha256sum "$BLOB_DEM" | awk '{print $1}')
      [ "$ESPERADO" = "$REAL" ] || abortar "el sha256 del DEM no coincide con el manifiesto. No sigas."
      cp "$BLOB_DEM" "$PRESERVADO" || abortar "no se pudo copiar el DEM"
      verde "  OK  copiado a $PRESERVADO (sha256 verificado: ${REAL:0:16}…)"
    else
      rojo "  AVISO: el DEM no esta en disco. Se seguira igual."
    fi

    paso "REESCRIBIENDO LA HISTORIA"
    COMMITS_ANTES=$(git rev-list --count HEAD)
    git filter-repo --invert-paths --path "$BLOB_MINERO" --path "$BLOB_DEM" --force \
      || abortar "git filter-repo fallo. El backup $BUNDLE sigue intacto."
    git reflog expire --expire=now --all || abortar "reflog expire fallo"
    git gc --prune=now --quiet || abortar "git gc fallo"
    verde "  filtrado y compactado"

    paso "RESTAURAR EL DEM AL DISCO"
    if [ ! -f "$BLOB_DEM" ] && [ -f "$PRESERVADO" ]; then
      cp "$PRESERVADO" "$BLOB_DEM" || abortar "no se pudo restaurar el DEM"
      ESPERADO=$(awk '{print $1}' "$BLOB_DEM.sha256")
      REAL=$(sha256sum "$BLOB_DEM" | awk '{print $1}')
      [ "$ESPERADO" = "$REAL" ] || abortar "el DEM restaurado no verifica contra el manifiesto"
      verde "  OK  restaurado y verificado (${REAL:0:16}…)"
    elif [ -f "$BLOB_DEM" ]; then
      verde "  OK  el reset no lo borro; sigue en disco"
    else
      abortar "el DEM desaparecio y no hay copia en $PRESERVADO"
    fi

    verificar || exit 1
    ;;
  *)
    abortar "modo desconocido '$MODE' (usar check|run|verify)"
    ;;
esac
