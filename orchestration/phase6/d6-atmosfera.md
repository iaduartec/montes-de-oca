# PACKET d6-atmosfera — FASE I (atmósfera mínima)

## GOAL
Agregar a la escena lo que FALTA de atmósfera: **niebla ligera** y **sombras razonables**. No rehacer lo que ya existe.

## CONTEXT
- Babylon.js 8 (`@babylonjs/core` ^8.0.0). Node + TypeScript + Vite. **PROHIBIDO agregar dependencias.**
- **Lo que YA existe en `src/main.ts` y NO tenés que duplicar**:
  - `scene.clearColor = new Color4(0.53, 0.68, 0.82, 1)`
  - `new HemisphericLight('luz-ambiente', new Vector3(0.25, 1, 0.2), scene)`
  - `new DirectionalLight('sol', new Vector3(-0.45, -1, -0.35), scene)`
- **NO hay fog ni shadow generators en ninguna parte del proyecto.** Eso es lo que falta.
- Mundo: ventana 6000x6000 m. `worldX = E - 471500`, `worldZ = N - 4689000`, `worldY = absoluta - 870`. Los tiles de terreno y su malla están en `src/terrain.ts` (leelo para saber cómo se llaman los meshes).
- Convenciones del proyecto: **comentarios en español**, imports **por módulo** (`@babylonjs/core/Lights/directionalLight`), **jamás** `from '@babylonjs/core'` — el bundle ya pesa 1 MB.
- `exactOptionalPropertyTypes: true` está activo: **nunca** pases `undefined` explícito a una propiedad opcional (TS2379). Usá spread condicional.

## FILES — OWNERSHIP
**SOS EL ÚNICO ESCRITOR DE: `src/environment/atmosphere.ts` (archivo NUEVO).**
PROHIBIDO escribir en cualquier otro archivo. En particular NO toques:
`src/main.ts` (lo cablea el orquestador), `src/environment/vegetation.ts` y `src/environment/village.ts` (los escriben otros workers), `src/terrain.ts`, `src/vehicle/**`, `src/player/**`, `src/gameplay/**`, `index.html`, `package.json`.
Podés LEER todo lo que necesites. El ownership es de escritura.

## API EXACTA QUE TENÉS QUE EXPONER
El orquestador la cablea tal cual, así que no la cambies:

```ts
export interface AtmosphereOptions {
  /** Meshes que proyectan sombra: el 4x4, el personaje, el objetivo, los árboles. */
  shadowCasters?: AbstractMesh[];
  /** Meshes que reciben sombra: normalmente el terreno. */
  shadowReceivers?: AbstractMesh[];
  /** Niebla más densa (para pruebas A/B). */
  dense?: boolean;
}

export interface Atmosphere {
  readonly sun: DirectionalLight;
  readonly ambient: HemisphericLight;
  readonly shadowGenerator: ShadowGenerator | null;
  /** Centra el shadow map en el jugador para que la sombra no se corte a lo lejos. */
  follow(x: number, z: number): void;
  dispose(): void;
}

export function createAtmosphere(scene: Scene, options?: AtmosphereOptions): Atmosphere;
```

## CONSTRAINTS
- `scene.fogMode = Scene.FOGMODE_EXP2`. A 6000 m de ventana una niebla agresiva te tapa la ruta: querés **profundidad**, no bruma. **Elegí la densidad y justificala con números** (¿a qué distancia se pierde el horizonte? ¿a qué distancia está el objetivo?).
- **Sombras baratas, no bonitas**: UN solo `ShadowGenerator` sobre el sol, mapa chico (1024), `usePercentageCloserFiltering` o `useBlurExponentialShadowMap`. Sin sombras por mesh, sin SSAO, sin postprocess nuevo, sin node materials.
- `follow(x, z)` repoosiciona el sol para que el shadow map cubra lo cercano. Decidí el radio y justificalo.
- Sin acne ni peter-panning: ajustá `bias`/`normalBias` y **decí los valores**.
- No quemes el terreno: si tocás intensidades, que sea coherente con las luces que ya existen.
- Nunca agregues `ShadowGenerator` a los 36 tiles de terreno: los tiles RECIBEN, no proyectan.

## DELIVERABLE
1. `src/environment/atmosphere.ts` con la API exacta de arriba.
2. `scripts/environment/verify_atmosphere.mjs`: verifica con Node lo que sea verificable sin Babylon — que `follow()` mantenga el sol dentro del radio declarado, y que la visibilidad que promete la densidad de niebla elegida coincida con la cuenta. **Patrón obligatorio**: mirá `scripts/terrain/validate_terrain.mjs` (transpila el TS con `typescript` y llama al módulo real; **NO reimplementes** la fórmula en el test).
3. En tu respuesta final, un bloque de 10–20 líneas: qué niebla, qué sombras, qué números, y **por qué esos**.

## VALIDATION (obligatoria; reportá el resultado CRUDO)
- `npx tsc --noEmit` → debe dar limpio. Si falla por archivos de OTROS workers a medio escribir, decilo y reportá solo los errores de tu archivo.
- `node scripts/environment/verify_atmosphere.mjs` → pegá la salida.
- **NO podés verificar visualmente** (no hay navegador acá y el orquestador hace el cableado y las capturas). **NO afirmes que "se ve bien"** ni que las sombras quedaron lindas: eso sería mentir.

## REPORTÁ AL FINAL (máximo 25 líneas)
`STATUS` · `FILES` · `CHANGES` · `TESTS` (comando + salida cruda) · `RISKS` · `RECOMMENDATION`.
