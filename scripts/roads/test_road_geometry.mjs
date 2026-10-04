import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import ts from 'typescript';
import {pathToFileURL} from 'node:url';
import {NullEngine} from '@babylonjs/core/Engines/nullEngine.js';
import {Scene} from '@babylonjs/core/scene.js';
import {Vector3} from '@babylonjs/core/Maths/math.vector.js';
const files=['src/heightfield.ts','src/road-visuals.ts','src/road-profile.ts','src/world/road-surface.ts','src/road-draping.ts'];
function maxPavementTriangleGrade(mesh,roles){const p=mesh.getVerticesData('position'),indices=mesh.getIndices();let max=0;for(let i=0;i<indices.length;i+=3){const [a,b,c]=[indices[i],indices[i+1],indices[i+2]];if([a,b,c].some(v=>roles[v]!==0))continue;const ax=p[a*3],ay=p[a*3+1],az=p[a*3+2],bx=p[b*3],by=p[b*3+1],bz=p[b*3+2],cx=p[c*3],cy=p[c*3+1],cz=p[c*3+2],nx=(by-ay)*(cz-az)-(bz-az)*(cy-ay),ny=(bz-az)*(cx-ax)-(bx-ax)*(cz-az),nz=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax),horizontal=Math.hypot(nx,nz);if(horizontal>1e-5&&Math.abs(ny)>1e-8)max=Math.max(max,horizontal/Math.abs(ny));}return max;}
try {
  for(const file of files){let source=readFileSync(file,'utf8');if(file==='src/road-draping.ts')source=source.replace('  return {\n    meshes,','  return {\n    diagnosticBands: CLASSES.map((cls) => ({class:cls,...typed[cls]})),\n    meshes,');const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText.replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g,'$1$2.js$1').replace(/(['"])(\.\.?\/[^'"]+)\1/g,'$1$2.geometry-test.mjs$1');writeFileSync(file.replace('.ts','.geometry-test.mjs'),code);}
  const {loadRoadNetwork}=await import(pathToFileURL(process.cwd()+'/src/road-draping.geometry-test.mjs'));
  const {createRenderedRoadSurface}=await import(pathToFileURL(process.cwd()+'/src/world/road-surface.geometry-test.mjs'));
  const terrain={heightAt:(x,z)=>.8*x+.12*z,normalAt:(x,z,out)=>(out??new Vector3()).set(-.8,1,-.12).normalize()};
  const engine=new NullEngine(),scene=new Scene(engine);
  for(const [cls,limit] of [['ROAD',.08],['TRACK',.20],['PATH',.35]]){
    const road={id:'steep-'+cls,class:cls,width:6,bridge:false,points:[[20,10],[20,110]]};
    const network=await loadRoadNetwork(scene,terrain,{fetchImpl:async()=>({ok:true,json:async()=>({roads:[road]})})});
    const mesh=network.meshes[0],positions=mesh.getVerticesData('position'),indices=mesh.getIndices();
    const verticalEndFaces=Array.from({length:indices.length/3},(_,i)=>indices.slice(i*3,i*3+3)).filter(([a,b,c])=>{
      const area=(positions[b*3]-positions[a*3])*(positions[c*3+2]-positions[a*3+2])-(positions[b*3+2]-positions[a*3+2])*(positions[c*3]-positions[a*3]);
      return Math.abs(area)<1e-5&&Math.max(positions[a*3+1],positions[b*3+1],positions[c*3+1])-Math.min(positions[a*3+1],positions[b*3+1],positions[c*3+1])>.01;
    });
    assert.ok(verticalEndFaces.length>0, 'isolated terminal cut/fill closure survives render mesh filtering');
    const normals = mesh.getVerticesData('normal');
    assert.ok(normals.every((n,i) => i % 3 !== 1 || n >= 0), 'rendered road lighting normals point upward');
    // Read final mesh heights across its actual width, independent of capped normals.
    for(let z=12;z<109;z+=2){
      const raw=createRenderedRoadSurface(terrain,[{class:cls,positions,indices,roles:Array(positions.length/3).fill(0)}],{geometryOnly:true});
      const left=raw.sampleAt(18,z),right=raw.sampleAt(22,z);
      assert.ok(left&&right);
      assert.ok(Math.abs((right.height-left.height)/4)<=limit+.00003,`${cls} rendered width, not driving clamp`);
      assert.ok(left.height>=terrain.heightAt(18,z));
      const contact=network.surface.sampleAt(20,z);
      assert.ok(Math.abs(contact.height-raw.sampleAt(20,z).height)<1e-5,'wheel height matches actual visible triangle');
    }
    assert.ok(network.audit().classes[cls].surfaceClearance.belowTerrain > 0,'controlled profile excavates raw sidehill rather than raising a platform');
    assert.ok(Math.abs(network.surface.heightAt(20,60) - terrain.heightAt(20,60)) < .2, 'centreline keeps real mountain grade');
    network.dispose();
  }
  for (const [a,b] of [['ROAD','ROAD'],['ROAD','TRACK'],['TRACK','TRACK'],['TRACK','PATH']]) {
    const roads=[{id:'a',class:a,width:4,bridge:false,points:[[20,20],[20,100]]},{id:'b',class:b,width:3,bridge:false,points:[[0,60],[40,60]]}];
    const n=await loadRoadNetwork(scene,terrain,{fetchImpl:async()=>({ok:true,json:async()=>({roads})})});
    const center=n.surface.sampleAt(20,60);
    assert.ok(center, 'intersection has rendered support');
    for(const [x,z] of [[19.99,60],[20.01,60],[20,59.99],[20,60.01]]) {
      assert.ok(Math.abs(n.surface.sampleAt(x,z).height-center.height)<.03, a+' x '+b+' has no instantaneous central step');
    }
    n.dispose();
  }
  // Real MDT/OSM regression: way 548355745 has a sharp bend where adjacent
  // inner-edge pavement rows nearly coincide in XZ. The isolated profile is
  // below grade 1; the full network must retain that bound after junction
  // reconciliation rather than introduce a 5.20 grade-ratio facet.
  const {createHeightfield}=await import(pathToFileURL(process.cwd()+'/src/heightfield.geometry-test.mjs'));
  const terrainConfig=JSON.parse(readFileSync('public/terrain/config.json','utf8'));
  const terrainTiles=terrainConfig.tiles.map(tile=>createHeightfield(JSON.parse(readFileSync('public'+tile.url,'utf8')).grid,terrainConfig.worldScale));
  const mdt={heightAt(x,z){x=Math.max(0,Math.min(6000,x));z=Math.max(0,Math.min(6000,z));const tile=terrainTiles.find(t=>x>=t.grid.x0&&z>=t.grid.z0&&x<=t.grid.x0+1000&&z<=t.grid.z0+1000);assert.ok(tile,'MDT tile covers OSM road sample');return tile.heightAt(x,z)-terrainConfig.verticalDatum;},normalAt(x,z,out){const e=.1;return (out??new Vector3()).set(-(this.heightAt(x+e,z)-this.heightAt(x-e,z))/(2*e),1,-(this.heightAt(x,z+e)-this.heightAt(x,z-e))/(2*e)).normalize();}};
  const realRoad=JSON.parse(readFileSync('public/roads/roads.json','utf8')).roads.find(road=>road.id==='548355745');
  assert.ok(realRoad,'OSM regression way remains in roads.json');
  const realRoads=JSON.parse(readFileSync('public/roads/roads.json','utf8')).roads;
  const isolated=await loadRoadNetwork(scene,mdt,{fetchImpl:async()=>({ok:true,json:async()=>({roads:[realRoad]})})});
  const isolatedGrade=maxPavementTriangleGrade(isolated.meshes[0],isolated.diagnosticBands[0].roles);
  assert.ok(isolatedGrade<1,`isolated ROAD profile has no near-vertical facet (max ${isolatedGrade})`);
  isolated.dispose();
  const real=await loadRoadNetwork(scene,mdt,{fetchImpl:async()=>({ok:true,json:async()=>({roads:realRoads})})});
  const realMaxGrade=maxPavementTriangleGrade(real.meshes[0],real.diagnosticBands[0].roles);
  assert.ok(realMaxGrade<1,`OSM/MDT bend pavement has no near-vertical triangle (max ${realMaxGrade})`);
  real.dispose();
  const gentle={heightAt:(x,z)=>.04*x+.07*z,normalAt:(x,z,out)=>(out??new Vector3()).set(-.04,1,-.07).normalize()};
  const multi=[{id:'connector',class:'ROAD',width:7.5,bridge:false,points:[[20,0],[20,16]]},{id:'south',class:'ROAD',width:7.5,bridge:false,points:[[0,0],[40,0]]},{id:'north',class:'ROAD',width:7.5,bridge:false,points:[[0,16],[40,16]]},{id:'deck',class:'ROAD',width:7.5,bridge:true,points:[[20,-20],[20,0]]}];
  const connectorHeights=[];
  for(const roads of [multi,[...multi].reverse()]){
    const n=await loadRoadNetwork(scene,gentle,{fetchImpl:async()=>({ok:true,json:async()=>({roads})})});
    const heights=[];for(let z=-19.97;z<16;z+=.1)heights.push(n.surface.sampleAt(20,z).height);
    assert.ok(heights.slice(1).every((y,i)=>Math.abs(y-heights[i])<.05),'short connector and bridge have continuous highest-network support');
    connectorHeights.push(heights);n.dispose();
  }
  assert.ok(connectorHeights[0].every((y,i)=>Math.abs(y-connectorHeights[1][i])<.015),'junction support is stable when road input order changes');
  const curve=await loadRoadNetwork(scene,terrain,{fetchImpl:async()=>({ok:true,json:async()=>({roads:[{id:'curve',class:'PATH',width:3,bridge:false,points:[[10,10],[20,30],[40,45],[60,45]]}]})})});
  const footprints=curve.gradingTriangles();
  const contains=(x,z)=>{for(let i=0;i<footprints.length;i+=6){const [ax,az,bx,bz,cx,cz]=footprints.slice(i,i+6);const cross=(px,pz,qx,qz)=>(qx-px)*(z-pz)-(qz-pz)*(x-px);const sides=[cross(ax,az,bx,bz),cross(bx,bz,cx,cz),cross(cx,cz,ax,az)];if(sides.every(v=>v>=-1e-6)||sides.every(v=>v<=1e-6))return true;}return false;};
  for(let x=5.13;x<65;x+=.73)for(let z=5.17;z<50;z+=.71){
    assert.equal(contains(x,z), !!curve.surface.sampleAt(x,z), 'simplified footprint preserves curved pavement and skirt outline');
  }
  curve.dispose();
  engine.dispose();
  console.log('PASS rendered profiles, terminal closures, four intersection classes, bridge connector/order, footprint and wheel contact');
} finally {for(const f of files)rmSync(f.replace('.ts','.geometry-test.mjs'),{force:true});}
