import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({entryPoints:['src/runtime/vehicle-audio.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {createVehicleAudio} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
const {SURFACES} = await import(`data:text/javascript;base64,${Buffer.from((await build({entryPoints:['src/world/surfaces.ts'],bundle:true,platform:'node',format:'esm',write:false})).outputFiles[0].contents).toString('base64')}`);
const nodes=[];
class Parameter {value=0; setTargetAtTime(value){this.value=value;}}
class Node {gain=new Parameter();frequency=new Parameter();Q=new Parameter();stopped=false;disconnected=false;constructor(){nodes.push(this);}connect(target){return target;}start(){}stop(){this.stopped=true;}disconnect(){this.disconnected=true;}}
let contexts=0;
class Context {
  state='running';currentTime=0;sampleRate=8000;destination={};
  constructor(){contexts++;}
  createGain(){return new Node();}createOscillator(){return new Node();}createBiquadFilter(){return new Node();}createBufferSource(){return new Node();}
  createBuffer(channels,length){return {getChannelData:()=>new Float32Array(length)};}
  resume(){this.state='running';return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
}
globalThis.AudioContext=Context;
const target=new EventTarget();
const audio=createVehicleAudio(target);
const input={speed:12,load:1,slip:false,driving:true,surface:SURFACES.ROAD};
audio.update(input);
assert.equal(audio.stats().state,'locked');assert.equal(contexts,0,'no autoplay allocation');
target.dispatchEvent(new Event('keydown'));
assert.equal(contexts,1);assert.equal(audio.stats().sources,2);
const nodeCount=nodes.length;
const frequencies=()=>nodes.map(n=>n.frequency.value);
const before=frequencies();
for(let i=0;i<600;i++)audio.update({...input,surface:SURFACES.TRACK,speed:24});
assert.notDeepEqual(frequencies(),before,'speed and surface drive different sound parameters');
assert.equal(nodes.length,nodeCount,'600 updates reuse the same emitters');
audio.setEnabled(false);assert.equal(nodes[0].gain.value,0,'mute reaches master gain');
audio.setEnabled(true);assert.equal(contexts,1,'unmute reuses context');
target.dispatchEvent(new Event('pointerdown'));assert.equal(contexts,1);
audio.dispose();audio.dispose();
assert.ok(nodes.every(n=>n.disconnected),'owned nodes disconnect');
assert.equal(nodes.filter(n=>n.stopped).length,2,'both scheduled sources stop');
target.dispatchEvent(new Event('keydown'));assert.equal(contexts,1,'listeners removed on disposal');
console.log('PASS audio lifecycle: gesture, surface/speed response, bounded reuse, mute and disposal (mocked WebAudio; not auditory validation)');
