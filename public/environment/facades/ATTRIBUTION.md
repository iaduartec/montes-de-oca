# Procedural facade surfaces

The runtime generator is retained in `src/environment/facade-materials.ts`.
It creates original tileable masonry, plaster and brick profiles from arithmetic
patterns and deterministic grain. No photographs, downloaded textures, Google
imagery or third-party assets are included.

These are artistic material profiles. They do not establish the actual stone
courses, plaster condition, brickwork or colours of any particular building.
Building footprints and height sources remain independent of these profiles.

Each profile has a 256 × 256 albedo map (sRGB), normal map (linear) and packed
roughness map (linear; roughness green, nonmetal blue). Three profiles share nine
textures across the village. A tile spans 3.2 metres; normal relief does not move
geometry or alter collisions. Uncompressed RGBA maps consume approximately
3 MiB including mipmaps, before driver overhead. Maps are disposed with the
village. The generator is the reproducible source; no image files are required.
