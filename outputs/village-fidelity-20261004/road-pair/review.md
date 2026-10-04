# Compressed-edge junction fix: paired review

**Decision: ACCEPT the bounded compressed-edge fix for this source snapshot.** This accepts only the `road-draping.ts` change represented by the paired run. It does not declare the full road network ready or clear the independent PATH/terrain boundary issue.

## Paired run and scope

Both builds ran in this isolated directory using the same copied terrain tiles, `roads.json`, `road-profile.ts`, `road-surface.ts`, `heightfield.ts`, `road-visuals.ts`, Babylon 8.56.2, Node 24.21.0, and diagnostic code. The only road geometry source difference was `src/road-draping.ts`: before SHA-256 `b654258b…ef10a66` (the preserved road-fix snapshot), after SHA-256 `e8afeb90…e3c5b1e` (the worktree candidate). Raw terrain was measured once from those same inputs. Per-run timestamps, complete hashes, and the isolated diagnostic adaptation are in [manifest.md](manifest.md).

The four artifacts are [rendered-before.json](rendered-before.json), [rendered-after.json](rendered-after.json), [driving-before.json](driving-before.json), and [driving-after.json](driving-after.json). The diagnostic embeds the label `caef87e BEFORE` when `--before` is selected; that label is stale because this run substituted the supplied snapshot source inside the isolated copy. The artifact filenames and manifest identify the actual paired baseline. This run does not use or modify live source files during compilation.

## Results

Rendered pavement triangle grade ratio (`horizontal normal / vertical normal`) is the direct geometry measure. Each cell gives before → after; triangle roles are separated so skirts and decorative/degenerate geometry do not contaminate pavement claims.

| Class / role | Count | p50 | p90 | p95 | p99 | max |
|---|---:|---:|---:|---:|---:|---:|
| ROAD pavement | 100,262 | .060701 → .060696 | .108150 → .108083 | .140370 → .140327 | .211310 → .211650 | **5.199446 → .703531** |
| ROAD skirt | 43,008 | .518518 → .518459 | 1.562264 → 1.561640 | 2.001501 → 2.002237 | 2.868322 → 2.866389 | 23.729290 → 32.423515 |
| TRACK pavement | 230,104 | .098568 → .098568 | .194265 → .194265 | .209040 → .209040 | .256206 → .256206 | .764083 → .764083 |
| PATH pavement | 45,936 | .172023 → .172022 | .351545 → .351545 | .389145 → .389145 | .501553 → .501553 | 4.908211 → 4.908211 |

The ROAD outlier is the targeted way `548355745`, triangle 61,626, centered at `(2961.1102, 3510.3419)`: grade ratio falls from 5.19945 to 0.70353 (79.11° to 35.12°). ROAD p95 is effectively unchanged and p99 increases only 0.00034. The current source snapshot therefore does not reproduce the earlier saved report’s claimed broad p99 regression. ROAD skirt maximum rises from 23.73 to 32.42 at the same cut-edge neighborhood; skirt triangles are not pavement and remain a separate visible-edge follow-up. Terminal-earthwork triangles have near-zero horizontal area and enormous ratios in the diagnostic, so they are excluded from this comparison.

Rendered centerline cross-slope `p50/p90/p95/p99/max` is ROAD `.028079/.076825/.079961/.089281/.265694` → `.028129/.076825/.079964/.092223/.265694`; TRACK and PATH are unchanged. Independent ROAD lateral cross-section slope `p50/p90/p95/p99/max` is `.030173/.079033/.080002/.181139/.505607` → `.030200/.079038/.080002/.181150/.505607`. Its maximum is at a missing-side/class-owner boundary and is stable; it is not evidence of a new pavement crossfall. ROAD cross-slope histogram counts shift only slightly: samples over .1 rise from 172 to 176 out of 20,790. See artifact histograms for all bins and top samples.

Driving-contact ROAD `ownFacetBank` has `p50/p90/p95/p99/max` `.028081/.076824/.079944/.080000/.193998` → `.027967/.076822/.079955/.080000/.119670`. Its p99/max are capped by class policy and are not used as proof of rendered geometry. Contact longitudinal slope, height delta, and normal-change distributions are effectively unchanged; owner transitions remain 465 ROAD, 579 TRACK, and 256 PATH. The raw DEM is unchanged; its ROAD longitudinal slope `p50/p90/p95/p99/max` is `.024437/.175710/.195841/.244580/.434383` and cross-slope is `.101246/.259800/.307017/.403731/.568364`. Full raw report: [raw.json](raw.json).

## Code review and limits

The candidate change scopes per-vertex falloff to adjacent same-road profile groups whose pavement-edge separation is below `min(.5 m, subdivisionM * .2)`. It preserves shared cross-section weighting elsewhere, skips bridge-role groups, reads target positions from an immutable copy, and changes Y only. The paired triangle results show the intended full-network bend facet drops below grade ratio 1 without a measurable pavement-tail shift or new crossfall maximum.

Existing geometry coverage exercises four class combinations at true crossings, input-order stability at a multiway connector, and a grade-separated bridge connector. It does not isolate near-but-disconnected width fallback acceptance or the exact compressed-edge threshold boundary in a synthetic fixture. Those are remaining review coverage gaps; this narrow change does not alter the event/fallback detection, bridge exclusion, plane clustering, or blend field that governs those cases. No new verifier fixture was added because the requested disposition is for the already-scoped edge-weighting correction and a robust new fixture needs a testable public behavior contract beyond the private profile grouping.

**Global road blockers remain:** PATH pavement triangle maximum 4.9082 is unchanged and remains a real terrain-boundary discontinuity pending attribution; the ROAD skirt maximum worsened and needs local rendered-edge review. This paired NullEngine diagnostic provides no same-camera in-game capture or target-GPU performance evidence. These do not invalidate the bounded ROAD pavement fix, but they prevent a global road-system READY claim.
