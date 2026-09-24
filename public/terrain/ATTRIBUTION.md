# Atribución — Terreno (IGN MDT05)

El terreno de este proyecto (`public/terrain/tiles/*.json`) se deriva del
**Modelo Digital del Terreno de paso de malla 5 m (MDT05)** del Instituto
Geográfico Nacional (IGN) / Centro Nacional de Información Geográfica (CNIG),
obtenido vía el WCS INSPIRE `https://servicios.idee.es/wcs-inspire/mdt`
(coverage `Elevacion25830_5`).

- **Titular:** © Instituto Geográfico Nacional (IGN) / CNIG.
- **Licencia:** CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
- **Origen de los datos:** vuelo LiDAR PNOA (PNOA-LiDAR).
- **Sistema de referencia:** EPSG:25830 (ETRS89 / UTM zona 30N).
- **Ventana:** E [471500, 477500] · N [4689000, 4695000] (6000 × 6000 m).

La atribución es **obligatoria** al distribuir el juego o cualquier captura o
asset derivado. Texto sugerido:

> Modelo Digital del Terreno © Instituto Geográfico Nacional (IGN-CNIG),
> CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Datos PNOA-LiDAR.

El detalle de la descarga (URL exacta, SHA256 y dimensiones) está en
`data/terrain/raw/fetch_manifest.json`.
