import type { SurfaceDefinition } from '../world/surfaces';

export interface VehicleAudioInput {
  readonly speed: number;
  readonly load: number;
  readonly slip: boolean;
  readonly driving: boolean;
  readonly surface: SurfaceDefinition;
}

/** First procedural sound pass: reusable nodes, no downloaded/unlicensed samples. */
export function createVehicleAudio(target: EventTarget = window) {
  let context: AudioContext | null = null;
  let engine: OscillatorNode | null = null;
  let motorGain: GainNode | null = null;
  let wheelGain: GainNode | null = null;
  let wheelFilter: BiquadFilterNode | null = null;
  let windGain: GainNode | null = null;
  let disposed = false;
  let enabled = true;
  let masterGain: GainNode | null = null;
  const owned: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  let input: VehicleAudioInput | null = null;

  const activate = () => {
    if (disposed || !enabled) return;
    if (!context && typeof AudioContext !== 'undefined') {
      context = new AudioContext();
      const master = context.createGain();
      masterGain = master;
      master.gain.value = 0.18;
      master.connect(context.destination);
      owned.push(master);
      engine = context.createOscillator();
      engine.type = 'sawtooth';
      const motorFilter = context.createBiquadFilter();
      motorFilter.type = 'lowpass'; motorFilter.frequency.value = 220;
      motorGain = context.createGain(); motorGain.gain.value = 0;
      engine.connect(motorFilter).connect(motorGain).connect(master);
      engine.start();
      sources.push(engine); owned.push(engine, motorFilter, motorGain);
      // One persistent noise buffer supplies rolling texture and subdued wind.
      const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
      const samples = buffer.getChannelData(0);
      let seed = 1729;
      for (let i = 0; i < samples.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        samples[i] = (seed >>> 0) / 2147483648 - 1;
      }
      const noise = context.createBufferSource(); noise.buffer = buffer; noise.loop = true;
      wheelFilter = context.createBiquadFilter(); wheelFilter.type = 'bandpass'; wheelFilter.Q.value = 0.7;
      wheelGain = context.createGain(); wheelGain.gain.value = 0;
      noise.connect(wheelFilter).connect(wheelGain).connect(master);
      const windFilter = context.createBiquadFilter(); windFilter.type = 'lowpass'; windFilter.frequency.value = 160;
      windGain = context.createGain(); windGain.gain.value = 0.025;
      noise.connect(windFilter).connect(windGain).connect(master);
      noise.start(); sources.push(noise); owned.push(noise, wheelFilter, wheelGain, windFilter, windGain);
    }
    if (context?.state === 'suspended') void context.resume().catch((error: unknown) => console.warn('[audio] resume failed', error));
    if (input) update(input);
  };
  const update = (next: VehicleAudioInput) => {
    input = next;
    if (!context || !engine || !motorGain || !wheelGain || !wheelFilter || !windGain || disposed) return;
    const speed = Math.min(1, Math.abs(next.speed) / 28);
    const load = Math.min(1, Math.abs(next.load));
    const time = context.currentTime;
    engine.frequency.setTargetAtTime(32 + speed * 75 + load * 22, time, 0.08);
    motorGain.gain.setTargetAtTime(next.driving ? 0.12 + load * 0.12 : 0, time, 0.12);
    wheelFilter.frequency.setTargetAtTime(280 + next.surface.roughness * 1250 + speed * 500, time, 0.1);
    wheelGain.gain.setTargetAtTime(next.driving ? speed * (next.surface.wheelAudio * 0.32 + (next.slip ? 0.08 : 0)) : 0, time, 0.1);
    windGain.gain.setTargetAtTime(0.025 + (next.driving ? speed * 0.055 : 0), time, 0.2);
  };
  target.addEventListener('pointerdown', activate);
  target.addEventListener('keydown', activate);
  return {
    update,
    setEnabled: (next: boolean) => {
      enabled = next;
      if (next) activate();
      if (context && masterGain) masterGain.gain.setTargetAtTime(next ? 0.18 : 0, context.currentTime, 0.05);
    },
    stats: () => ({ state: context?.state ?? 'locked', nodes: owned.length, sources: sources.length,
      enabled, procedural: true, surface: input?.surface.type ?? null }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      target.removeEventListener('pointerdown', activate);
      target.removeEventListener('keydown', activate);
      for (const source of sources) source.stop();
      for (const node of owned) node.disconnect();
      if (context) void context.close();
      input = null;
    },
  };
}
