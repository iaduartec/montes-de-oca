# ENGINE_SCAFFOLD — Esqueleto ejecutable del motor

FASE 2 / TASK PACKET S1. App Vite + TypeScript + Babylon.js que renderiza un
terreno a partir de un heightfield JSON, con sampler de altura/normal, cámara
libre y overlay de diagnóstico. Es la base sobre la que entra el DEM real
(IGN MDT05, 5 m, EPSG:25830) sin tocar el motor.

## Cómo correrlo

```bash
npm install
npm run make:dev-terrain   # genera public/terrain/dev-tile.json (procedural)
npm run dev                # http://127.0.0.1:5173
```

Chequeos:

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc --noEmit && vite build
```

Controles: **WASD/flechas** para volar, **mouse** para mirar (clic en el canvas
para capturar el puntero), **Shift** para acelerar. La cámara es una
`UniversalCamera` de Babylon, sin colisiones (todavía).

## Arquitectura

```
index.html                     canvas + overlay (#hud) + controles
src/config.ts                  carga y valida public/terrain/config.json
src/heightfield.ts             sampler: heightAt / normalAt / sampleHeight
src/terrain.ts                 carga tiles JSON y construye la malla
src/diagnostics.ts             FPS, frame time, draw calls, triángulos, vértices
src/main.ts                    Engine + Scene + luces + cámara + loop + overlay
scripts/make-dev-terrain.mjs   genera el tile procedural de arranque
public/terrain/config.json     origen, proyección, escala y lista de tiles
public/terrain/dev-tile.json   heightfield de prueba (generado)
```

### Independencia del mapa (cero números de Villafranca en el motor)

Ningún valor geográfico vive en `src/`. El origen, los factores de proyección y
la escala entran por `public/terrain/config.json`.

- La **única** ocurrencia del origen en todo `src/` está en
  `wgs84ToWorld()` (`src/config.ts`), que proyecta una coordenada WGS84 usando
  los datos del config. Mover el centro del mapa = editar el JSON.
- Los factores de proyección son **placeholders explícitos** (`0`) marcados en
  el JSON con `_note`: los define la FASE 2. **No se usa `102850`**, que es el
  factor de Shenzhen (latitud 22,5°). A la latitud de Villafranca (42,4°) la
  conversión longitud→metros es distinta (~82.240 m/°).
- `worldScale` es el factor unidades-de-mundo ↔ metros y también sale del config
  (placeholder `1`).

### Esquema del heightfield (idéntico a la referencia)

Los tiles se publican como `{schemaVersion: 1, id, grid}` y el grid es:

```ts
interface HeightfieldGrid {
  x0: number; z0: number;     // esquina (col 0, fila 0) en unidades de mundo
  dx: number; dz: number;     // paso por columna/fila, en unidades de mundo (> 0)
  columns: number; rows: number; // muestras por eje (>= 2)
  heights: number[];          // alturas en METROS, fila-mayor: heights[r*columns + c]
}
```

- **Invariante:** `heights.length === columns * rows`. Se valida al cargar
  (`assertValidGrid`) y también lo chequea el generador.
- Las **filas crecen hacia el norte (+Z)** y las **columnas hacia el este (+X)**.
- La interpolación parte cada celda **SW→NE** (diagonal de `(i,j)` a
  `(i+1,j+1)`), exactamente como el exportador del terreno de la referencia.
  Es la misma superficie que usa la física: no hay dos verdades.
- Fuera del grid, `heightAt` devuelve `0` (semántica de referencia).

### Normal por diferencias finitas

`normalAt(x, z)` se calcula por diferencias centrales sobre la altura del
heightfield — **no** a partir de los vértices de la malla — y aplica `worldScale`
para que la pendiente sea correcta en unidades de mundo:

```
dH/dx ≈ (H(x+e,z) - H(x-e,z)) / (2e)
dH/dz ≈ (H(x,z+e) - H(x,z-e)) / (2e)
normal = normalize(-dH/dx, 1, -dH/dz)     // Y-up
```

Los puntos de muestreo se recortan al dominio para no leer el `0` de afuera y
generar un acantilado artificial en el borde. `sampleHeight(x, z)` devuelve
`{height, normal}` en una sola llamada: es la API que va a consumir el 4x4 para
el pitch/roll.

### Escala y coordenadas

- **Y-up**; unidades de mundo = metros con `worldScale = 1`.
- `heights` está en metros; la malla aplica `height * worldScale`.
- Los colores de la malla son sólo legibilidad visual (gradiente por altura);
  no reemplazan texturas ni materiales de la FASE 2.

## Qué NO quedó hecho

- **Streaming y LOD**: hay un único tile. `loadTerrain` ya itera la lista del
  config y `resolveSampler` elige el tile que contiene un punto (o el más
  cercano), pero no hay carga/descarga dinámica ni niveles de detalle.
- **Datos reales**: `dev-tile.json` es procedural y determinista. Los factores
  de proyección y el origen son placeholders hasta que la FASE 2 exporte el
  heightfield desde el DEM. El factor `102850` queda explícitamente prohibido.
- **Física/vehículo, OSM, assets**: fuera del alcance de este paquete.
- **Calidad gráfica conmutables**: la referencia resuelve low/medium/high en
  `city-graphics-quality.ts`; acá se tomó sólo la idea (parámetros por perfil),
  sin portar los perfiles ni el panel.
- **Sombras**: la luz direccional está, pero no hay `ShadowGenerator`.
- **Texturas**: material plano con color por vértice.

## Decisiones y notas

- **Deep imports de Babylon** (`@babylonjs/core/...`) en lugar de importar la
  raíz: el bundle pasó de ~6 MB a ~1 MB (232 kB gzip).
- **Un solo importador de Babylon por módulo**: el engine vive en `main.ts`;
  `heightfield.ts` sólo importa `Vector3` (math pura, sin efectos).
- **Sin dependencias extra**: sólo `@babylonjs/core`, `vite` y `typescript`
  (mismas versiones `^` que la referencia). Sin React, sin motores de física.
- El overlay se actualiza cada 10 frames para no forzar reflow en cada frame.
