// Run with Windows Node against an isolated Windows Chrome CDP endpoint when
// WSL Chrome cannot create a hardware GL context. Verifies renderer before FPS.
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2),arg=(k,d)=>args.includes(k)?args[args.indexOf(k)+1]:d;
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const endpoint=arg('--cdp','http://127.0.0.1:9239'),base=arg('--base','http://127.0.0.1:4193'),phase=arg('--phase','after'),out=resolve(root,arg('--out-dir','outputs/road-v3-20261001/gpu'));
const playable=args.includes('--playable');
const duration=Number(arg('--seconds','12'));mkdirSync(out,{recursive:true});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const tab=await(await fetch(endpoint+'/json/new?about:blank',{method:'PUT'})).json();
const ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true});});
let sequence=0;const pending=new Map(),errors=[];
ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.exception?.description??m.params.exceptionDetails.text);if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errors.push(m.params.args.map(a=>a.value??a.description).join(' '));if(pending.has(m.id)){const [r,j]=pending.get(m.id);pending.delete(m.id);m.error?j(Error(JSON.stringify(m.error))):r(m.result);}});
const send=(method,params={})=>new Promise((r,j)=>{const id=++sequence;pending.set(id,[r,j]);ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
const defaultViews=[{name:'village',px:3090,py:100,pz:3900,tx:3070,ty:50,tz:4020},{name:'road',px:2960,py:111,pz:3360,tx:2947,ty:92,tz:3400},{name:'track',px:3670,py:280,pz:4100,tx:3730,ty:220,tz:4150},{name:'forest',px:3850,py:300,pz:4360,tx:3900,ty:275,tz:4400},{name:'aerial',px:3050,py:800,pz:3550,tx:3050,ty:50,tz:4050}];
const cameraFile=arg('--cameras',null);
const allViews=cameraFile?JSON.parse(readFileSync(resolve(root,cameraFile),'utf8')).map(c=>({name:c.name,...Object.fromEntries(new URLSearchParams(c.query))})):defaultViews;
const views=playable?allViews.filter(v=>v.name!=='aerial'):allViews;
const report={phase,base,quality:'HIGH',durationSeconds:duration,method:(playable?'Play mode with actors/NPC and chase camera; ':'Free camera (actors/NPC excluded); ')+'Real GPU browser rAF intervals after tile settle, fixed scene locations; Windows Chrome via isolated profile',views:[],errors};
try{
await send('Runtime.enable');await send('Page.enable');
if(args.includes('--clean-tabs'))for(const old of await(await fetch(endpoint+'/json/list')).json())if(old.type==='page'&&old.id!==tab.id)await fetch(endpoint+'/json/close/'+old.id).catch(()=>{});
for(const [width,height]of (cameraFile?[[1280,720]]:[[1920,1080],[2560,1440]]))for(const view of views){
 await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
 const start=performance.now();await send('Page.navigate',{url:base+'/?'+new URLSearchParams(playable?{vx:view.tx,vz:view.tz,vyaw:'0',quality:'HIGH',vehicle:'estandar'}:{...view,quality:'HIGH',vehicle:'estandar'})});
 let ready=false;for(let i=0;i<180&&!ready;i++){await wait(500);ready=await evaluate('!!window.__game?.roads').catch(()=>false);}if(!ready)throw Error('Game timeout '+view.name);
 const worldReadyMs=performance.now()-start;
 for(let i=0;i<120;i++){const s=await evaluate('window.__game.runtime().terrain');if(!s.queuedTiles&&!s.loadingTiles)break;await wait(500);}
 if(playable)await evaluate(`(()=>{const g=window.__game;if(!g.player||!g.villageNpcs)throw Error('Playable actors missing');g.player.teleport(${view.tx},${view.tz},0);if(g.player.mode()!=='driving')g.player.toggleVehicle();})()`);
 await wait(3000);
 const renderer=await evaluate(`(()=>{const gl=document.querySelector('canvas').getContext('webgl2');const ext=gl.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);})()`);
 if(!/RTX 2070/i.test(renderer)||/SwiftShader|llvmpipe|software/i.test(renderer)){report.blockedRenderer=renderer;throw Error('BLOCKED-ENVIRONMENT: effective renderer '+renderer);}
 const metrics=await evaluate(`(async()=>{const start=performance.now(),times=[];let previous=await new Promise(requestAnimationFrame);while(performance.now()-start<${duration*1000}){const now=await new Promise(requestAnimationFrame);times.push(now-previous);previous=now;}times.sort((a,b)=>a-b);const p=q=>times[Math.floor((times.length-1)*q)],g=window.__game;return {frames:times.length,frameTimeMs:{p50:p(.5),p95:p(.95),p99:p(.99)},fps:1000/(times.reduce((a,b)=>a+b,0)/times.length),perf:g.perf(),runtime:g.runtime(),heap:performance.memory?.usedJSHeapSize??null,requests:performance.getEntriesByType('resource').length,resourceBytes:performance.getEntriesByType('resource').reduce((a,r)=>a+r.transferSize,0)};})()`);
 const entry={camera:view,width,height,renderer,firstWorldReadyMs:worldReadyMs,firstPlayableMs:playable?worldReadyMs:null,loadAndSettleMs:performance.now()-start-duration*1000,...metrics};report.views.push(entry);const shot=await send('Page.captureScreenshot',{format:'png'});writeFileSync(resolve(out,`${phase}_${width}_${view.name}.png`),Buffer.from(shot.data,'base64'));writeFileSync(resolve(out,phase+'.json'),JSON.stringify(report,null,2));console.log(phase,width,view.name,renderer,JSON.stringify(entry.frameTimeMs),entry.fps.toFixed(1));
}
}catch(error){report.failure=String(error);console.error(report.failure);process.exitCode=1;}finally{writeFileSync(resolve(out,phase+'.json'),JSON.stringify(report,null,2));await send('Page.close').catch(()=>{});ws.close();}
