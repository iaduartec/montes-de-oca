# Nuestra Señora de Oca — wall base following terrain — 2026-09-30

Fixed comparison view: `oca-grounding`, same exterior camera before and after. The vertical profile is based on the site's DEM/MDT samples and follows only the existing OSM chapel outline. No new wall, terrace, or access route was inferred.

Before, every long outline wall began at one flat elevation, 0.30 m below the terrain at the building anchor. The mapped outline's vertices differ from that anchor surface by approximately -0.90 m to +1.00 m, so this made some lower wall portions float above lower ground or sink into higher ground. After, lower wall edges sample the same terrain surface at intervals no greater than 2 m, with a small 0.12 m embedment. Wall tops, mapped footprint, roof, and entrance remain unchanged. Building heights remain approximate from 2017 photographs.

## Scene counts from the fixed captures

- Draw calls: 38 before / 38 after.
- Scene triangles: 703,817 before / 703,879 after (+62).
- Scene vertices: 1,901,776 before / 1,901,838 after (+62).
- Oca site GLBs: 418,292 bytes / 6,576 triangles after, up from 418,292 bytes / 6,514 triangles.

Frame-time overlays are transient and not used as a performance comparison. The close captures show the wall base geometry change; irregular bright/dark terrain patches around the chapel remain visible and are a separate terrain/texture issue.
