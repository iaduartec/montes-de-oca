# Revisión de HEAD — 2026-09-30

Auditoría de solo lectura sobre `main` en `8df8ee8` («test(audio): record browser gameplay
and ambience evidence»). No se modificó código. Objetivo: decir **qué mejoraría y en qué
orden**, con evidencia.

- Alcance: repositorio completo, gates del repo, capturas ya registradas en `outputs/runtime-v2/`
  y `output/runtime-v2/final/drive_report.json`.
- Método: lectura de código + ejecución de los gates + inspección directa de las capturas
  del ciclo de misión. **No ejecuté el juego yo mismo** en esta pasada: usé la evidencia
  versionada del 2026-09-30 14:06Z (7 capturas + `drive_report.json`) y la comparé con HEAD.
- Datos de FPS: **todos** son Chrome headless / SwiftShader (CPU). El propio informe del
  proyecto lo advierte. **No son señal de rendimiento de GPU.**

## 1. Estado de los gates (medido en HEAD)

| Gate | Resultado |
| --- | --- |
| `npm run typecheck` | verde (sin salida) |
| `npm run build` | verde, 6,35 s |
| `npm test` | verde, `EXIT=0`, 815 líneas, 0 `FAIL`/`ERROR` |
| Arnés de conducción (`drive_report.json`) | 28 checks, **0 errores de consola**, misión `COMPLETED` |

El proyecto **no está roto**. El loop jugable está completo y verificado de punta a punta:
`elapsedS` 390,85 s, `repairProgress` 1, `state` `COMPLETED`, `distanceToReturnM` 1,82 m.

Bundle: un único chunk `index-*.js` de **2.298 kB (590 kB gzip)**. Sin code splitting.

## 2. Clasificación de sistemas

### CONSERVAR (no tocar)

| Sistema | Evidencia |
| --- | --- |
| Pipeline de terreno MDT05 / EPSG:25830 / PNOA | 36 tiles, 60 pares de costura con **diff 0 m**, DEM 870–1194 m, interpolación triangular verificada a 2,3e-13 m |
| Física del 4x4 | `physics.ts:294-295` proyección real de gravedad sobre el plano tangente; `:299-304` tracción = `μ·N` con `N` **disminuyendo** en pendiente; `:357` arrastre de rodadura y aerodinámico separados; `:375-383` guiñada limitada por agarre lateral; `:446-452` subpasos de 1/120 s |
| Sistema de superficies | `world/surfaces.ts:21-28` seis superficies con `grip`/`lateralGrip`/`brakingGrip`/`rollingResistance`/`roughness`/`dust`; índice espacial de 32 m; media de las 4 huellas (`physics.ts:410-432`) |
| Suspensión de 4 puntos | residual 0,1 mm en NullEngine (rampa, bache, plano, swap de GLB) |
| Ciclo de vida de tiles | 16 mallas residentes de 36; payload de buffers GPU −55,6 %; cola cooperativa de frames |
| Máquina de estados de misión | `mission.ts` pura, testeable; dos radios separados (llegada 25 m vs reparación 6 m) — decisión correcta y bien documentada |
| Presets de calidad | `runtime/quality.ts:28-45`, LOW/MEDIUM/HIGH/ULTRA con presupuestos monótonos |
| Datos reales | 329 edificios (265 ajustados por LiDAR), 33.119 instancias de vegetación, red vial OSM drapeada |

### MEJORAR (máximo retorno)

1. **Sombras.** Medido: **10 shadow casters** en la vista de pueblo con 329 edificios y
   33.119 instancias de vegetación. `main.ts:1049-1053` registra solo vehículo, jugador,
   10 NPC y el repetidor. El radio es 100 m (`quality.ts:38`) y el mapa 1024² → 0,195 m/téxel.
   Las capturas confirman el resultado: la escena lee **plana**, sin contacto visual entre
   objetos y suelo.
2. **Material del terreno.** `terrain.ts:416-432`: `PBRMaterial`, `metallic 0`,
   `roughness 0.96`, `albedoTexture` = ortofoto, y **ningún mapa de normales ni textura de
   detalle**. A distancia media el resultado es bueno; a ras de suelo (`static-final/track.png`)
   el suelo es una mancha borrosa sin micro-relieve ni variación de rugosidad.
3. **Personaje y NPC.** `player/index.ts:103-333`: el jugador es el GLB de Kenney
   (`field-player.glb`), de proporciones caricaturescas y cabeza sobredimensionada. En
   `final/06_interaction.png` el personaje está junto a un 4x4 GLB semi-realista y el
   contraste de estilo es evidente. `AGENTS.md` exige explícitamente proporciones humanas
   coherentes. Los 10 NPC reutilizan el mismo criterio.
4. **PISTAS OFFROAD (TRACK/PATH).** La red existe y el *grip* funciona, pero visualmente
   la pista es una **cinta marrón plana**: sin rodadas, sin grava, sin bordes irregulares,
   sin zonas de barro. Es el sistema con mayor distancia entre lo que ya hay y lo que pide
   el backlog.
5. **Distribución de vegetación.** `build_vegetation.mjs:66,80` siembra `field-trees` a
   razón de **1 árbol por ~667 m² de cultivo**, uniforme. En la vista aérea eso se lee como
   ruido de puntos verdes equidistribuidos, justo el «patrón procedural evidente» que
   `OBJECTIVE.md` pide evitar. Los árboles aislados existen en el páramo castellano, pero
   se concentran en linderos y vaguadas, no en el centro de la parcela.
6. **Suelo lavado a ras de suelo.** En `static-final/village.png` y `final/02_road.png`
   aparecen manchas claras/blancas de bordes suaves sobre el terreno alrededor del pueblo.
   **No he determinado la causa**; hipótesis a descartar en este orden: (a) ausencia de
   rugosidad/normal a ángulo rasante, (b) parches de suelo del pueblo con material propio,
   (c) albedo de la ortofoto en parcelas pálidas. Requiere una captura dirigida antes de
   tocar nada.
7. **Catálogo de vehículos.** `catalog.ts:51-91` declara 8 vehículos, pero en `public/vehicles/`
   hay **un solo GLB** (`four-door-utility.glb`, 302 kB). Los otros 7 son cuerpos de
   primitivas con `setAppearance` (`model.ts:92-448`). Funciona y está testeado, pero es
   exactamente el caso que `AGENTS.md` marca: primitivas que **no deben presentarse como
   arte final**.
8. **Audio.** Primera pasada sintetizada, sin grabaciones ni ambiente espacial completo.
   El propio `outputs/runtime-v2/README.md` lo declara.

### REFACTORIZAR

- **`src/main.ts` sigue en 1.673 líneas** (el mayor del repo tras `village.ts`). La
  prioridad P1 del backlog pedía extraer `UiRuntime`/`InputRuntime`/etc.; solo se extrajo
  el HUD de misión. Es un habilitador, no una mejora visible: no lo pondría por delante de
  los puntos 1–4.
- **Bundle monolítico de 2,3 MB.** No hay `manualChunks` ni carga diferida. Afecta al
  tiempo hasta el primer frame, que hoy es **`loadAndSettleMs` ≈ 11,9 s**.

### REEMPLAZAR

- **Nada.** No hay ningún sistema que justifique un rewrite. Los veredictos `REWRITE` de
  `docs/audit/` se referían al proyecto de referencia (Shenzhen), no a este.

## 3. Riesgo abierto que bloquea decisiones

**El rendimiento en la GPU objetivo no está validado.** El objetivo declarado es 60 FPS
estables a 1080p/1440p en RTX 2070. Todas las cifras existentes son SwiftShader. Además:

- Vista de pueblo: 53 draw calls / **913.661 triángulos** / 51 mallas activas.
- Vista aérea: 46 draw calls / 903.900 triángulos, con `vegetationRadii.arbol` hasta 900 m.
- Pico registrado en el arnés: **1.678.739 triángulos / 177 draw calls**.

Con un presupuesto de 320.000 triángulos «en vista» validado para el terreno, los ~900.000
triángulos totales de la escena de pueblo indican que **la vegetación y el pueblo dominan el
coste**, no el terreno. Cualquier plan de mejora visual que añada geometría (sombras,
detalle de pista, NPC) debe medirse primero en hardware real o el trabajo se hará a ciegas.

## 4. Orden de trabajo que propondría

| # | Trabajo | Por qué en esta posición |
| --- | --- | --- |
| 0 | **Medir en la RTX 2070** (1080p y 1440p, HIGH) con el mismo arnés | Es un gate, no una feature. Si el margen es estrecho, cambia todo lo de abajo |
| 1 | **Sombras**: subir casters con presupuesto explícito (edificios del pueblo, vegetación por LOD, no las 33k) y validar radio/resolución | Mayor ganancia visual por unidad de trabajo; el código ya está aislado en `atmosphere.ts` |
| 2 | **Detalle del terreno**: mapa de normales/detalle + variación de rugosidad por superficie | Elimina la lectura «borrosa» a ras de suelo, que es la vista más frecuente jugando |
| 3 | **Diagnóstico de las manchas claras** (captura dirigida, sin arreglar a ciegas) | Puede ser un bug de material, no un gusto; hay que saberlo antes de la pasada de render |
| 4 | **Personaje/NPC con proporciones humanas** (Quaternius UAL ya está en `assets/characters/`) | Cumple `AGENTS.md` y es el elemento más visible en cada captura a pie |
| 5 | **PISTAS OFFROAD**: rodadas, grava, bordes irregulares, barro puntual | Cierra el hueco más grande entre el backlog y lo entregado |
| 6 | **Vegetación por linderos/vaguadas** en vez de uniforme | Barato (es un script de build) y mejora mucho la vista aérea |
| 7 | **Vehículos**: decidir si los 7 cuerpos procedurales se aceptan como estilo o se sustituyen por GLB | Es una decisión de arte antes que de código |
| 8 | `main.ts` + code splitting | Habilitadores; al final, con el resto estable |

## 5. Límites de esta revisión

- **No ejecuté el juego** en esta pasada; usé capturas y métricas versionadas del mismo día
  contra HEAD sin cambios desde `8df8ee8`.
- **No medí** FPS, frame time ni memoria en GPU real.
- **No verifiqué** el tacto de conducción con volante/teclado (el arnés inyecta entrada).
- La causa de las manchas claras del apartado 2.6 es **una hipótesis, no un diagnóstico**.
- El árbol de trabajo tiene ficheros sin seguimiento (`*:Zone.Identifier` de WSL/Windows) y
  scripts de `orchestration/` modificados. **No los toqué ni los commiteé.**
