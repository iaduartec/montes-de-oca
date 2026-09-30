import assert from 'node:assert/strict';
import { build } from 'esbuild';
const result = await build({entryPoints:['src/runtime/vehicle-audio.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {createVehicleAudio} = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
const {SURFACES} = await import(`data:text/javascript;base64,${Buffer.from((await build({entryPoints:['src/world/surfaces.ts'],bundle:true,platform:'node',format:'esm',write:false})).outputFiles[0].contents).toString('base64')}`);
const nodes=[];
class Parameter {
  value=0; events=[];
  setTargetAtTime(value,time,constant){this.value=value;this.events.push(['target',value,time,constant]);}
  setValueAtTime(value,time){this.value=value;this.events.push(['set',value,time]);}
  exponentialRampToValueAtTime(value,time){this.value=value;this.events.push(['ramp',value,time]);}
  cancelScheduledValues(time){this.events.push(['cancel',time]);}
}
class Node {
  gain=new Parameter();frequency=new Parameter();Q=new Parameter();pan=new Parameter();
  stopped=false;disconnected=false;
  constructor(kind='node'){this.kind=kind;nodes.push(this);}
  connect(target){return target;}start(){}stop(){this.stopped=true;}disconnect(){this.disconnected=true;}
}
let contexts=0;
class Context {
  state='running';currentTime=0;sampleRate=8000;destination={};
  constructor(){contexts++;Context.last=this;}
  createGain(){return new Node('gain');}createOscillator(){return new Node('oscillator');}createBiquadFilter(){return new Node('filter');}
  createBufferSource(){return new Node('buffer-source');}createStereoPanner(){return new Node('panner');}
  createBuffer(channels,length){return {getChannelData:()=>new Float32Array(length)};}
  resume(){this.state='running';return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
}
Context.last=null;
globalThis.AudioContext=Context;
const target=new EventTarget();
const audio=createVehicleAudio(target);
const ambient={wind:0.7,forest:0.8,village:0.25,water:0.6,waterPan:-0.75};
const input={speed:12,load:1,slip:false,driving:true,surface:SURFACES.ROAD,ambient};
audio.update(input);
assert.equal(audio.stats().state,'locked');assert.equal(contexts,0,'no autoplay allocation');
target.dispatchEvent(new Event('keydown'));
assert.equal(contexts,1);assert.equal(audio.stats().sources,4);
const nodeCount=nodes.length;
const frequencies=()=>nodes.map(n=>n.frequency.value);
const before=frequencies();
const birdFrequencies=()=>nodes.filter(n=>n.kind==='oscillator').slice(1).map(n=>n.frequency.value);
const birdsBefore=birdFrequencies();
const panner=nodes.find(n=>n.kind==='panner');
for(let i=0;i<600;i++){
  audio.update({...input,surface:SURFACES.TRACK,speed:24,impact:i < 40 ? 0.8 : 0});
  Context.last.currentTime += 1/60;
}
assert.notDeepEqual(frequencies(),before,'speed and surface drive different sound parameters');
assert.equal(nodes.length,nodeCount,'600 updates reuse the same emitters');
assert.equal(audio.stats().ambient,true,'ambient levels are reported');
assert.deepEqual(audio.stats().ambientLevels,{wind:0.7,forest:0.8,village:0.25,water:0.6,waterPan:-0.75},'ambient resolver levels are auditable');
assert.equal(audio.stats().impactEvents,3,'impact cooldown bounds repeated frame impulses');
assert.equal(panner.pan.value,-0.75,'water ambience pans to its supplied side');
assert.notDeepEqual(birdFrequencies(),birdsBefore,'bird oscillators sweep with their call phase instead of holding fixed pitches');
assert.equal(audio.stats().nodes,22,'persistent graph stays at its documented source/node count');
const impactGain=nodes.find(n=>n.kind==='gain'&&n.gain.events.some(e=>e[0]==='cancel'));
assert.ok(impactGain,'impact envelope has a dedicated reusable gain');
const impactAutomation=impactGain.gain.events;
const firstPeak=impactAutomation.find(e=>e[0]==='ramp'&&Math.abs(e[2]-0.008)<1e-8);
const firstDecay=impactAutomation.find(e=>e[0]==='ramp'&&Math.abs(e[2]-0.095)<1e-8);
assert.ok(firstPeak&&firstPeak[1]>0.2,'impact envelope ramps from near-silence to an audible peak over 8ms');
assert.ok(firstDecay&&firstDecay[1]===0.0001,'impact envelope decays after its peak');
audio.setEnabled(false);assert.equal(nodes[0].gain.value,0,'mute reaches master gain');
audio.setEnabled(true);assert.equal(contexts,1,'unmute reuses context');
target.dispatchEvent(new Event('pointerdown'));assert.equal(contexts,1);
audio.dispose();audio.dispose();
assert.ok(nodes.every(n=>n.disconnected),'owned nodes disconnect');
assert.equal(nodes.filter(n=>n.stopped).length,4,'all persistent scheduled sources stop');
target.dispatchEvent(new Event('keydown'));assert.equal(contexts,1,'listeners removed on disposal');
console.log('PASS audio lifecycle: gesture, surface/speed, ambient stereo, impact cooldown/envelope, bounded reuse, mute and disposal (mocked WebAudio; not auditory validation)');
