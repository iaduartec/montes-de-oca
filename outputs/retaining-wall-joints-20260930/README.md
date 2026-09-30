# OSM retaining wall joints — 2026-09-30

Fixed camera: `retaining-wall-close`, scale 0.8, same URL parameters before and after. Captures are screenshots of the local game scene; no map imagery copied.

The mapped-wall layer contains 23 OSM barrier ways (ODbL; see `public/village/mapped-walls.json`). Alignment follows contributor-mapped OSM geometry. Wall height 0.65 m and width 0.30 m are artistic estimates where the source has no measured dimensions.

The renderer now gives each polyline corner a bounded miter, subdivides the resulting faces at the existing maximum 2 m spacing, and extends endpoints by half the estimated thickness so connected ways overlap. This targets cracks between adjacent wall solids without moving their mapped centerlines.

## Comparison

- Draw calls: 36 before / 36 after.
- Triangles: 799,899 before / 799,899 after.
- Vertices: 1,901,843 before / 1,901,843 after.
- Meshes: 37 before / 37 after.

The view shows two wall runs, but road/terrain surfaces obscure the junctions in the foreground. These captures do not establish a visible before/after seam improvement; inspect the junctions in a close editor view or corrected ground/road camera before making a visual-quality claim.
