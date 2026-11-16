# Road fix comparison manifest

Recorded 2026-10-04T17:07:52Z. Repository HEAD: `349d98494c1108060e6a0cf7f87f4803701c6a07`.

The before rendered/driving artifacts were generated against the pre-fix `road-draping.ts` captured as `../snapshot/road-draping.ts`; the after artifacts use the working source. Raw terrain is unchanged and shared. This is a provenance manifest for the saved same-session comparison, not an atomic rerun of both revisions. Independent review requested a fresh atomically paired run before ACCEPT.

| Artifact/source | SHA-256 |
|---|---|
| `src/road-draping.ts` after | `e8afeb9011f07caed613bab88ce50f7d5bfa0dd082dd574ef62cdb811e3c5b1e` |
| `../snapshot/road-draping.ts` before | `b654258bbf2f5f12a9ba342f262fd4a8961cba8177473404bd4708f67ef10a66` |
| `scripts/roads/test_road_geometry.mjs` | `d4e95e92294fd45a680d4bda9b08e2ee8d160585bcd14731db3011c6f4cf3f28` |
| `raw-before-and-after.json` | `7ead23a677253381b583a9a4bc2dc1943d18156dc494df8113bd6754cebf2621` |
| `rendered-before.json` | `3bc887bbfbf1a8a4a2027865e50a3afdadcc5ce3cc4be697fc84d4367591c277` |
| `rendered-after.json` | `ed2939f66ba33bcf3d13cdd727056130aa56fa6477dde2a88c0c5716cd0caa6c` |
| `driving-before.json` | `f1e99aa7dda16e82abd2681794bafb0a083b7026c73d4a8e902fc97ded1dbc90` |
| `driving-after.json` | `4cbf37adab5baa2439c04da645b3e99139155e384ce72e59b95253b421200210` |
