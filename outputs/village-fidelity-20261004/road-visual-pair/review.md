# Junction geometry visual review

**Visual decision: ACCEPT the bounded compressed-edge pavement-weighting fix, with the measured skirt-face cost retained.** The review is limited to the paired `road-draping.ts` snapshots and the local bend around way `548355745`; it is not a global Road V3 readiness decision.

The pair uses the same frozen application source and public assets in two isolated Vite roots. Only `road-draping.ts` differs: baseline snapshot SHA-256 `b654258bbf2f5f12a9ba342f262fd4a8961cba8177473404bd4708f67ef10a66`, candidate `e8afeb9011f07caed613bab88ce50f7d5bfa0dd082dd574ef62cdb811e3c5b1e`. The current village-fix source was frozen into both roots, and the shared public asset tree hash stayed `d9f261252d9bd09c2418c1834c69b32e41e5b3da9bc9a2c9b80148655d460cbd` during both capture passes. Full provenance, input hashes, camera telemetry, and warnings are in [capture-report.json](capture-report.json).

## Accepted views

The close view aimed through the adjacent house roof is rejected as evidence. The high view and the close roadside view are the useful matched controls:

| View | Before | After | Camera/scene counts (before = after) |
|---|---|---|---|
| High bend overview | [before](before_junction_high.png) | [after](after_junction_high.png) | 41 draw calls, 974,189 triangles, 1,296,118 vertices, 31 active meshes, 39 textures |
| Close roadside edge, looking in from the southwest approach | [before](before_skirt_edge_roadside.png) | [after](after_skirt_edge_roadside.png) | 41 draw calls, 973,113 triangles, 1,296,118 vertices, 31 active meshes, 39 textures |

Both use 1280×720 captures, identical camera coordinates within each pair, and high quality. The close view centers the actual skirt worst-triangle location `(2960.6402, 3509.5627)` from the open road approach. The pavement worst triangle is immediately adjacent at `(2961.1102, 3510.3419)`. At this capture scale, the roadside pair shows no obvious new crack or silhouette break; the small edge facet is visible in both images and appears near-identical. The overall scene is heavily simplified and runs under headless SwiftShader, so this is a local shape comparison only. FPS and frame-time values are omitted as nonrepresentative.

## Measured local tradeoff

The captured skirt maximum is a real rendered triangle, not a normal-only metric. Its three vertices have unchanged XZ in both revisions. One pavement-edge vertex moves down by `0.16910 m`, while the two skirt vertices remain at the terrain edge. The triangle Y span therefore grows from `0.54006 m` to `0.70916 m`; grade ratio rises from `23.72929` to `32.42352`, or `87.59°` to `88.23°`. The image pair does not show an obvious perceptible crack at the saved view scale, but the source geometry has this measured edge cost. Vertex coordinates and roles are in [skirt-triangle-vertices.json](skirt-triangle-vertices.json).

At the adjacent ROAD pavement maximum, grade ratio falls from `5.19945` to `0.70353`; its Y span falls from `0.23782 m` to `0.12612 m`. The close/high images and stable draw, triangle, vertex, mesh, and texture counts support the bounded fix. They do not justify saying that no rendered geometry regressed: the skirt-face span increases by `0.169 m` and needs to remain visible in future geometry reviews.

## Global limits

The unchanged PATH pavement maximum grade ratio is `4.90821` and remains a separate terrain-boundary issue. The pair supplies no target-GPU performance evidence. This ACCEPT applies to the compressed-edge pavement fix at this bend, with the skirt cost documented; it does not mark the road network globally READY.
