# V14 target GPU comparison
STATUS: BLOCKED_COMPARISON — renderer confirmed; paired timing/camera evidence rejected
WORKER: Codex / village_fix
MODEL: GPT-6 Luna / gpt-6-luna
REPO: /home/kiri_/projects/montes-de-oca-offroad
OWNED FILES: outputs/village-fidelity-20261004/gpu/ only.
READ ONLY: src/; package.json; scripts/runtime/benchmark_gpu.mjs; public/; all other files.
OBJECTIVE: Compare preserved dirty baseline and final runtime on real RTX 2070 at HIGH 1080p/1440p, fixed village/road/track/forest/aerial cameras.
CONTRACT: Same scene/data/camera; record renderer, positive frame samples, image, counters and limitations; free camera excludes actors/NPC; foreground failures are rejected.
FORBIDDEN: source writes; installing paid providers; changing user Chrome config; commits; subagents; accepting zero rAF or SwiftShader FPS as target hardware.
VALIDATION: actual browser scene, finite positive rAF/draw/triangle counts, comparison manifest and review.
REPORT: STATUS / FILES / WHAT / VERIFY / RISKS / BLOCKERS.

ROOT REVIEW: review/gpu-acceptance.md. 1080p paired AFTER includes an ~84-second rAF suspension; 1440p AFTER points down at a different scene despite desired camera metadata. No target FPS delta accepted; attempts retained as diagnostics. Bounded retries stopped.

DELIVERY: gpu/review.md, results.json, manifest.json, paired raw reports and PNGs. Own Chrome CDP9239 and previews4188/4189 stopped; source ownership unchanged. Root independently rejected timing/camera mismatch.
