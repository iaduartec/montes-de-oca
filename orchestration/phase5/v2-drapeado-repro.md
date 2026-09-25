# TAREA v2-drapeado-repro — verificación independiente de la FASE 3b

**Modelo**: `opencode/mimo-v2.6-flash-free`
**Rol**: VERIFICADOR. No implementás nada: reproducís, comparás y reportás.

## 0. Contexto en una frase

Otro worker (`d1-drapeado`) drapeó la red vial real (438 segmentos, 139 km) sobre
el terreno y publicó mediciones. Tu trabajo es **reproducirlas de cero y decir si
coinciden**. No tenés que confiar en él ni en mí.

## 1. Lo publicado — NO lo toques, es tu línea de base

`output/draping_verify/publicado_d1.json`
sha256 = `238b6e4d6cb5db6962752051a00d713f6c68646aa38919084410bf6d6cc8e0ea`

Los números que tenés que intentar reproducir:

| Medición | Publicado |
| --- | --- |
| `perf_sin_vias.drawCalls` | 13 |
| `perf_con_vias.drawCalls` | 16 |
| `perf_sin_vias.triangles` | 240360 |
| `perf_con_vias.triangles` | 317666 |
| `perf_con_vias.vertices` | 1524508 |
| `stats.meshes` | 3 |
| `stats.vertices` | 69616 |
| `stats.triangles` | 77306 |
| `stats.roads` | 438 |
| `stats.bridges` | 20 |
| `audit_app.classes.TRACK.pavement.p95` | 4.272460918741672e-05 |
| `audit_app.classes.PATH.pavement.p95` | 4.394531248408384e-05 |
| `audit_app.classes.ROAD.skirt.p95` | 4.165649409770822e-05 |
| `audit_app.classes.ROAD.pavement.p50` | 0.18359863281250455 |
| `audit_app.classes.ROAD.pavement.max` | 1.3235180664063364 |

## 2. Qué hacer, exacto

1. `npm run build` — tiene que salir exit 0.
2. Levantá el preview en background: `npm run preview -- --port 4173`
   OJO: **el script de captura NO levanta el server**, espera
   `http://127.0.0.1:4173`. Confirmá con:
   `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173` → `200`
3. Corré la reproducción escribiendo en OTRO directorio:
   `node scripts/roads/draping/capture_draping.mjs --out-dir output/draping_verify/reproduccion`
4. Compará campo por campo contra `publicado_d1.json`. Usá un script propio para
   comparar (así no se te escapa un campo); imprimí los deltas.
5. Bajá el server cuando termines (`kill` del proceso de preview).

## 3. Reglas duras

- **NO modifiques**: `src/**`, `public/**`, `data/**`, `scripts/roads/**`,
  `docs/roads/DRAPING_FASE3B.md`. Son de SOLO LECTURA para vos.
- **NO sobrescribas** `output/draping_verify/publicado_d1.json`. Por eso el paso 3
  usa `--out-dir output/draping_verify/reproduccion`.
- **NO agregues dependencias.** Cero.
- **NO commitees.** Commitea el orquestador.
- Si algo no se reproduce, **decilo con los números**. Un "no pude reproducir X"
  honesto vale muchísimo más que un OK falso. Nadie te va a castigar por un
  hallazgo: te van a castigar por inventar.

## 4. Qué reportar

Escribí `docs/roads/VERIFICACION_FASE3B.md` con:

- Una tabla: `campo | publicado | reproducido | delta`.
- ¿Coinciden **exacto** los draw calls y los triángulos? Sí o no.
- ¿Los residuales de TRACK/PATH dan ~4e-5 m (el piso de `Float32`)?
- El `stats` de la red (438 vías, 3 mallas, 69616 vértices, 77306 triángulos):
  ¿coincide?
- **Cualquier cosa que te parezca rara, aunque no te la haya pedido.** Es la parte
  más valiosa de tu informe. Si algo no cierra, decilo aunque no sepas por qué.
- Los PNG que genere tu corrida van a `output/draping_verify/reproduccion/`;
  no los interpretes vos, no es tu tarea.

## 5. Criterio de éxito

- build exit 0 y server arriba.
- El capture corre sin excepción y escribe su JSON.
- draw calls y triángulos: coincidencia **EXACTA**.
- Residuales: dentro de `1e-6` de lo publicado, o explicás la diferencia.
- Si **no** coinciden, el informe lo dice con los números y **eso es un resultado
  válido**. No fuerces un OK.

## 6. Al terminar, antes de volver

Guardá en Engram con `mem_save`:
`project: "montes-de-oca"`, `topic_key: "roads/verificacion-fase3b"`,
`type: "discovery"`. Contenido: qué reproduciste, qué coincidió exacto, qué no y
por qué, y cualquier rareza.
