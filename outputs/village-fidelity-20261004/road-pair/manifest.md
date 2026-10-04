# Exact paired diagnostic manifest

Captured 2026-10-04. Effective checkout: `/home/kiri_/projects/montes-de-oca-offroad`, branch `feat/village-fidelity-20261004`, HEAD `349d984`. Worktree was dirty before the run; no live source, scripts, or existing reports were edited.

The pair was built sequentially in this owned isolated directory. `rendered-before.json` and `driving-before.json` used the preserved snapshot `outputs/village-fidelity-20261004/road-fix/snapshot/road-draping.ts`. The isolated copy of `scripts/roads/diagnose_surface.mjs` was adapted to read that local source when `--before` is passed and to load the identical current `road-profile.ts` for both revisions. It exposes role-separated generated buffers as the existing script does. The after pair used the live candidate copied into this directory. The one raw terrain run used the same isolated data. The live checkout was never swapped or compiled for these artifacts.

Run order and file modification timestamps (Europe/Madrid, UTC+02):

| Artifact | Command | Timestamp |
|---|---|---|
| `rendered-before.json` | `ROAD_DIAGNOSTIC_OUT=. node scripts/roads/diagnose_surface.mjs --before` | 2026-10-04 19:17:07.664 |
| `driving-before.json` | `ROAD_DIAGNOSTIC_OUT=. node scripts/roads/diagnose_surface.mjs --before --driving` | 2026-10-04 19:17:21.592 |
| `rendered-after.json` | `ROAD_DIAGNOSTIC_OUT=. node scripts/roads/diagnose_surface.mjs --after` | 2026-10-04 19:17:36.566 |
| `driving-after.json` | `ROAD_DIAGNOSTIC_OUT=. node scripts/roads/diagnose_surface.mjs --after --driving` | 2026-10-04 19:17:50.998 |
| `raw.json` | `ROAD_DIAGNOSTIC_OUT=. node scripts/roads/diagnose_surface.mjs` | 2026-10-04 19:18:11.094 |

Node was `v24.21.0`; the diagnostic logged Babylon.js `v8.56.2`. The tool's mode string says `caef87e BEFORE` for baseline mode by design; it describes the script's default historical baseline label, not the source actually loaded here. The local adapted script explicitly reads its own `src/road-draping.ts`, which was copied from the snapshot before both before-runs.

## SHA-256

| Input | SHA-256 |
|---|---|
| Before `road-draping.ts` snapshot | `b654258bbf2f5f12a9ba342f262fd4a8961cba8177473404bd4708f67ef10a66` |
| After `road-draping.ts` candidate | `e8afeb9011f07caed613bab88ce50f7d5bfa0dd082dd574ef62cdb811e3c5b1e` |
| Shared `road-profile.ts` | `37a92cd44e7787c02334525393201dc71622cfadededaaed53279853a7242811` |
| Shared `world/road-surface.ts` | `d974bd8c2a632cf8dc2979b6e279cfdda12a28da4ba22865c097bfd9d5e47ba7` |
| Shared `heightfield.ts` | `1328162f9841a85e981231e7e6cb7dd0bb48a0269a1149c6c4e4fb98557a1081` |
| Shared `road-visuals.ts` | `9164da1b1a0ffe8bb819c8da9b860da92998be0702fc3817ef872991d7e30ce4` |
| Shared `roads.json` | `e8c3c2f3670e2214669900826074e007bd6fdc8836a489e4a443a0686bd969be` |
| Shared terrain config | `993bfcaa4e5eea6cac1d3f5a762049a079a7d9ffe8c54dbefe8a6ba3ecd5ed43` |
| Shared copied DEM tile set | `ace73f3a1f77c85ba41446ac562dce4a94d954ddfb21678403c5e930165a85a5` (SHA-256 of sorted per-file hash listing) |
| Isolated adapted diagnostic | `scripts/roads/diagnose_surface.mjs` in this directory; based on checkout script hash `d7b47871ce8aabc7d6a205166a1d47bdaff55be98abb79e53f377ceac7bef01a` |
| `rendered-before.json` | `f91e3272ff9e8f22c9ef9ae32f0b55c59d49292962bf275c1f8676f73a55b1ca` |
| `rendered-after.json` | `ed2939f66ba33bcf3d13cdd727056130aa56fa6477dde2a88c0c5716cd0caa6c` |
| `driving-before.json` | `ae51db363feeccf502dd32984e9f1ba3f553fa1d298ce3a56054c6629bd07373` |
| `driving-after.json` | `4cbf37adab5baa2439c04da645b3e99139155e384ce72e59b95253b421200210` |
| `raw.json` | `7ead23a677253381b583a9a4bc2dc1943d18156dc494df8113bd6754cebf2621` |
