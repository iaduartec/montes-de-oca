import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
const path = resolve('scripts/water/.contact-test.bundle.mjs');
const bundle = await build({ entryPoints: ['src/environment/water.ts'], bundle:true, platform:'node', format:'esm', write:false,
  plugins:[{name:'babylon-node',setup(api){api.onResolve({filter:/^@babylonjs\/core\//},({path})=>({path:`${path}.js`,external:true}));}}] });
writeFileSync(path,bundle.outputFiles[0].contents);
const originalFetch = globalThis.fetch;
const engine = new NullEngine(); const scene = new Scene(engine);
try {
  const { loadWater } = await import(pathToFileURL(path));
  globalThis.fetch = async () => new Response(JSON.stringify({schemaVersion:1,sheets:[],ribbons:[{kind:'stream',widthM:4,caladoM:0.35,points:[[-10,0,870],[10,0,872]]}]}));
  const terrain = {config:{verticalDatum:870,worldScale:1},heightAt:(x)=> (x+10)/10,
    samplers:[{grid:{x0:-20,z0:-20,dx:40,dz:40,columns:2,rows:2}}]};
  const water = await loadWater(scene,terrain);
  assert.equal(typeof water.contactDepthAt,'function','3D water interaction must exist');
  assert.ok(Math.abs(water.surfaceHeightAt(0,0)-1.35)<1e-6,'height matches rendered ribbon');
  assert.equal(water.contactDepthAt(0,0,2),0,'road above river: no water drag');
  assert.ok(water.contactDepthAt(0,0,1)>0,'inside river: water drag');
  assert.equal(water.contactDepthAt(0,0,10),0,'bridge: no false positives');
  assert.equal(water.surfaceHeightAt(0,3),null,'outside rendered river');
  const depths = [1.30,1.34,1.35,1.36,1.37,1.38].map(y=>water.contactDepthAt(0,0,y));
  for(let i=1;i<depths.length;i++) assert.ok(depths[i]<=depths[i-1] && depths[i-1]-depths[i]<=0.05,'stable vertical edge transition');
  assert.ok(water.contactDepthAt(0,1.99,1) <= 0.05,'horizontal river edge fades contact rather than switching full drag');
  const bridgeWater = await loadWater(scene,terrain,{roadSurfaceAt:()=>({height:1,bridge:true})});
  assert.ok(bridgeWater.surfaceHeightAt(0,0)<=0.960001,'tagged bridge keeps rendered river below deck');
  assert.equal(bridgeWater.contactDepthAt(0,0,1),0,'tagged bridge geometry and drag agree');
  bridgeWater.dispose();
  const narrow = await loadWater(scene,terrain,{roadSurfaceAt:(x)=>Math.abs(x)<=0.5?{height:1,bridge:true}:null});
  assert.ok(narrow.surfaceHeightAt(0,0)<=0.960001,'bridge between original stations is protected');
  assert.equal(narrow.contactDepthAt(0,0,1),0,'narrow bridge has no drag');
  assert.ok(narrow.contactDepthAt(3,0,terrain.heightAt(3,0))>0,'river beyond bridge still wet');
  narrow.dispose();
  const stats=water.stats;
  water.dispose(); assert.ok(stats.triangles>0);
  console.log('PASS water contact: road/bridge dry, river wet, rendered height and stable edge');
} finally {globalThis.fetch=originalFetch;scene.dispose();engine.dispose();rmSync(path,{force:true});}
