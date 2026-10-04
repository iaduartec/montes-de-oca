# Village fidelity final review

**Verdict: partial accept.** The four roof-profile corrections are supported by the target roof plans and by rendered-geometry checks. The Antiguo Hospital roof appearance improves, while its compound roof massing remains blocked. PNOA supports roof plan and material appearance only; it does not establish facade detail or absolute roof height.

| OSM way | Decision | Review finding |
|---:|---|---|
| 818885706 | ACCEPT | The explicit north-south gable replaces the inferred shed. The corrected concave roof stays inside the mapped footprint, closes the wall boundary, and preserves its former maximum datum. Ridge slope remains approximate. |
| 818885708 | ACCEPT | The generated roof now has the observed hipped ends. Geometry covers the concave outline once. The secondary roof volumes are only a probable fit. |
| 474364245 | ACCEPT | The hipped profile fits the observed broad roof plan and has no visible boundary gap. The attached roof arrangement remains probable. |
| 474649085 | ACCEPT | The north-south gable follows the observed ridge direction. The corrected mesh joins the walls and preserves the prior maximum height convention; the ortho does not verify that vertical height. |
| 672017718 | ACCEPT_APPEARANCE_ONLY | Roof appearance is accepted. Massing remains **BLOCKED**: the 30-vertex compound still renders as one broad procedural surface, while PNOA shows connected pitched volumes and a blue-grey glazing patch. |
| 310174514 control | PASS | No override is present. Before/after roof form, tint, footprint, and camera match. |

The reviewed before/after PNGs and source references are under [before](../before/), [after](../after/), and [references](../references/). The fixed camera manifest is [camera-manifest.json](../before/camera-manifest.json). Five PNOA references are IGN/CNIG CC BY 4.0 snapshots retrieved 2026-10-04; the flight year is unverified for these targets. No facade claims were inferred from them.

`npm run test:village-fidelity` passed. Its runtime NullEngine fixture builds Babylon mesh vertices and indices, then checks footprint containment, projected roof area, matching roof/wall boundary vertices, and roof maximum height for the gables and hips. It also confirms that a supplied facade kit changes the generated shutter mesh. The source validator reported 164 checks OK, five corrected records, and six remaining evidence blockers. Root reported typecheck, build, and full test suite passing after source freeze; this reviewer did not repeat those commands.

The app capture covered all 21 manifest views at the same 1280×720 HIGH-quality settings. Nineteen diagnostic views came from Vite at `127.0.0.1:5174`; playable spawn and NPC frames were recaptured from the built preview at `127.0.0.1:4174`. Per-view origin and source hashes are recorded in [village-comparison.json](village-comparison.json) and [capture-report.json](../after/capture-report.json). The failed early spawn sample, which had zero rendered triangles and an `Uncaught` event, is retained under [first-pass/full-capture-failure](first-pass/full-capture-failure/). A later independent cold run from native dev at `5174` and built preview at `4199` rendered after about 30 seconds with no browser errors. The first zero-resource sample was a readiness failure and does not indicate a persistent runtime failure.

Across all 21 matched views, draw calls, active meshes, and texture counts were unchanged. Each of the 19 Vite diagnostic views and the preview NPC view reports +1,130 triangles and +2,606 vertices; preview spawn reports +2,260 triangles and +2,606 vertices. The no-op control also reports +1,130 triangles. These totals include broader roof tessellation and clipping updates along with target overrides, so the whole-scene counter cannot isolate the five targets. The road geometry adjustment changes Y positions and adds no triangles. Chrome used SwiftShader, so frame rates do not establish target GPU performance.

The roof geometry changes use shared material meshes and add no draw calls. The evidence-map facade-kit option is consumed when passed to `loadVillage`, but `src/main.ts` does not pass per-building kits; live detailed buildings therefore use the deterministic fallback profile. PNOA provides no facade evidence for these houses, so this remains an integration limitation rather than a failed facade claim.
