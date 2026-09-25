# Rewrite de la historia: por qué los hashes cambiaron

El **25/09/2026** se reescribió la historia de este repo para sacar dos blobs
grandes. Autorizado explícitamente por el usuario. Este documento existe porque
**todos los hashes de commit anteriores cambiaron**, y varios informes citan los
viejos.

## Resultado

| | Antes | Después |
| --- | --- | --- |
| `.git` | 44,10 MB | **3,68 MB** |
| Commits | 16 | 16 (los mismos, con hash nuevo) |

Se sacaron de toda la historia:

| Ruta | Peso | Por qué |
| --- | --- | --- |
| `data/geo/raw/copernicus_glo30_N42_W004.tif` | 39,24 MB | DEM descartado (ver la decisión del MDT05) |
| `data/terrain/raw/mdt05_villafranca_6000m_5m.tif` | 2,75 MB | raster crudo: la política versiona manifiesto + SHA256, no el bytes |

El `.sha256` del DEM **sí sigue trackeado**, y el `.tif` **sigue en disco**: se
preservó durante el rewrite y se restauró verificando su sha256 contra el
manifiesto. El pipeline de terreno (`fetch_dem_mdt05.py`) lo puede re-obtener.

Queda **un** `.tif` en la historia, `data/geo/raw/mdt05_sample_1km.tif`, de 0,07 MB.
No se saca: otro rewrite volvería a reescribir los 16 commits y el costo supera la
ganancia.

## Cómo resolver una cita vieja

Los informes escritos antes del rewrite citan hashes que ya no existen. La tabla:

| Hash viejo | Hash nuevo | Commit |
| --- | --- | --- |
| `8bb97fd` | `6590906` | docs(audit): auditoría FASE 0 del motor GTA_SZ |
| `4eee08c` | `460456d` | docs(audit): review adversarial de la FASE 0 |
| `ad9e592` | `379ac60` | docs(audit): síntesis consolidada PROJECT_AUDIT.md |
| `7e5b0d3` | `4d3e0f7` | feat(terreno): DEM real → 36 tiles jugables |
| `cb241f2` | `46fa94c` | chore: dejar de trackear rasters crudos |
| `d9aea84` | `6908700` | docs(geo): plan geo de W6 + convención |
| `d395065` | `af58724` | chore(orq): despachar v1-vehiculo (FASE 4) |
| `8379e56` | `0de11a6` | chore(orq): registrar space-bunny-free en el pool |
| `350668e` | `a3efebc` | feat(roads): FASE 3a — red vial real desde OSM |
| `6759726` | `e96f07a` | feat(vehicle): FASE 4 — 4x4 con física de pendiente real |
| `851eab1` | `1a5096c` | chore(orq): despachar d1-drapeado (FASE 3b) |
| `92bba99` | `1988f7c` | test(terrain): validador del presupuesto de terreno |
| `7a6a380` | `bff7ea6` | feat(roads): FASE 3b — red vial drapeada sobre el terreno |
| `5277386` | `98444d4` | docs(roads): auditoría del orquestador de la FASE 3b |
| `02821ee` | `8c82b35` | chore(git): script con guardas para los dos blobs |

## Dos matices que sorprenden

**1. Los hashes viejos SÍ resuelven, pero solo enteros.** `git filter-repo` deja
`refs/replace/*` a propósito (su propio help lo dice: permiten seguir refiriéndose a
los commits nuevos con los IDs viejos *sin abreviar*). Así:

```bash
git rev-parse 7a6a380627df3d526e5e292084802bb85e62aa57   # funciona
git show 7a6a380                                          # fatal: unknown revision
```

O sea: copiar y pegar un hash viejo **abreviado** de un informe falla; el completo
funciona. La tabla de arriba está en ambos formatos por eso.

**2. El mapa autoritativo vive en `.git/` y NO está versionado.** Es
`.git/filter-repo/commit-map`, y se pierde en un clon limpio. Por eso está
transcrito acá: es el único registro que sobrevive.

## Lo que las citas viejas NO tienen

`filter-repo` avisó que hay referencias a hashes muertos dentro de **mensajes de
commit**, y las dejó como estaban (no se pueden reescribir sin otro rewrite). Son
pocas y el propio mensaje explica el remapeo. Si te topás con una, buscá acá.

## La operación

Está en `scripts/git/limpiar_blobs_grandes.sh`, con sus guardas y sus 7
verificaciones. Ejecutable como `check` (no rompe nada), `run` (destructivo) y
`verify` (solo las verificaciones).

El backup pre-rewrite quedó en
`/tmp/opencode/pre-rewrite-20260925-015343.bundle`. Ojo: en `/tmp`, así que puede
desaparecer en un reinicio — y ya no hace falta, porque el rewrite está verificado.
