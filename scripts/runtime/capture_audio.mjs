// Real browser WebAudio graph capture and bounded PCM-independent WebM export.
// This instruments the browser context before app scripts run; product files remain untouched.
// Example: node scripts/runtime/capture_audio.mjs --base http://127.0.0.1:5174 --out-dir outputs/audio-v2/before --expect-sources 2
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
}
const PORT = Number(arg('--port', '9314'));
const BASE = arg('--base', 'http://127.0.0.1:5174');
const OUT_DIR = resolve(root, arg('--out-dir', 'outputs/audio-v2/capture'));
const CHROME = arg('--chrome', 'google-chrome');
const RECORD_SECONDS = Math.min(20, Math.max(1, Number(arg('--record-seconds', '15'))));
const EXPECTED_SOURCES = arg('--expect-sources', '');
const PROFILE = `/tmp/montes-audio-cdp-${PORT}`;
const WIDTH = 1280;
const HEIGHT = 720;

function wait(ms) { return new Promise((resolveWait) => setTimeout(resolveWait, ms)); }
async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') this.errors.push(message.params.args.map((value) => value.value ?? value.description).join(' '));
      if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveSend, rejectSend) => this.pending.set(id, { resolve: resolveSend, reject: rejectSend }));
  }
  async evaluate(expression, userGesture = false) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'Runtime.evaluate failed');
    if (result.result?.subtype === 'error') throw new Error(result.result.description ?? 'Runtime.evaluate returned an error');
    return result.result?.value;
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true });
    ws.addEventListener('error', rejectOpen, { once: true });
  });
  return new Cdp(ws);
}

const instrumentation = `(() => {
  const state = { contexts: [], allocations: {}, connections: 0, connectTypes: {}, errors: [], startTime: performance.now() };
  const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
  const wrap = (context) => {
    try {
      const destinationGetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(context), 'destination')?.get;
      const nativeDestination = destinationGetter ? destinationGetter.call(context) : context.destination;
      const streamDestination = context.createMediaStreamDestination();
      const outputTap = context.createGain();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      outputTap.connect(analyser);
      analyser.connect(nativeDestination);
      outputTap.connect(streamDestination);
      Object.defineProperty(context, 'destination', { configurable: true, get: () => outputTap });
      const stats = { sampleRate: context.sampleRate, state: context.state, allocations: {}, connections: 0, streamDestination, outputTap, analyser };
      const methods = ['createGain','createOscillator','createBufferSource','createBiquadFilter','createStereoPanner','createAnalyser','createDynamicsCompressor','createWaveShaper','createDelay','createConvolver','createChannelSplitter','createChannelMerger'];
      for (const method of methods) {
        if (typeof context[method] !== 'function') continue;
        const original = context[method].bind(context);
        context[method] = (...args) => {
          const node = original(...args);
          const key = node.constructor?.name || method;
          stats.allocations[key] = (stats.allocations[key] || 0) + 1;
          state.allocations[key] = (state.allocations[key] || 0) + 1;
          return node;
        };
      }
      const record = { context, stats, sample: () => {
        const values = new Float32Array(stats.analyser.fftSize);
        stats.analyser.getFloatTimeDomainData(values);
        let energy = 0;
        let peak = 0;
        for (const value of values) { energy += value * value; peak = Math.max(peak, Math.abs(value)); }
        return { rms: Math.sqrt(energy / values.length), peak };
      } };
      state.contexts.push(record);
    } catch (error) { state.errors.push(String(error)); }
  };
  if (NativeAudioContext) {
    const WrappedAudioContext = function(...args) {
      const context = new NativeAudioContext(...args);
      wrap(context);
      return context;
    };
    WrappedAudioContext.prototype = NativeAudioContext.prototype;
    Object.setPrototypeOf(WrappedAudioContext, NativeAudioContext);
    window.AudioContext = WrappedAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = WrappedAudioContext;
  }
  const AudioNodePrototype = window.AudioNode?.prototype;
  if (AudioNodePrototype && !AudioNodePrototype.__audioProbeWrapped) {
    const originalConnect = AudioNodePrototype.connect;
    AudioNodePrototype.connect = function(destination, ...args) {
      state.connections++;
      const source = this.constructor?.name || 'AudioNode';
      const target = destination?.constructor?.name || 'AudioParam';
      const key = source + '->' + target;
      state.connectTypes[key] = (state.connectTypes[key] || 0) + 1;
      for (const context of state.contexts) context.stats.connections++;
      return originalConnect.call(this, destination, ...args);
    };
    Object.defineProperty(AudioNodePrototype, '__audioProbeWrapped', { value: true });
  }
  const api = {
    state,
    snapshot: () => ({ contexts: state.contexts.map(({context, stats, sample}) => ({ state: context.state, sampleRate: stats.sampleRate, allocations: {...stats.allocations}, connections: stats.connections, signal: sample() })), totals: { allocations: {...state.allocations}, connections: state.connections, connectTypes: {...state.connectTypes} }, errors: [...state.errors] }),
    record: async (seconds) => {
      const record = state.contexts[0];
      if (!record) throw new Error('No AudioContext exists after the real gesture');
      if (!window.MediaRecorder) throw new Error('MediaRecorder unavailable in this browser');
      const stream = record.stats.streamDestination.stream;
      const mimeType = ['audio/webm;codecs=opus','audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('MediaRecorder has no supported audio/webm type');
      const recorder = new MediaRecorder(stream, {mimeType});
      const chunks = [];
      const samples = [];
      const timer = setInterval(() => samples.push({elapsedMs: Math.round(performance.now() - started), ...record.sample()}), 1000);
      const started = performance.now();
      return await new Promise((resolve, reject) => {
        recorder.addEventListener('dataavailable', (event) => { if (event.data?.size) chunks.push(event.data); });
        recorder.addEventListener('error', (event) => { clearInterval(timer); reject(event.error || new Error('MediaRecorder error')); }, {once:true});
        recorder.addEventListener('stop', async () => {
          clearInterval(timer);
          try {
            const blob = new Blob(chunks, {type: mimeType});
            const bytes = await blob.arrayBuffer();
            let binary = '';
            const data = new Uint8Array(bytes);
            const stride = 0x8000;
            for (let offset = 0; offset < data.length; offset += stride) binary += String.fromCharCode(...data.subarray(offset, offset + stride));
            resolve({mimeType, bytes: data.length, base64: btoa(binary), durationMs: Math.round(performance.now() - started), samples});
          } catch (error) { reject(error); }
        }, {once:true});
        recorder.start(500);
        setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, Math.min(20, Math.max(1, seconds)) * 1000);
      });
    }
  };
  Object.defineProperty(window, '__audioProbe', {value: api, configurable: false});
})();`;

function audioDiagnosticPoints(origin) {
  const vegetation = JSON.parse(readFileSync(resolve(root, 'public/vegetation/vegetation.json'), 'utf8'));
  const water = JSON.parse(readFileSync(resolve(root, 'public/water/water.json'), 'utf8'));
  const species = new Set(['roble', 'haya', 'abedul', 'pino']);
  const forestCells = new Map();
  for (const tree of vegetation.instances) {
    if (!species.has(tree.type) || Math.hypot(tree.x - origin.x, tree.z - origin.z) < 250) continue;
    const cx = Math.floor(tree.x / 100);
    const cz = Math.floor(tree.z / 100);
    const key = `${cx}:${cz}`;
    const entry = forestCells.get(key) ?? { cx, cz, trees: 0 };
    entry.trees += 1;
    forestCells.set(key, entry);
  }
  const forest = [...forestCells.values()].sort((a, b) => b.trees - a.trees || a.cx - b.cx || a.cz - b.cz)[0];
  if (!forest || forest.trees < 20) throw new Error('Could not find a source-backed forest sample in vegetation.json');
  const forestPoint = { x: (forest.cx + 0.5) * 100, z: (forest.cz + 0.5) * 100 };

  let riverSegment = null;
  let nearbyWaterSegment = null;
  for (const ribbon of water.ribbons) {
    for (let index = 1; index < ribbon.points.length; index += 1) {
      const a = ribbon.points[index - 1];
      const b = ribbon.points[index];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const length = Math.hypot(dx, dz);
      if (length < 1e-6) continue;
      const x = (a[0] + b[0]) / 2;
      const z = (a[1] + b[1]) / 2;
      const distance = Math.hypot(x - origin.x, z - origin.z);
      if (distance < 45 || distance > 250) continue;
      const segment = { x, z, dx, dz, length, distance, ribbon: ribbon.kind ?? 'water' };
      if (!nearbyWaterSegment || distance < nearbyWaterSegment.distance) nearbyWaterSegment = segment;
      if (ribbon.kind === 'river' && (!riverSegment || distance < riverSegment.distance)) riverSegment = segment;
    }
  }
  riverSegment ??= nearbyWaterSegment;
  if (!riverSegment) throw new Error('Could not find a nearby source-backed water ribbon segment');
  const ux = riverSegment.dx / riverSegment.length;
  const uz = riverSegment.dz / riverSegment.length;
  // Stand beside the mapped channel, then compare heading and opposite heading.
  const x = riverSegment.x + uz * 18;
  const z = riverSegment.z - ux * 18;
  const yaw = Math.atan2(riverSegment.dx, riverSegment.dz);
  return {
    village: { name: 'village-spawn', x: origin.x, z: origin.z, yaw: origin.yaw, diagnosticTeleport: true },
    forest: { name: 'forest-tree-cluster', ...forestPoint, yaw, sourceCellTrees: forest.trees, diagnosticTeleport: true },
    riverForward: { name: 'river-channel-forward', x, z, yaw, sourceRibbon: riverSegment.ribbon, diagnosticTeleport: true },
    riverOpposite: { name: 'river-channel-opposite-heading', x, z, yaw: yaw + Math.PI, sourceRibbon: riverSegment.ribbon, diagnosticTeleport: true },
  };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(PROFILE, { recursive: true, force: true });
  const chrome = spawn(CHROME, ['--headless=new','--no-sandbox','--disable-dev-shm-usage',`--window-size=${WIDTH},${HEIGHT}`,'--enable-unsafe-swiftshader','--use-angle=swiftshader',`--remote-debugging-port=${PORT}`,'--remote-allow-origins=*',`--user-data-dir=${PROFILE}`,'about:blank'], { stdio: 'ignore' });
  let cdp;
  const report = { base: BASE, requestedRecordSeconds: RECORD_SECONDS, expectedSources: EXPECTED_SOURCES === '' ? null : Number(EXPECTED_SOURCES), capture: 'native WebAudio graph through a tee to MediaStreamDestination; synthesized/procedural audio, no human listening claim', errors: [] };
  try {
    let ready = false;
    for (let index = 0; index < 60 && !ready; index += 1) {
      try { await fetchJson(`http://127.0.0.1:${PORT}/json/version`); ready = true; } catch { await wait(500); }
    }
    if (!ready) throw new Error('Chrome startup timeout');
    const tab = await fetchJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    cdp = await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
    await cdp.send('Page.navigate', { url: `${BASE}/?quality=HIGH` });
    let playable = false;
    for (let index = 0; index < 240 && !playable; index += 1) {
      await wait(500);
      playable = await cdp.evaluate('!!window.__game?.player && !!document.getElementById("sound-toggle")').catch(() => false);
    }
    if (!playable) throw new Error('Game/audio control did not initialize before timeout');
    await wait(2000);
    report.beforeGesture = await cdp.evaluate('({audio:window.__game.runtime().audio, probe:window.__audioProbe.snapshot()})');
    if (report.beforeGesture.audio.state !== 'locked' || report.beforeGesture.probe.contexts.length !== 0) throw new Error('WebAudio allocated before gesture; expected the locked no-autoplay state');

    // Real pointer events unlock audio. Two clicks end with the original enabled state.
    const rect = await cdp.evaluate('(()=>{const r=document.getElementById("sound-toggle").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
    for (let click = 0; click < 2; click += 1) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
      await wait(150);
    }
    await wait(500);
    report.afterGesture = await cdp.evaluate('({audio:window.__game.runtime().audio, probe:window.__audioProbe.snapshot(), focus:document.activeElement?.id ?? null})');
    if (report.afterGesture.focus !== 'render-canvas') throw new Error(`Sound control did not return keyboard focus to render-canvas (${report.afterGesture.focus})`);
    if (report.afterGesture.audio.state !== 'running') throw new Error(`AudioContext not running after pointer gesture (${report.afterGesture.audio.state})`);
    if (report.afterGesture.audio.sources < 1) throw new Error('The game reports no scheduled WebAudio sources after gesture');
    if (EXPECTED_SOURCES !== '' && report.afterGesture.audio.sources !== Number(EXPECTED_SOURCES)) {
      throw new Error(`Expected ${EXPECTED_SOURCES} audio sources, got ${report.afterGesture.audio.sources}`);
    }

    const clickSound = async () => {
      const button = await cdp.evaluate('(()=>{const r=document.getElementById("sound-toggle").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: button.x, y: button.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: button.x, y: button.y, button: 'left', clickCount: 1 });
    };
    await clickSound();
    await wait(450);
    report.muted = await cdp.evaluate('({audio:window.__game.runtime().audio, signal:window.__audioProbe.snapshot().contexts[0]?.signal ?? null, focus:document.activeElement?.id ?? null})');
    if (report.muted.audio.enabled || !report.muted.signal || report.muted.signal.rms > 0.00002) throw new Error('Mute control failed to silence the instrumented master output');
    await clickSound();
    await wait(450);
    report.unmuted = await cdp.evaluate('({audio:window.__game.runtime().audio, signal:window.__audioProbe.snapshot().contexts[0]?.signal ?? null, focus:document.activeElement?.id ?? null})');
    if (!report.unmuted.audio.enabled || !report.unmuted.signal || report.unmuted.signal.rms <= 0.00001) throw new Error('Unmute control failed to restore the instrumented master output');

    const inputSamples = [];
    let driving = await cdp.evaluate('window.__game.player.telemetry()');
    if (driving.mode !== 'driving' && driving.canEnter) {
      await cdp.evaluate('window.__game.player.inject(null)');
      await cdp.evaluate('document.getElementById("render-canvas").focus({preventScroll:true})');
      const fKey = { key: 'f', code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...fKey });
      await wait(150);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...fKey });
      await wait(500);
      // The game's deterministic debug step consumes the real keyboard edge in
      // headless runs, where realtime simulation may be throttled or suspended.
      await cdp.evaluate('window.__game.player.step(0.2)');
      driving = await cdp.evaluate('window.__game.player.telemetry()');
    }
    report.entry = driving;
    if (driving.mode !== 'driving') throw new Error('Real KeyF did not enter the nearby 4x4; audio movement capture aborted');
    const origin = { x: driving.x, z: driving.z, yaw: (driving.yawDeg * Math.PI) / 180 };
    report.diagnosticPoints = audioDiagnosticPoints(origin);
    const recordPromise = cdp.evaluate(`window.__audioProbe.record(${RECORD_SECONDS})`);
    const wKey = { key: 'w', code: 'KeyW', text: 'w', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 };
    if (driving.mode === 'driving') await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...wKey });
    const monitorStarted = Date.now();
    try {
      while (Date.now() - monitorStarted < RECORD_SECONDS * 1000) {
        await wait(Math.min(driving.mode === 'driving' ? 100 : 2000, Math.max(100, RECORD_SECONDS * 1000 - (Date.now() - monitorStarted))));
        if (driving.mode === 'driving') await cdp.evaluate('window.__game.player.step(0.1)');
        if ((Date.now() - monitorStarted) % 2000 < 150) {
          inputSamples.push(await cdp.evaluate('({player:window.__game.player.telemetry(),runtime:window.__game.runtime()})'));
        }
      }
    } finally {
      if (driving.mode === 'driving') await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...wKey });
    }
    const recording = await recordPromise;
    const webm = Buffer.from(recording.base64, 'base64');
    if (webm.length < 1024) throw new Error(`WebM output too small (${webm.length} bytes)`);
    writeFileSync(resolve(OUT_DIR, 'audio.webm'), webm);
    report.recording = { mimeType: recording.mimeType, bytes: webm.length, durationMs: recording.durationMs, samples: recording.samples, inputSamples };
    const after = await cdp.evaluate('({audio:window.__game.runtime().audio, probe:window.__audioProbe.snapshot()})');
    report.afterRecord = after;
    if (!recording.samples.length || !recording.samples.some((sample) => sample.rms > 0.00001)) throw new Error('Recorded output analyser stayed silent throughout the capture');
    if (JSON.stringify(report.afterGesture.probe.totals.allocations) !== JSON.stringify(after.probe.totals.allocations)) throw new Error('WebAudio node allocations changed during bounded recording window');
    const moved = inputSamples.some((sample) => Math.hypot(sample.player.x - origin.x, sample.player.z - origin.z) > 0.5 || Math.abs(sample.player.speedMps) > 0.5);
    if (!moved) throw new Error('The real W input did not move the player during the recording window');

    report.ambientScenarios = [];
    for (const point of Object.values(report.diagnosticPoints)) {
      const previousUpdates = await cdp.evaluate('window.__game.runtime().audioEnvironment.updates');
      await cdp.evaluate(`(()=>{const g=window.__game;g.player.inject(null);g.player.teleport(${point.x},${point.z},${point.yaw});})()`);
      let sample = null;
      const refreshStarted = Date.now();
      while (Date.now() - refreshStarted < 4000) {
        await wait(150);
        sample = await cdp.evaluate('({player:window.__game.player.telemetry(),runtime:window.__game.runtime()})');
        if (sample.runtime.audioEnvironment.updates > previousUpdates) break;
      }
      if (!sample || sample.runtime.audioEnvironment.updates <= previousUpdates) throw new Error(`Ambient query did not refresh after diagnostic teleport to ${point.name}`);
      report.ambientScenarios.push({ ...point, measured: { position: { x: sample.player.x, z: sample.player.z }, yawDeg: sample.player.yawDeg, levels: sample.runtime.audio.ambientLevels ?? null, queryStats: sample.runtime.audioEnvironment ?? null } });
    }
    const riverPair = report.ambientScenarios.filter((scenario) => scenario.name.startsWith('river-channel'));
    if (riverPair.length === 2 && riverPair.every((scenario) => scenario.measured.levels && scenario.measured.levels.water > 0)) {
      const [forward, opposite] = riverPair.map((scenario) => scenario.measured.levels.waterPan);
      report.panCheck = { forward, opposite, passed: Math.abs(forward + opposite) < 0.2 && Math.abs(forward) > 0.3 && Math.abs(opposite) > 0.3 };
      if (!report.panCheck.passed) throw new Error(`River ambience did not reverse pan with opposite player heading (${forward}, ${opposite})`);
    } else report.panCheck = { passed: null, reason: 'runtime did not expose positive river ambience in both heading probes' };
    report.errors = cdp.errors;
    if (report.errors.length || after.probe.errors.length) throw new Error([...report.errors, ...after.probe.errors].join('\n'));
    writeFileSync(resolve(OUT_DIR, 'audio.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output: resolve(OUT_DIR, 'audio.webm'), bytes: webm.length, seconds: recording.durationMs / 1000, audio: after.audio, signalSamples: recording.samples.length, allocationsStable: true }));
  } catch (error) {
    report.failure = String(error);
    report.errors = cdp?.errors ?? report.errors;
    writeFileSync(resolve(OUT_DIR, 'audio.json'), JSON.stringify(report, null, 2) + '\n');
    throw error;
  } finally {
    cdp?.ws.close();
    chrome.kill('SIGTERM');
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
