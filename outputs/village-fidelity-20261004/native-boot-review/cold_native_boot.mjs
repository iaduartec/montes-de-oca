#!/usr/bin/env node
// Cold, native boot capture. No __game manual stepping/input is used.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, 'captures');
mkdirSync(out, { recursive: true });
const chrome = process.env.CHROME ?? 'google-chrome';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = { exceptions: [], consoleErrors: [], logs: [] };
    ws.addEventListener('message', ({ data }) => { const m = JSON.parse(data);
      if (m.method === 'Runtime.exceptionThrown') this.events.exceptions.push(m.params.exceptionDetails);
      if (m.method === 'Runtime.consoleAPICalled') {
        const item = { type: m.params.type, args: m.params.args?.map(a => ({ value: a.value, description: a.description })) };
        this.events.logs.push(item); if (m.params.type === 'error') this.events.consoleErrors.push(item);
      }
      if (m.id !== undefined && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    });
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  async evaluate(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; }
  async screenshot(path) { const s = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); writeFileSync(path, Buffer.from(s.data, 'base64')); }
}

async function run(label, base, debugPort) {
  const profile = `/tmp/native-boot-${process.pid}-${label}`;
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-extensions', '--hide-scrollbars', '--window-size=1280,720', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let cdp;
  try {
    let target;
    for (let i = 0; i < 100; i++) { try { target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json(); break; } catch { await wait(100); } }
    if (!target?.webSocketDebuggerUrl) throw Error(`Chrome CDP failed to start for ${label}`);
    cdp = new CDP(new WebSocket(target.webSocketDebuggerUrl));
    await new Promise((r, j) => { cdp.ws.addEventListener('open', r, { once: true }); cdp.ws.addEventListener('error', j, { once: true }); });
    await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{window.__coldProbe={raf:0,errors:[],rejections:[]};const p=window.__coldProbe;window.addEventListener('error',e=>p.errors.push({message:e.message,filename:e.filename,lineno:e.lineno,colno:e.colno,stack:e.error?.stack}));window.addEventListener('unhandledrejection',e=>p.rejections.push({reason:String(e.reason),stack:e.reason?.stack}));(function tick(){p.raf++;requestAnimationFrame(tick)})()})()` });
    await cdp.send('Page.navigate', { url: `${base}/` });
    const samples = [];
    for (const t of [500, 2000, 5000, 10000, 20000, 30000]) {
      await wait(t - (samples.length ? [500, 2000, 5000, 10000, 20000, 30000][samples.length - 1] : 0));
      const state = await cdp.evaluate(`(()=>{const canvases=[...document.querySelectorAll('canvas')];let gl=null;for(const c of canvases){gl=c.getContext('webgl2')||c.getContext('webgl')||c.getContext('experimental-webgl');if(gl)break}let game=null;try{game=window.__game?{perf:window.__game.perf?.(),runtime:window.__game.runtime?.(),vehicle:window.__game.vehicle?.telemetry?.()}:null}catch(e){game={evaluationError:e.stack||String(e)}}return {href:location.href,readyState:document.readyState,title:document.title,bodyText:(document.body?.innerText||'').slice(0,1500),canvasCount:canvases.length,canvas:canvases.map(c=>({width:c.width,height:c.height,cssWidth:c.clientWidth,cssHeight:c.clientHeight})),webgl:gl?{version:gl.getParameter(gl.VERSION),vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),drawingBufferWidth:gl.drawingBufferWidth,drawingBufferHeight:gl.drawingBufferHeight}:null,game,raf:window.__coldProbe?.raf,windowErrors:window.__coldProbe?.errors,unhandled:window.__coldProbe?.rejections,networkReady:performance.getEntriesByType('resource').filter(e=>e.name.includes('.js')).map(e=>({name:e.name.split('/').pop(),duration:e.duration,transfer:e.transferSize}))}})()`);
      samples.push({ elapsedMs: t, state });
      if (t === 500) await cdp.screenshot(resolve(out, `${label}-cold-0.5s.png`));
    }
    await cdp.screenshot(resolve(out, `${label}-cold-30s.png`));
    return { label, base, samples, ...cdp.events };
  } finally {
    try { cdp?.ws.close(); } catch {}
    proc.kill('SIGTERM');
    await wait(300);
  }
}

const results = [];
results.push(await run('dev5174', 'http://127.0.0.1:5174', 9367));
results.push(await run('preview4199', 'http://127.0.0.1:4199', 9368));
writeFileSync(resolve(here, 'cold-native-boot.json'), JSON.stringify({ generatedAt: new Date().toISOString(), method: 'fresh Chrome process, no manualStep/manualInput, Runtime.exceptionThrown captured with full exceptionDetails; cold page and readiness samples', results }, null, 2));
console.log(JSON.stringify(results.map(r => ({ label: r.label, exceptionCount: r.exceptions.length, consoleErrors: r.consoleErrors.length, samples: r.samples.map(s => ({ elapsedMs: s.elapsedMs, raf: s.state.raf, game: s.state.game?.perf, gl: s.state.webgl })) })), null, 2));
