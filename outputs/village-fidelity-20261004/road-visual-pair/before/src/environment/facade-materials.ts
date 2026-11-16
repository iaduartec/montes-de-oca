import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import type { Scene } from '@babylonjs/core/scene';

/** Original procedural surfaces: artistic material profiles, not surveyed facades. */
type Surface = 'stone' | 'plaster' | 'brick' | 'grass' | 'tile';
export type FacadeSurfaceCache = Map<string, readonly RawTexture[]>;
const SIZE = 256;
export const FACADE_TILE_METRES = 3.2;
export const CAMPA_TILE_METRES = 4;

function grain(x: number, y: number, seed: number): number {
  let h = Math.imul(x + seed * 131, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Periodic interpolated grain: organic variation without directional waves. */
function patchNoise(x: number, y: number, cells: number, seed: number): number {
  const px = x / SIZE * cells, py = y / SIZE * cells;
  const ix = Math.floor(px), iy = Math.floor(py);
  const sx = px - ix, sy = py - iy;
  const tx = sx * sx * (3 - 2 * sx), ty = sy * sy * (3 - 2 * sy);
  const at = (dx: number, dy: number) => grain((ix + dx) % cells, (iy + dy) % cells, seed);
  const lower = at(0, 0) * (1 - tx) + at(1, 0) * tx;
  const upper = at(0, 1) * (1 - tx) + at(1, 1) * tx;
  return lower * (1 - ty) + upper * ty - 0.5;
}

function maps(scene: Scene, surface: Surface): readonly RawTexture[] {
  const height = new Float32Array(SIZE * SIZE);
  const albedo = new Uint8Array(SIZE * SIZE * 4);
  const normal = new Uint8Array(albedo.length);
  const roughness = new Uint8Array(albedo.length);
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const index = y * SIZE + x;
    const fine = grain(x, y, 3);
    let mortar = false;
    let variation = 0;
    if (surface === 'stone') {
      // Uneven courses and different block widths keep rubble stone distinct
      // from brick. All offsets are periodic across the texture boundary.
      const warpedY = (y + patchNoise(x, 0, 8, 13) * 5 + SIZE) % SIZE;
      const row = Math.floor(warpedY / 32);
      const shifted = (x + grain(row, 0, 19) * SIZE) % SIZE;
      const weights = Array.from({ length: 4 }, (_, column) => 0.65 + grain(column, row, 23));
      const total = weights.reduce((sum, weight) => sum + weight, 0);
      let edge = 0, joint = SIZE, selected = 0;
      for (let column = 0; column < weights.length; column++) {
        const next = edge + weights[column]! / total * SIZE;
        if (shifted >= edge && shifted < next) {
          joint = Math.min(shifted - edge, next - shifted);
          selected = column;
          break;
        }
        edge = next;
      }
      mortar = Math.min(warpedY % 32, 32 - warpedY % 32) < 1.1 || joint < 1.2;
      variation = grain(selected, row, 7) - 0.5;
    } else if (surface === 'brick') {
      const row = Math.floor(y / 8);
      const shifted = (x + (row % 2) * 8) % SIZE;
      const column = Math.floor(shifted / 16);
      mortar = y % 8 < 1 || shifted % 16 < 1;
      variation = grain(column, row, 7) - 0.5;
    }
    const broad = patchNoise(x, y, 4, 31) * 0.7 + patchNoise(x, y, 11, 37) * 0.3;
    height[index] = surface === 'plaster'
      ? 0.5 + (fine - 0.5) * 0.035 + broad * 0.012
      : mortar ? 0.28 : 0.55 + variation * 0.08 + (fine - 0.5) * 0.055;
    const value = surface === 'plaster'
      ? 244 + broad * 3 + (fine - 0.5) * 8
      : mortar ? 205 + fine * 10 : 231 + variation * 29 + (fine - 0.5) * 12;
    const pixel = index * 4;
    if (surface === 'tile') {
      // Ceramic channels run along V; 20 cm widths and 40 cm courses.
      const column = Math.floor(x / 16), row = Math.floor(y / 32);
      const channel = (1 - Math.cos((x % 16) / 16 * Math.PI * 2)) * 0.5;
      const joint = y % 32 < 1;
      const tint = grain(column, row, 59) - 0.5;
      height[index] = 0.5 + channel * 0.38 - (joint ? 0.08 : 0) + (fine - 0.5) * 0.008;
      const ceramic = 236 + tint * 15 + (fine - 0.5) * 5 - (joint ? 14 : 0);
      albedo.set([ceramic, ceramic * 0.98, ceramic * 0.96, 255], pixel);
      roughness.set([255, 218 + tint * 16 + fine * 12, 0, 255], pixel);
    } else if (surface === 'grass') {
      // Soft irregular turf patches replace the previous repeated wave bands.
      const patch = patchNoise(x, y, 3, 41) * 0.6 + patchNoise(x, y, 7, 43) * 0.4;
      const blade = Math.max(0, patchNoise(x, y, 61, 47)) * 0.08;
      const grassValue = 218 + patch * 17 + (fine - 0.5) * 15;
      height[index] = 0.5 + blade + (fine - 0.5) * 0.012;
      albedo.set([grassValue * 0.96, grassValue, grassValue * 0.86, 255], pixel);
      roughness.set([255, 235 + fine * 19, 0, 255], pixel);
    } else {
      albedo.set([value, value, value, 255], pixel);
      roughness.set([255, mortar ? 255 : 234 + fine * 18, 0, 255], pixel);
    }
  }
  const sample = (x: number, y: number) => height[((y + SIZE) % SIZE) * SIZE + (x + SIZE) % SIZE]!;
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const dx = (sample(x - 1, y) - sample(x + 1, y)) * 1.25;
    const dy = (sample(x, y - 1) - sample(x, y + 1)) * 1.25;
    const length = Math.hypot(dx, dy, 1);
    normal.set([128 + 127 * dx / length, 128 + 127 * dy / length, 128 + 127 / length, 255], (y * SIZE + x) * 4);
  }
  return [albedo, normal, roughness].map((data, index) => {
    const texture = RawTexture.CreateRGBATexture(data, SIZE, SIZE, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
    texture.name = `pueblo:superficie:${surface}:${['albedo', 'normal', 'roughness'][index]}`;
    texture.gammaSpace = index === 0;
    texture.wrapU = texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = 4;
    return texture;
  });
}

/** Cache belongs to a village load; no global textures survive disposal. */
export function applyFacadeSurface(material: PBRMaterial, scene: Scene, cache?: FacadeSurfaceCache): void {
  const surface: Surface | null = material.name === 'oca-stone' || material.name === 'pueblo:muro-piedra' || material.name === 'pueblo:zocalo'
    ? 'stone' : material.name === 'pueblo:muro-revoco' || material.name === 'pueblo:muro-teja'
      ? 'plaster' : material.name === 'pueblo:muro-ladrillo' ? 'brick'
        : material.name === 'oca-roof' || material.name === 'pueblo:techo-teja' ? 'tile' : null;
  if (!surface) return;
  const textures = cache?.get(surface) ?? maps(scene, surface);
  cache?.set(surface, textures);
  const [albedo, normal, roughness] = textures;
  material.albedoTexture = albedo!;
  material.bumpTexture = normal!;
  material.bumpTexture.level = surface === 'plaster' ? 0.3 : 0.65;
  material.metallicTexture = roughness!;
  material.useRoughnessFromMetallicTextureAlpha = false;
  material.useRoughnessFromMetallicTextureGreen = true;
  material.useMetallnessFromMetallicTextureBlue = true;
}

/** Terrain-following campa UVs must span CAMPA_TILE_METRES per repeat. */
export function attachCampaSurface(material: PBRMaterial, scene: Scene, cache: FacadeSurfaceCache): void {
  const textures = cache.get('grass') ?? maps(scene, 'grass');
  cache.set('grass', textures);
  material.albedoTexture = textures[0]!;
  material.bumpTexture = textures[1]!;
  material.bumpTexture.level = 0.4;
  material.metallicTexture = textures[2]!;
  material.metallic = 0;
  material.roughness = 1;
  material.useRoughnessFromMetallicTextureAlpha = false;
  material.useRoughnessFromMetallicTextureGreen = true;
  material.useMetallnessFromMetallicTextureBlue = true;
}
