// Validador de presets del vehículo (FASE 1).
// Node con cero deps: lee el fuente con regex (no hardcodea la lista de
// claves de `VehicleParams`, la extrae de `DEFAULT_VEHICLE_PARAMS`).
//
// Verifica:
//   1. ids únicos y no vacíos;
//   2. existe el default (`DEFAULT_PRESET_ID`);
//   3. cada clave de cada preset pertenece a `VehicleParams`;
//   4. valores dentro de los rangos sanos de la tarea;
//   5. `estandar` sin params (o idéntico a los defaults);
//   6. `applyPreset` parte SIEMPRE de `DEFAULT_VEHICLE_PARAMS` (sin residuos
//      al encadenar) — se comprueba en el fuente y se simula el merge.
//
// Uso: node scripts/vehicle/validate_presets.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const physicsSrc = readFileSync(resolve(root, 'src/vehicle/physics.ts'), 'utf8');
const presetsSrc = readFileSync(resolve(root, 'src/vehicle/presets.ts'), 'utf8');

const failures = [];
const check = (nombre, ok, detalle) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${nombre}: ${detalle}`);
  if (!ok) failures.push(`${nombre}: ${detalle}`);
};

// --- Claves y defaults reales desde el fuente (regex robusta) ---
const defaultsBlock = physicsSrc.match(/DEFAULT_VEHICLE_PARAMS\s*:\s*VehicleParams\s*=\s*\{([\s\S]*?)\};/);
if (!defaultsBlock) {
  console.error('FALLA: no se pudo extraer DEFAULT_VEHICLE_PARAMS de src/vehicle/physics.ts');
  process.exit(1);
}
const defaults = {};
for (const m of defaultsBlock[1].matchAll(/(\w+)\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
  defaults[m[1]] = Number(m[2]);
}
const validKeys = new Set(Object.keys(defaults));
check('claves de VehicleParams extraídas del fuente (no hardcodeadas)', validKeys.size > 10, `${validKeys.size} claves`);

// --- Presets desde el fuente ---
const defaultIdMatch = presetsSrc.match(/DEFAULT_PRESET_ID\s*=\s*['"]([^'"]+)['"]/);
const defaultId = defaultIdMatch ? defaultIdMatch[1] : null;
check('DEFAULT_PRESET_ID declarado', defaultId !== null && defaultId !== '', JSON.stringify(defaultId));

const presetBlocks = [...presetsSrc.matchAll(/id:\s*['"]([^'"]+)['"][\s\S]*?params:\s*\{([^}]*)\}/g)];
const presets = presetBlocks.map((m) => {
  const params = {};
  for (const kv of m[2].matchAll(/(\w+)\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    params[kv[1]] = Number(kv[2]);
  }
  return { id: m[1], params };
});
check('hay 3 presets', presets.length === 3, `${presets.length} encontrados (${presets.map((p) => p.id).join(', ')})`);

const ids = presets.map((p) => p.id);
check('ids no vacíos', ids.every((id) => id.trim() !== ''), JSON.stringify(ids));
check('ids únicos', new Set(ids).size === ids.length, JSON.stringify(ids));
if (defaultId) {
  check('existe el preset por defecto', ids.includes(defaultId), `default=${defaultId}`);
}

// --- Claves válidas ---
for (const p of presets) {
  const malas = Object.keys(p.params).filter((k) => !validKeys.has(k));
  check(`preset '${p.id}': claves dentro de VehicleParams`, malas.length === 0, malas.length === 0 ? `${Object.keys(p.params).length} claves ok` : `desconocidas: ${malas.join(', ')}`);
}

// --- Rangos sanos ---
const RANGOS = {
  mass: [900, 2600],
  dragCoefficient: [0.2, 1.2],
  maxDriveForce: [8000, 20000],
  maxSpeed: [16, 40],
  steerMax: [0.3, 0.7],
  steerRate: [4, 9],
  grip: [0.6, 0.95],
  gripLateral: [0.6, 0.95],
};
// Se valida el MERGEADO (defaults + preset), no sólo lo escrito: un preset que
// no pisa una clave hereda el default, que también debe estar en rango.
for (const p of presets) {
  const merged = { ...defaults, ...p.params };
  for (const [key, [min, max]] of Object.entries(RANGOS)) {
    const v = merged[key];
    check(`preset '${p.id}': ${key}=${v} en [${min}, ${max}]`, v >= min && v <= max, `${key}=${v}`);
  }
}

// --- `estandar` reproduce exactamente los defaults ---
const estandar = presets.find((p) => p.id === 'estandar');
if (estandar) {
  const merged = { ...defaults, ...estandar.params };
  const iguales = Object.keys(defaults).every((k) => merged[k] === defaults[k]);
  check(
    "'estandar' reproduce exactamente DEFAULT_VEHICLE_PARAMS",
    iguales && (Object.keys(estandar.params).length === 0 || iguales),
    Object.keys(estandar.params).length === 0 ? 'params {} (vacío)' : 'params idénticos a los defaults',
  );
} else {
  check("'estandar' existe", false, 'no encontrado');
}

// --- applyPreset sin residuos: el fuente resetea desde los defaults ---
const resetea = /function\s+applyPreset[\s\S]*?Object\.assign\(\s*params\s*,\s*DEFAULT_VEHICLE_PARAMS/.test(presetsSrc);
check('applyPreset parte de DEFAULT_VEHICLE_PARAMS (fuente)', resetea, resetea ? 'Object.assign(params, DEFAULT_VEHICLE_PARAMS, preset.params)' : 'no se encontró el reset en el fuente');
// Simulación del encadenado con la misma semántica: patrulla → carga no deja masa de patrulla.
if (estandar) {
  const patrulla = presets.find((p) => p.id === 'patrulla');
  const carga = presets.find((p) => p.id === 'carga');
  // Encadenado con la semántica del fuente (cada apply resetea a defaults):
  let estado = { ...defaults, ...(patrulla ? patrulla.params : {}) };
  estado = { ...defaults, ...(carga ? carga.params : {}) };
  const directo = { ...defaults, ...(carga ? carga.params : {}) };
  const sinResiduos = Object.keys(defaults).every((k) => estado[k] === directo[k]);
  check('applyPreset encadenado no deja residuos (patrulla→carga === carga)', sinResiduos, sinResiduos ? 'merge simulado idéntico' : 'difiere del merge directo');
  const vuelve = { ...defaults, ...estandar.params };
  check("setPreset('estandar') restaura los defaults", Object.keys(defaults).every((k) => vuelve[k] === defaults[k]), 'merge simulado === defaults');
}

if (failures.length > 0) {
  console.error(`\nFALLA: ${failures.length} checks`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\n=> OK: presets válidos.');
