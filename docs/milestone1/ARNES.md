# Arnés — Milestone 1 (Villafranca → Pista → Objetivo → Regreso)

`node scripts/milestone/drive_milestone.mjs [--out-dir output/milestone1] [--port 4183] [--base http://127.0.0.1:4183] [--budget-s 300] [--no-build]`

**Qué hace**: levanta `vite preview` (build previo salvo `--no-build`) + Chrome headless por CDP con el WebSocket nativo de Node (sin Playwright, cero deps). Elige el puerto CDP libre. Conduce la ruta con pure-pursuit sobre `route.polyline` y avanza mundo **y misión** con `player.inject()` + `player.step(1/60)`. Escribe `01..07*.png` y `drive_report.json`.

**Checks** (24, exit 0 sólo si pasan todos): API `__game` presente, spawn sobre `route.start`, |y−terreno| ≤0,5 m, entra y baja del 4x4, llega a `TARGET_REACHED` dentro de `--budget-s`, sin atasco (>5 s <0,5 m/s), sobre la polilínea (desvío ≤15 m) y velocidad ≤20 m/s, **reparar desde el coche NO funciona**, repara a pie manteniendo E (`REPAIRED`), re-entra (`RETURNING`), vuelve y `COMPLETED`. Cualquier excepción o `console.error` = FAIL.

**Camino de error probado**: `--budget-s 3` sale ≠0 reportando `distancia_restante_m` y la última pose.

**FPS**: en headless con SwiftShader es CPU ⇒ **NO es señal de rendimiento**. Válidos: draw calls y triángulos. El FPS real se mide en la GPU del usuario a 1920×1080 (~60 fps en RTX 2070).

**Integración `main.ts` ↔ controles**: al principio el flanco de F se levantaba y nadie lo consumía, así que **la tecla no hacía nada** — bug encontrado jugando y por la sonda del arnés, por caminos independientes. Ya está cableado. El arnés entra, baja y re-entra con **`KeyF` real despachada por CDP** (`Input.dispatchKeyEvent`), no con la API; resultado en `report.pulsacion_f`. La sonda `inject({toggle:true})` queda en `report.inject_toggle` como test de regresión.
