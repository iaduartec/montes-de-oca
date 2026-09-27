import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const temp = mkdtempSync(resolve(tmpdir(), 'render-coordinates-'));
const source = readFileSync(resolve(root, 'src/render-coordinates.ts'), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
writeFileSync(resolve(temp, 'render-coordinates.mjs'), output);
let coordinates;
try {
  coordinates = await import(pathToFileURL(resolve(temp, 'render-coordinates.mjs')).href);
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const { logicalToRender, renderToLogical, logicalDirectionToRender, logicalYawToRender, renderYawToLogical } = coordinates;
const close = (actual, expected, epsilon = 1e-12) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected}`);

assert.deepEqual(logicalToRender({ x: 28.5, y: 71, z: 490 }), { x: 28.5, y: 71, z: -490 });
assert.deepEqual(renderToLogical({ x: 28.5, y: 71, z: -490 }), { x: 28.5, y: 71, z: 490 });
assert.deepEqual(renderToLogical(logicalToRender({ x: -350, y: 14.2, z: 2190 })), { x: -350, y: 14.2, z: 2190 });

const yaw = Math.PI / 6;
const renderYaw = logicalYawToRender(yaw);
close(renderYaw, Math.PI - yaw);
close(Math.sin(renderYaw), Math.sin(yaw));
close(Math.cos(renderYaw), -Math.cos(yaw));
close(renderYawToLogical(renderYaw), yaw);

assert.deepEqual(logicalDirectionToRender({ x: 2, y: -3, z: 6 }), { x: 2, y: -3, z: -6 });
const normalized = logicalDirectionToRender({ x: 0, y: 0, z: 4 }, true);
assert.deepEqual(normalized, { x: 0, y: 0, z: -1 });

assert.throws(() => logicalToRender({ x: Number.NaN, y: 0, z: 0 }), TypeError);
assert.throws(() => renderToLogical({ x: 0, y: 0, z: Number.POSITIVE_INFINITY }), TypeError);
assert.throws(() => logicalYawToRender(Number.NaN), TypeError);
assert.throws(() => logicalDirectionToRender({ x: 0, y: 0, z: 0 }, true), RangeError);

console.log('render coordinate boundary: 10/10 assertions passed');
