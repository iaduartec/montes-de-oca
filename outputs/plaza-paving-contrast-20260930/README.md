# Plaza paving tone variation — 2026-09-30

Fixed comparison view: `plaza`, same camera position, target, resolution and scene settings. The GLB keeps the OSM footprint and road edge unchanged. Only the subtle linear colors assigned per 1 m paving cell changed: the four-color palette's channel range fell from 0.012 to 0.004 to soften the visible grid while retaining slight slab variation. This is an artistic surface treatment; no paving pattern is surveyed.

## Captured scene counts

- Draw calls: 33 before / 33 after.
- Scene triangles: 794,569 before / 794,569 after.
- Scene vertices: 1,901,838 before / 1,900,923 after.
- Plaza GLB: 148,624 bytes / 2,430 triangles before; 119,344 bytes / 2,430 triangles after.

Frame-time overlays are transient and are not used as a performance comparison. The square still has a broad, even surface at this camera distance; this iteration reduces the cell contrast rather than adding unverified stone joints or texture.
