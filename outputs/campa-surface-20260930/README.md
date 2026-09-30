# Oca meadow surface — 2026-09-30

Fixed comparison view: `campa-oca`, same position, target and scale before and after. These are local game captures; no orthophoto pixels are included.

The campa polygon remains the conservative interior trace from the IGN/CNIG PNOA orthophoto in `assets/environment/oca-site/source.json`; its edges, terrain-following heights, and area were not changed. Before, every clipped 5 m terrain triangle received a separate random tint. After, tint varies continuously at 14 m and 37 m scales across the surface, so adjacent DEM facets no longer introduce a color step. This is a stylized meadow surface, not surveyed vegetation.

## Captured scene counts

- Draw calls: 31 before / 31 after.
- Scene triangles: 778,460 before / 778,460 after.
- Scene vertices: 1,901,843 before / 1,901,776 after.
- Campa GLB: 12,868 bytes / 228 triangles before; 10,784 bytes / 228 triangles after.

Frame-time overlays vary between captures and are not used as a performance comparison. Some landscape terrain artifacts remain visible beyond the campa boundary and were not changed in this iteration.
