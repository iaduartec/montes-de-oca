# Atribución — OpenStreetMap (ODbL)

Los archivos `roads.json`, `navigation.json` y `stats.json` de este directorio son una
**base de datos derivada** de OpenStreetMap. Se construyeron a partir de una consulta
a la Overpass API con la ventana jugable del juego.

```
© OpenStreetMap contributors
Licencia: Open Database License (ODbL) v1.0
https://opendatacommons.org/licenses/odbl/1-0/
Términos de uso de OSM: https://www.openstreetmap.org/copyright
```

## Trazabilidad de los datos

| Campo | Valor |
|---|---|
| Endpoint | `https://overpass-api.de/api/interpreter` |
| Consulta exacta | `data/roads/raw/osm_highways_window_query.txt` |
| SHA-256 de la respuesta | `98782f981b1cd50737aeae5a0f646010338676a26edc138420f697ed522b99ef` |
| Bytes | 529 998 |
| `osm3s.timestamp_osm_base` | `2026-09-24T22:33:36Z` |
| Descarga (UTC) | `2026-09-24T22:34:47+00:00` |
| BBox de la consulta (S, W, N, E) | `42.351242, -3.347844, 42.408475, -3.271696` |
| Manifiesto completo | `data/roads/raw/osm_highways_window_manifest.json` |

Cualquier regeneración con `scripts/roads/fetch_osm_roads.py` produce un SHA-256 nuevo
(datos de OSM que evolucionan); el manifiesto guarda siempre el último.

## Qué obliga la ODbL

1. **Atribución visible.** El crédito `© OpenStreetMap contributors` tiene que verse
   en la pantalla de juego o en el menú de créditos, con enlace a
   <https://www.openstreetmap.org/copyright> si hay pantalla de créditos.
2. **Share-alike (copyleft de datos).** Si redistribuís o publicás esta base de datos
   derivada (por ejemplo, subiendo `roads.json` a un CDN junto al juego), la base
   derivada tiene que ir bajo ODbL o compatible. La detección de "produced work"
   distingue la obra producida de la base de datos.
3. **Mantener la marca de provenance.** No hay que borrar los tags crudos ni los IDs
   de OSM de la salida: `roads.json` conserva `osmId` y `tags` completos justamente
   para que la atribución y la trazabilidad viajen con los datos.

## Qué NO cubre la ODbL

- El código del juego, el arte, las texturas, el audio y el diseño de gameplay
  (licencia del proyecto: MIT, ver `package.json`).
- Los valores **`width`** y **`speedFactor`** de cada vía: son **estimaciones de
  diseño** hechas por el equipo, no datos de OSM (aunque el tag `width` de OSM, cuando
  existe, tiene prioridad y se marca `widthSource: "osm_width"`).
- Las **tablas de clasificación** (`ROAD`/`TRACK`/`PATH`), de ancho por tipo y de
  penalización de velocidad: son trabajo propio.
- Las **coordenadas de mundo** (`worldX = E − 471500`, `worldZ = N − 4689000`): son una
  transformación de la proyección EPSG:25830 hacia el sistema local del juego; los
  datos fuente siguen siendo de OSM.

## Citar en el juego (texto sugerido)

> Map data © OpenStreetMap contributors, available under the Open Database License
> (ODbL) v1.0. Data snapshot: 2026-09-24 (Overpass API).
