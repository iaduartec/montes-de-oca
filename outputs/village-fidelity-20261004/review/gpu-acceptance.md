# Target GPU acceptance review — root

Decision: BLOCKED_COMPARISON. NVIDIA RTX 2070 via ANGLE D3D11 is confirmed; no before/after FPS delta is accepted.

The bounded village pair has a valid baseline at 1080p (1440 frames, ~120 FPS) and a positive baseline at 1440p (1227 frames, ~102.32 FPS). Its AFTER 1080p reports only 71 frames over ~84.6 s, FPS .839 and an engine frame time ~84038.5 ms. Percentiles near 8.3/8.4 ms conceal that suspension; positive frame count alone is insufficient. AFTER 1440p reports 1440 frames/~120 FPS but its actual PNG looks down at a nearby roof instead of the baseline church/street. Draw/active counters change 53/51 → 44/40. The constant desired camera object in JSON does not verify the actual camera. Root inspected both AFTER PNGs and rejects these comparisons.

Retain `gpu/before-village-pair.json`, `gpu/after-village-pair.json` and their PNGs as rejected diagnostic evidence, with the worker’s report. Earlier full-camera attempts include zero-frame, foreground and settlement failures; do not select their best FPS into an aggregate. Free-camera actors/NPC exclusions still apply. No software-renderer FPS is used as target GPU evidence.

Required next validation: lock input/pose during sampling, record actual camera transform before and after, foreground the dedicated window, bound wall-clock vs rAF interval coverage, settle equivalent terrain/scene costs, and inspect matching images. Current fixed village comparison and scene-cost evidence remain separate and accepted.
