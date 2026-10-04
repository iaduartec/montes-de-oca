# Village fidelity source integration review

Reviewed at HEAD `349d98494c1108060e6a0cf7f87f4803701c6a07` with the shared dirty worktree intact. This review is read-only apart from this report.

## Findings

### Acceptance ledger is still pending

The five runtime targets are present in `VILLAGE_BUILDING_OVERRIDES`, and the source-phase evidence validator passes 164 checks. The ledger still labels all five building targets `evidence-ready` with `implementation.status: pending`, however. Consequently, `node scripts/environment/validate_real_structure_evidence.mjs --phase=village` exits 1 with 10 failures: each target fails both “correction accepted” and “parameters match runtime”. The source gate therefore verifies provenance and consistency, not release acceptance.

The broad `--phase=final` gate also exits 1: it reports six outstanding evidence blockers, three older corrected targets without comparison images, and the five village targets still pending. Those older records are outside this village-only source review. Do not report the evidence release gate as complete. After the independent final visual review, update the five village implementation records and parameters if the results support acceptance, then rerun the village phase. Preserve the other blockers as separate work.

### 474649085 preserves the previous gable maximum

The baseline runtime gable placed its ridge at `topY + rise`. The current override sets `gablePeakRise: 1`, so `gablePeakY` remains `topY + rise`; `building.heightM` and the LiDAR/OSM height source are not recomputed. The NullEngine test measures the built roof mesh maximum for 474649085 against this value, and checks 818885706 against its previous shed maximum at `topY`. This is consistent with the scoped height contract.

### Concave gable clipping and no-op control

Gable roofs now use ear-clipped footprint triangles. Wall strips are subdivided at roof-boundary crease vertices, so the rendered roof boundary and wall top share positions and heights. The test checks actual Babylon buffers for both target gables: triangle centroids are inside the footprint, projected roof area matches, boundary vertices join wall tops, and roof maxima match. Its pure geometry checks additionally verify every vertex for the concave gable and compact hip, plus the compact hip’s end planes, area, and maximum.

The clipping path applies to every gable, including ordinary procedural gables. The no-op control 310174514 has no per-building override; its fixed before/after captures use the same camera and show no apparent shape change. That is useful visual control evidence, though the assertion in the source test itself only checks that the selector returns no override for this ID. Keep the change described as a global safe gable tessellation used to repair the targeted concave case; do not claim every non-target gable is byte-for-byte unchanged.

### Facade registry is a narrow optional input

`facadeKitsByBuilding` connects per-ID building/evidence/artistic kit sources to the procedural detail selector. Precedence is building, evidence, artistic, then stable hash fallback. Existing pilot GLB styling keeps precedence over this registry. The runtime test verifies that an evidence kit changes shutter geometry; selector tests verify source precedence.

The production `loadVillage` call does not supply this optional registry, so normal game defaults remain hash-selected and no per-building evidence-driven facade map is active. This is an integration hook for procedural buildings, not completion of a facade V2 system. OSM/PNOA roof evidence does not support facade claims.

### Evidence and inventory tooling

`register_user_photo.py --check` passes for nine local records. The records remain local references; unknown authors, dates, and permissions remain unknown, and no source pixels are shipped. This preserves the intended evidence boundary.

`audit_village_fidelity.mjs --check --out=outputs/village-fidelity-20261004/inventory/village-buildings.json` passes for 330 buildings (20 tier A, 59 tier B, 251 tier C). The inventory explicitly reports proximity rather than camera visibility and labels facade kits as artistic reconstruction. Its hashes do not encode `facadeKitsByBuilding`; it is not evidence of an applied facade registry.

## Validation reviewed

- `npm run test:village-fidelity`: passed in `outputs/village-fidelity-20261004/final-corrected/gates.tsv`; includes the actual NullEngine mesh checks, roof-shape checks, facade-kit checks, source evidence validator, and photo registry check.
- Typecheck, build, aggregate test, runtime, road-surface, water-contact, and motorcycle gates: all exit 0 in `outputs/village-fidelity-20261004/final-corrected/gates.tsv`.
- `node scripts/environment/validate_real_structure_evidence.mjs --phase=source`: passed, 164 checks; six blockers remain declared.
- `node scripts/environment/validate_real_structure_evidence.mjs --phase=village`: failed as described above, 10 failures out of 195 checks.
- `node scripts/environment/validate_real_structure_evidence.mjs --phase=final`: failed as described above; not a village-only release gate.
- `python3 scripts/environment/register_user_photo.py --check`: passed, nine records.
- `node scripts/environment/audit_village_fidelity.mjs --check --out=outputs/village-fidelity-20261004/inventory/village-buildings.json`: passed, 330 buildings.

## Review blockers and limits

For a source-only village commit, I found no blocker in the roof mesh invariants or height preservation covered by the current tests. Before calling the five fixes accepted, the evidence ledger still needs implementation statuses/parameters reconciled with the reviewer’s decision, and the final comparison capture must be refreshed from the stable source. The existing `after/capture-report.json` is timestamped `2026-10-04T17:19:31.757Z`, before the `19:41` local final-corrected test log; those images are not proof of the final stable source visuals.

The roof models remain plan/roof reconstructions from orthophotos: compound roof sections, ridge axes, pitches, materials, and small glazing details are not all measured. Preserve those limitations in the target ledger. No human manual gameplay or facade verification is claimed.

## Integration addendum (root, 4 October 2026)

The findings above describe the reviewer’s earlier snapshot and remain preserved. The five ledger records were subsequently reconciled with exact runtime parameters and the independent final visual decisions: four roof corrections ACCEPT, Hospital ACCEPT_APPEARANCE_ONLY with compound massing still blocked. The refreshed AFTER report contains twenty-one views with per-view origin/source hashes; native spawn and NPC were refreshed from the stable built preview. `test:village-fidelity:final` now passes 220 checks. The global `test:real-structures:final` still fails seven checks for historical missing captures and six declared blockers. The optional facade registry and global gable tessellation limits described above remain unchanged.
