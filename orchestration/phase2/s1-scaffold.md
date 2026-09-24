# TASK PACKET S1 — Esqueleto ejecutable del motor (base de la FASE 2)

## Estándares del proyecto (auto-resueltos)
- `/home/kiri_/projects/montes-de-oca` es el repo de referencia **GTA_SZ / 深城纪** (ciudad de Shenzhen). Es **READ-ONLY**: podés leerlo, jamás modificarlo.
- Proyecto nuevo: `/home/kiri_/projects/montes-de-oca-offroad`. Todo tu output va ahí.
- Stack: Vite + TypeScript + Babylon.js. **Usá exactamente las mismas versiones** que `/home/kiri_/projects/montes-de-oca/package.json` para `@babylonjs/core`, `vite` y `typescript`.
- TypeScript estricto, sin `any` injustificado.
- Documentación en **español** técnico.
- **No hagas commits git.** Nunca agregues `Co-Authored-By` ni atribución de IA.
- Si descubrís algo no obvio, guardalo en engram con `mem_save` y `project: "montes-de-oca"` antes de terminar.

## Contexto
El juego es **"Montes de Oca: Offroad Stories"**, un mundo abierto rural 3D en el navegador (Babylon.js) ambientado en Villafranca Montes de Oca (Burgos, España). Reutilizamos el motor de GTA_SZ, que es una ciudad densa: nosotros necesitamos **terreno real** y **pistas forestales**.

La FASE 2 va a producir un heightfield a partir de DEM real (IGN MDT05, 5 m, EPSG:25830). Vos construís **el lado JavaScript** que lo va a consumir, más un tile de prueba procedural para que la app arranque sin esperar los datos reales.

## GOAL
Un esqueleto **mínimo pero real y ejecutable**: app Vite+Babylon que renderiza un terreno desde un heightfield JSON, con sampler de altura/normal, cámara libre, overlay de diagnóstico y el build funcionando.

## Deliverables (nombres exactos)
| Archivo | Qué es |
|---|---|
| `package.json` | deps + scripts `dev`, `build`, `typecheck`, `make:dev-terrain` |
| `tsconfig.json` | estricto |
| `vite.config.ts` | base razonable para un juego |
| `index.html` | canvas + overlay |
| `src/main.ts` | Engine + Scene + luz + cámara libre + arranque del terreno + overlay |
| `src/heightfield.ts` | sampler: `heightAt`, `normalAt`, `sampleHeight` |
| `src/terrain.ts` | carga tiles JSON y construye la malla |
| `src/diagnostics.ts` | FPS, frame time (ms), draw calls, triángulos, vértices |
| `src/config.ts` | lee `public/terrain/config.json` + tipos |
| `scripts/make-dev-terrain.mjs` | genera `public/terrain/dev-tile.json` procedural |
| `public/terrain/config.json` | origen, factores de escala, lista de tiles |
| `.gitignore` | `node_modules`, `dist`, `.venv`, `*.log` |
| `docs/ENGINE_SCAFFOLD.md` | qué hiciste, decisiones, cómo correrlo, qué falta |

## Reglas de arquitectura (CRÍTICAS — esto decide si el trabajo sirve)
1. **Cero números de Villafranca hardcodeados en el motor.** El origen, la proyección y la escala entran **por datos** desde `public/terrain/config.json`. La referencia tiene exactamente UNA ocurrencia de su origen en todo `src/`: mantené esa propiedad. Si mañana cambiamos el centro del mapa, no debe tocarse ni una línea de código.
2. **NO hardcodees `102850`.** Ese factor es de Shenzhen (latitud 22,5°). A la latitud 42,4° de Villafranca la conversión longitud→metros es **distinta** (~82.240 m/°). Los factores se leen del config. Dejá los valores como **placeholder explícito** (`0` o `1`) marcados con un comentario `// FASE 2 lo reemplaza`; no inventes los definitivos.
3. **El esquema del heightfield debe ser EXACTAMENTE el de la referencia**, para que los datos de la FASE 2 entren sin traducción. Leé `src/landmark-details.ts` (líneas ~1-60) y copiá la **semántica** (incluido el split de triángulos SW→NE en la interpolación):
   `{x0:number, z0:number, dx:number, dz:number, columns:number, rows:number, heights:number[]}`
   Escribí código **propio**, no copies el archivo entero. Documentá el invariante `heights.length === columns*rows`.
4. **Y-up. Unidades = metros del mundo.** La altura del heightfield es en metros; la escala mundo↔metros sale del config.
5. **`normalAt(x,z)` es obligatoria.** La vamos a usar para el pitch/roll del 4x4. Calculala por diferencias finitas del heightfield (no por vértices de la malla).
6. No copies contenido de Shenzhen: ni `city.json`, ni landmarks, ni tráfico, ni fachadas.
7. Un solo tile por ahora. **Nada de streaming/LOD** todavía (eso es otra tarea).

## MÉTODO
1. Leé `/home/kiri_/projects/montes-de-oca/package.json` y `src/landmark-details.ts:1-60`. Podés mirar `src/city-graphics-quality.ts` **sólo** para ver cómo la referencia resuelve el nivel de calidad — no lo portes completo.
2. Escribí los archivos.
3. `npm install`
4. `npm run typecheck` → debe pasar.
5. `npm run build` → debe pasar.
6. Levantá `npm run dev` en background, hacé `curl` a la URL y confirmá HTTP 200.
7. Si tenés Playwright disponible, sacá un screenshot a `output/scaffold.png`. **Si no está disponible, decilo y no inventes que lo hiciste.**
8. Confirmá que el overlay reporta FPS > 0 y draw calls > 0.

## CONSTRAINTS
- No toques el repo de referencia.
- Sólo estas deps: `@babylonjs/core`, `vite`, `typescript`. **Sin** React, sin motores de física, sin librerías de terreno.
- No inventes resultados de validación.
- No hagas commit.

## VALIDATION (obligatoria, es lo que decide si acepto el trabajo)
1. `npm run typecheck` y `npm run build` con su salida real.
2. `curl -I http://localhost:5173` (o el puerto que uses) mostrando el código HTTP.
3. Screenshot **o** declaración explícita de que Playwright no está disponible.
4. Pegá el contenido de `public/terrain/config.json`.

## RESPUESTA FINAL
Listá: archivos creados, comandos exactos + salida, el config, y **qué NO quedó hecho**. Si algo falla y no pudiste resolverlo, decilo explícitamente en vez de maquillarlo.
