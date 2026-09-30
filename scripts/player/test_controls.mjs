// Comprueba el teclado real de PlayerControls con un EventTarget de Node: cada
// KeyboardEvent se entrega a los listeners del módulo y se valida su contrato.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const tmp = mkdtempSync(resolve(here, '.controls-test-'));
const source = readFileSync(resolve(root, 'src/player/controls.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false },
}).outputText;
writeFileSync(resolve(tmp, 'controls.gen.mjs'), js);

const previousWindow = globalThis.window;
const fakeWindow = new EventTarget();
Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });

let pass = 0;
const fails = [];
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`[OK  ] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fails.push(name);
    console.log(`[FALLA] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function key(type, code, repeat = false) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, { code: { value: code }, repeat: { value: repeat } });
  fakeWindow.dispatchEvent(event);
  return event;
}

try {
  const { createPlayerControls } = await import(`file://${resolve(tmp, 'controls.gen.mjs')}`);
  const controls = createPlayerControls();

  key('keydown', 'KeyW');
  check('W produce avance positivo', controls.readOnFoot().forward === 1 && controls.readOnFoot().turn === 0);
  key('keydown', 'KeyD');
  check('D produce giro a la derecha sin cambiar avance', controls.readOnFoot().forward === 1 && controls.readOnFoot().turn === 1);
  key('keydown', 'ShiftLeft');
  check('Shift activa correr', controls.readOnFoot().run);
  key('keyup', 'KeyW');
  key('keyup', 'KeyD');
  check('soltar W/D detiene avance y giro', controls.readOnFoot().forward === 0 && controls.readOnFoot().turn === 0);
  key('keydown', 'ArrowUp');
  check('las flechas verticales avanzan', controls.readOnFoot().forward === 1 && key('keydown', 'ArrowUp').defaultPrevented);
  key('keyup', 'ArrowUp');
  key('keydown', 'KeyA');
  key('keydown', 'KeyS');
  check('A gira a la izquierda y S retrocede', controls.readOnFoot().turn === -1 && controls.readOnFoot().forward === -1);
  key('blur', '');
  check('perder el foco suelta todas las teclas', controls.readOnFoot().forward === 0 && controls.readOnFoot().turn === 0 && !controls.readOnFoot().run);

  controls.setVirtualAxes(0.75, -0.4);
  check('el joystick entrega avance y giro', controls.readOnFoot().forward === 0.75 && controls.readOnFoot().turn === -0.4);
  controls.dispose();
} finally {
  if (previousWindow === undefined) delete globalThis.window;
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fails.length} checks OK`);
if (fails.length) process.exit(1);
console.log('TODO OK');
