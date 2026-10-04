// Actual scene actors; deterministic manoeuvres use actor.step, water uses player.step.
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
const args=process.argv.slice(2),arg=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const base=arg('--base','http://127.0.0.1:4193'),out=arg('--out-dir','outputs/road-v3-20261001');
const run=(...a)=>execFileSync('agent-browser',['--session','road-v3-play',...a],{encoding:'utf8',timeout:180000,maxBuffer:12e6}).trim();
run('open',base+'/?vehicle=trail');run('wait','--fn','!!window.__game?.vehicle && !!window.__game?.roads && !!window.__game?.water && !!window.__game?.player');
const sources=JSON.parse(readFileSync('public/roads/roads.json','utf8')).roads;
const roadNodes=new Set(sources.filter(r=>r.class==='ROAD').flatMap(r=>r.points.map(p=>p.join(','))));
const transitions=sources.filter(r=>r.class==='TRACK'&&!r.bridge).flatMap(r=>[[r.points[0],r.points[1]],[r.points.at(-1),r.points.at(-2)]]).filter(([a,b])=>roadNodes.has(a.join(','))&&Math.hypot(b[0]-a[0],b[1]-a[1])>12).map(([a,b])=>{const length=Math.hypot(b[0]-a[0],b[1]-a[1]);return {x:a[0],z:a[1],dx:(b[0]-a[0])/length,dz:(b[1]-a[1])/length};});
const expression=`(()=>{const g=window.__game,v=g.vehicle,results=[];
const p={x:3631.02,z:4762.92,yaw:-2.585};
const manoeuvre=(name,speed,frames,input)=>{v.teleport(p.x,p.z,p.yaw);v.setState({speed});let maxLean=0,maxResidual=0,fallen=false;for(let i=0;i<frames;i++){v.setInput(input(i));v.step(1/60,1/60);const t=v.telemetry();fallen||=t.fallen;maxLean=Math.max(maxLean,Math.abs(t.leanRad));maxResidual=Math.max(maxResidual,t.wheelResidualMaxM??0);}const t=v.telemetry();results.push({name,fallen,maxLean,maxResidual,final:t});};
const input=(throttle,steer,handbrake=false)=>({throttle,steer,handbrake,neutral:false});
manoeuvre('longTurn',10,1200,()=>input(.15,.15));
manoeuvre('slalom',7,600,i=>input(.12,.25*Math.sin(i/50)));
manoeuvre('lowSpeedTurn',2,300,()=>input(.05,.3));
manoeuvre('brakeTurn',10,180,()=>input(0,.2,true));
const fixtures=${JSON.stringify(transitions)};
const junction=fixtures.find(p=>{const a=g.roads.sampleAt(p.x,p.z),b=g.roads.sampleAt(p.x+p.dx*8,p.z+p.dz*8);return a?.class==='ROAD'&&b?.class==='TRACK'&&Math.abs(b.height-a.height)/8<.2;});
if(!junction)throw Error('No verified ROAD to TRACK fixture');
v.teleport(junction.x,junction.z,Math.atan2(junction.dx,junction.dz));v.setState({speed:2});v.setInput(input(.25,0));const transition=[];
for(let i=0;i<600;i++){v.step(1/60,1/60);const t=v.telemetry();transition.push({frame:i,x:t.x,z:t.z,class:g.roads.sampleAt(t.x,t.z)?.class??'TERRAIN',fallen:t.fallen});if(transition.some(t=>t.class==='TRACK')&&Math.hypot(t.x-junction.x,t.z-junction.z)>6)break;}
const classes=['ROAD','TRACK'];for(const cls of classes){const s=g.roads.stations().find(s=>s.class===cls&&s.x>3500&&s.z>4000&&g.roads.sampleAt(s.x,s.z)?.class===cls);if(!s)throw Error('Missing class fixture '+cls);v.teleport(s.x,s.z,Math.atan2(s.dx,s.dz));v.setState({speed:5});v.setInput(input(.1,.05));v.step(1,1/60);results.push({name:cls+'Contact',fixture:s,fallen:v.telemetry().fallen,final:v.telemetry()});}
const crossings=g.roads.stations().filter(s=>s.class==='ROAD'&&g.water.depthAt(s.x,s.z)>0&&g.roads.sampleAt(s.x,s.z)?.height>g.water.surfaceHeightAt(s.x,s.z)+.12).filter((s,i,a)=>i===0||Math.hypot(s.x-a[i-1].x,s.z-a[i-1].z)>5).slice(0,5);
const water=[];for(const id of ['trail','estandar','carga']){v.reset();v.setState({speed:0,lateral:0});v.setInput(input(0,0));if(!v.setPreset(id))throw Error('Missing preset '+id);if(g.player.mode()!=='driving'){g.player.teleport(g.vehicle.telemetry().x,g.vehicle.telemetry().z,0);g.player.toggleVehicle();}for(const s of crossings){g.player.teleport(s.x,s.z,Math.atan2(s.dx,s.dz));g.vehicle.setState({speed:15});g.player.inject({throttle:0,steer:0,handbrake:false,neutral:false});g.player.step(.1,1/120);water.push({id,x:s.x,z:s.z,state:g.water.estadoAgua(),depth:g.water.calado(),speed:g.vehicle.telemetry().speed,deck:g.roads.sampleAt(s.x,s.z).height,waterY:g.water.surfaceHeightAt(s.x,s.z)});}}
return {transition:{fixture:junction,samples:transition},method:'Actual actor.step manoeuvres on loaded scene; ROAD-to-TRACK uses continuous actor steps at a verified shared OSM node; separate class contacts are teleport fixtures. Actual player.step water speed rules.',manoeuvres:results,water,checks:{continuousRoadTrack:transition.some(t=>t.class==='ROAD')&&transition.some(t=>t.class==='TRACK')&&transition.every(t=>!t.fallen),noFalls:results.every(r=>!r.fallen),finitePoses:results.every(r=>Number.isFinite(r.final.y)&&Number.isFinite(r.final.speed)),multipleCrossings:crossings.length>=2,allDecksDry:water.length>0&&water.every(w=>w.state==='seco'&&w.depth===0),noWaterSpeedCaps:water.every(w=>w.speed>14),waterBelowDeck:water.every(w=>w.waterY<w.deck)}};})()`;
let report=JSON.parse(run('eval',`JSON.stringify(${expression})`));if(typeof report==='string')report=JSON.parse(report);
report.errors=run('errors');mkdirSync(out,{recursive:true});writeFileSync(out+'/extended-gameplay.json',JSON.stringify(report,null,2));console.log(report.checks,report.errors);run('close');if(Object.values(report.checks).some(v=>!v)||report.errors.includes('Error:'))process.exitCode=1;
