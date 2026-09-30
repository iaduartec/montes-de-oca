// Same-camera screenshots and live runtime telemetry through Chrome/CDP.
// SwiftShader FPS is diagnostic only; it does not validate target GPU performance.
// --effects uses an explicitly reported debug placement, not a mission playthrough.
// Usage: node scripts/runtime/capture_runtime.mjs --base http://127.0.0.1:5173
//   --out-dir outputs/runtime-v2/check [--quality LOW] [--playable-only] [--effects]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
}
const PORT = Number(arg('--port', '9297'));
const BASE = arg('--base', 'http://127.0.0.1:4173');
const OUT_DIR = resolve(root, arg('--out-dir', 'output'));
const CHROME = arg('--chrome', 'google-chrome');
const HARDWARE = argv.includes('--hardware');
const WIDTH = Number(arg('--width', '1280'));
const HEIGHT = Number(arg('--height', '720'));
const GPU_FLAGS = HARDWARE ? ['--enable-gpu', '--use-angle=gl', '--ignore-gpu-blocklist', '--disable-software-rasterizer'] : ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'];
const PROFILE = `/tmp/montes-v2-runtime-cdp-${PORT}`;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') this.errors.push(msg.params.args.map(a => a.value ?? a.description).join(' '));
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, reject) => this.pending.set(id, { resolve: res, reject }));
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate error');
    }
    return result.result.value;
  }
  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, reject) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  return new Cdp(ws);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-dev-shm-usage',
    `--window-size=${WIDTH},${HEIGHT}`,...GPU_FLAGS,
    `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', `--user-data-dir=${PROFILE}`, 'about:blank'], {stdio:'ignore'});
  let cdp;
  const QUALITY = arg('--quality', 'HIGH');
  const report = { base:BASE, quality:QUALITY, requestedHardware:HARDWARE, viewport:{width:WIDTH,height:HEIGHT}, backend:HARDWARE?'Hardware requested; verify unmasked renderer':'Chrome headless SwiftShader; FPS not target GPU performance', views:[], errors:[] };
  try {
    let ready=false;
    for(let i=0;i<60&&!ready;i++){try{await fetchJson(`http://127.0.0.1:${PORT}/json/version`);ready=true;}catch{await wait(500);}}
    if(!ready)throw Error('Chrome startup timeout');
    const tab=await fetchJson(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:'PUT'});
    cdp=await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:WIDTH,height:HEIGHT,deviceScaleFactor:1,mobile:WIDTH<760});
    const views = [
      {name:'village',px:3090,py:100,pz:3900,tx:3070,ty:50,tz:4020},
      {name:'track',px:3670,py:280,pz:4100,tx:3730,ty:220,tz:4150},
      {name:'aerial',px:3050,py:800,pz:3550,tx:3050,ty:50,tz:4050},
    ];
    for(const view of (argv.includes("--playable-only") ? [] : views)){
      const params=new URLSearchParams(Object.entries(view).filter(([k])=>k!=='name'));
      params.set('quality',QUALITY);
      const started=performance.now();
      await cdp.send('Page.navigate',{url:`${BASE}/?${params}`});
      let loaded=false;
      for(let i=0;i<180&&!loaded;i++){await wait(500);loaded=await cdp.evaluate('!!window.__game').catch(()=>false);}
      if(!loaded)throw Error(`Game timeout ${view.name}`);
      await wait(6000);
      const firstVisible = await cdp.evaluate('window.__game.runtime?.() ?? null');
      const settleStarted=performance.now();
      let settled=false;
      while(!settled && performance.now()-settleStarted < 30000){
        settled=await cdp.evaluate('(()=>{const r=window.__game.runtime?.();return !r || (r.terrain.queuedTiles===0 && r.terrain.loadingTiles===0);})()');
        if(!settled)await wait(500);
      }
      if(!settled)throw Error(`Terrain failed to settle ${view.name}`);
      const metrics=await cdp.evaluate(`(()=>{const g=window.__game;return {perf:g.perf(),runtime:g.runtime?.()??null,
        heap:performance.memory?.usedJSHeapSize??null,resources:performance.getEntriesByType('resource').map(r=>({url:r.name,bytes:r.transferSize,durationMs:r.duration})),
        npc:g.villageNpcs?.stats()??null,datum:g.auditDatum(),renderer:(()=>{const gl=document.getElementById('render-canvas').getContext('webgl2');const ext=gl?.getExtension('WEBGL_debug_renderer_info');return ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null;})()};})()`);
      report.views.push({camera:view,firstVisible,loadAndSettleMs:performance.now()-started,...metrics});
      await cdp.screenshot(resolve(OUT_DIR,`${view.name}.png`));
      console.log(view.name,JSON.stringify({perf:metrics.perf,residency:metrics.runtime?.terrain}));
    }
    // Exercise native sound control and prevent widget keys from moving the player.
    await cdp.send('Page.navigate',{url:`${BASE}/?quality=${QUALITY}`});
    let playable=false;
    for(let i=0;i<180&&!playable;i++){await wait(500);playable=await cdp.evaluate('!!window.__game?.player').catch(()=>false);}
    if(!playable)throw Error('Playable spawn timeout');
    await wait(1500);
    const beforeWidget=await cdp.evaluate('window.__game.player.telemetry()');
    await cdp.evaluate("document.getElementById('graphics-quality')?.focus()");
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'w',code:'KeyW',text:'w'});
    await cdp.evaluate('window.__game.player.step(0.5)');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',key:'w',code:'KeyW'});
    const afterWidget=await cdp.evaluate('window.__game.player.telemetry()');
    if(Math.hypot(beforeWidget.x-afterWidget.x,beforeWidget.z-afterWidget.z)>0.01)throw Error('Settings keyboard moved the player');
    const soundResult=await cdp.send('Runtime.evaluate',{expression:`(async()=>{
      const button=document.getElementById('sound-toggle');button.click();
      const muted=window.__game.runtime().audio;
      button.click();await new Promise(r=>setTimeout(r,200));
      return {muted,enabled:window.__game.runtime().audio};
    })()`,returnByValue:true,awaitPromise:true,userGesture:true});
    report.controls={widgetDoesNotMovePlayer:true,sound:soundResult.result.value};
    if(WIDTH<760) {
      report.controls.mobileLayout=await cdp.evaluate(`(()=>{
        const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
        return {mission:rect('mision'),selector:rect('vehiculo-chip'),map:rect('minimapa'),prompt:rect('accion'),settings:rect('runtime-settings'),touch:rect('mobile-controls')};})()`);
      const {mission,selector,map,prompt,settings,touch}=report.controls.mobileLayout;
      if(mission.top<selector.bottom || map.top<mission.bottom || prompt.bottom>settings.top || settings.bottom>touch.top)throw Error('Mobile mission controls overlap');
    }
    if(report.controls.sound.muted.enabled || !report.controls.sound.enabled.enabled || report.controls.sound.enabled.sources!==2)throw Error('Sound control failed');
    report.playable=await cdp.evaluate('({runtime:window.__game.runtime(),npc:window.__game.villageNpcs.stats()})');
    if(report.playable.npc.characters!==10)throw Error('Expected 10 real NPC in playable scene');
    await cdp.screenshot(resolve(OUT_DIR,'playable.png'));
    if(argv.includes('--effects')) {
      // Controlled debug placement, not a mission playthrough: hold a moving
      // vehicle on the real track to exercise particle rendering and pooling.
      const placement=await cdp.evaluate(`(()=>{const g=window.__game;
        const p=g.route.checkpoints.find(p=>p.id==='track-entry');
        g.vehicle.teleport(p.x,p.z,0);g.player.teleport(p.x+1,p.z,0);
        if(g.player.mode()==='on-foot')g.player.toggleVehicle();
        g.player.inject({throttle:0,steer:0});
        g.vehicle.setState({speed:12});return {p,mode:g.player.mode()};})()`);
      if(placement.mode!=='driving')throw Error('Effects placement did not enter vehicle');
      const samples=[];
      for(let i=0;i<12;i++) {
        await cdp.evaluate('window.__game.vehicle.setState({speed:12})');
        await wait(750);
        samples.push(await cdp.evaluate('({runtime:window.__game.runtime(),perf:window.__game.perf()})'));
      }
      report.effects={diagnosticPlacement:true,placement,samples};
      if(!samples.some(s=>s.runtime.effects.activeParticles>0))throw Error('No rendered track particles');
      await cdp.screenshot(resolve(OUT_DIR,'dust.png'));
    }
    if(argv.includes('--lifecycle')) {
      report.lifecycle={diagnosticTeleports:true,states:[]};
      for(const point of [{x:900,z:900},{x:3090,z:4000}]) {
        await cdp.evaluate(`window.__game.vehicle.teleport(${point.x},${point.z},0)`);
        await wait(8000);
        const started=performance.now();
        let state;
        do {
          await wait(500);
          state=await cdp.evaluate('window.__game.runtime().terrain');
        }while((state.queuedTiles || state.loadingTiles) && performance.now()-started<30000);
        if(state.queuedTiles || state.loadingTiles || state.activeTiles===0)throw Error('Lifecycle traversal failed to restore visible ground');
        report.lifecycle.states.push({point,...state});
      }
      if(!report.lifecycle.states.some(s=>s.taskSteps>0))throw Error('Lifecycle traversal did not exercise reconstruction');
    }
    report.errors=cdp.errors;
    if(report.errors.length)throw Error(report.errors.join('\n'));
  }catch(error){
    report.failure=String(error);
    throw error;
  }finally{
    report.errors=cdp?.errors ?? report.errors;
    writeFileSync(resolve(OUT_DIR,'runtime.json'),JSON.stringify(report,null,2)+'\n');
    cdp?.ws.close();chrome.kill('SIGTERM');
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
