import type { SurfaceDefinition } from '../world/surfaces';

/** Normalized world ambience controls; waterPan is -1 (left) to +1 (right). */
export interface VehicleAmbientInput {
  readonly wind: number;
  readonly forest: number;
  readonly village: number;
  readonly water: number;
  readonly waterPan: number;
}

export interface VehicleAudioInput {
  readonly speed: number;
  readonly load: number;
  readonly slip: boolean;
  readonly driving: boolean;
  readonly surface: SurfaceDefinition;
  readonly ambient?: VehicleAmbientInput;
  /** Suspension impact impulse, normalized to [0, 1]. */
  readonly impact?: number;
}

/** First procedural sound pass: reusable nodes, no downloaded/unlicensed samples. */
export function createVehicleAudio(target: EventTarget = window) {
  let context: AudioContext | null = null;
  let engine: OscillatorNode | null = null;
  let motorGain: GainNode | null = null;
  let wheelGain: GainNode | null = null;
  let wheelFilter: BiquadFilterNode | null = null;
  let windGain: GainNode | null = null;
  let ambientWindGain: GainNode | null = null;
  let waterGain: GainNode | null = null;
  let waterPanner: StereoPannerNode | null = null;
  let forestBirdGain: GainNode | null = null;
  let villageBirdGain: GainNode | null = null;
  let forestBird: OscillatorNode | null = null;
  let villageBird: OscillatorNode | null = null;
  let impactGain: GainNode | null = null;
  let impactFilter: BiquadFilterNode | null = null;
  let disposed = false;
  let enabled = true;
  let masterGain: GainNode | null = null;
  const owned: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  let input: VehicleAudioInput | null = null;
  let nextImpactTime = 0;
  let impactEvents = 0;

  const unit = (value: number | undefined): number => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value)) : 0;

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
      const ambientWindFilter = context.createBiquadFilter();
      ambientWindFilter.type = 'lowpass'; ambientWindFilter.frequency.value = 360;
      ambientWindGain = context.createGain(); ambientWindGain.gain.value = 0;
      noise.connect(ambientWindFilter).connect(ambientWindGain).connect(master);
      const waterFilter = context.createBiquadFilter();
      waterFilter.type = 'bandpass'; waterFilter.frequency.value = 640; waterFilter.Q.value = 0.45;
      waterPanner = context.createStereoPanner();
      waterGain = context.createGain(); waterGain.gain.value = 0;
      noise.connect(waterFilter).connect(waterPanner).connect(waterGain).connect(master);

      // Persistent tonal bird calls are gated by ambient levels; no oscillator
      // or envelope nodes are created from the frame update path.
      forestBird = context.createOscillator(); forestBird.type = 'sine'; forestBird.frequency.value = 1880;
      const forestFilter = context.createBiquadFilter(); forestFilter.type = 'lowpass'; forestFilter.frequency.value = 3200;
      forestBirdGain = context.createGain(); forestBirdGain.gain.value = 0;
      forestBird.connect(forestFilter).connect(forestBirdGain).connect(master);
      forestBird.start(); sources.push(forestBird);
      villageBird = context.createOscillator(); villageBird.type = 'sine'; villageBird.frequency.value = 2380;
      const villageFilter = context.createBiquadFilter(); villageFilter.type = 'lowpass'; villageFilter.frequency.value = 3600;
      villageBirdGain = context.createGain(); villageBirdGain.gain.value = 0;
      villageBird.connect(villageFilter).connect(villageBirdGain).connect(master);
      villageBird.start(); sources.push(villageBird);

      impactFilter = context.createBiquadFilter();
      impactFilter.type = 'bandpass'; impactFilter.frequency.value = 360; impactFilter.Q.value = 0.8;
      impactGain = context.createGain(); impactGain.gain.value = 0;
      noise.connect(impactFilter).connect(impactGain).connect(master);

      noise.start(); sources.push(noise);
      owned.push(noise, wheelFilter, wheelGain, windFilter, windGain,
        ambientWindFilter, ambientWindGain, waterFilter, waterPanner, waterGain,
        forestBird, forestFilter, forestBirdGain, villageBird, villageFilter, villageBirdGain,
        impactFilter, impactGain);
    }
    if (context?.state === 'suspended') void context.resume().catch((error: unknown) => console.warn('[audio] resume failed', error));
    if (input) applyInput(input, false);
  };
  const applyInput = (next: VehicleAudioInput, allowImpact: boolean) => {
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

    const ambient = next.ambient;
    const wind = unit(ambient?.wind);
    const forest = unit(ambient?.forest);
    const village = unit(ambient?.village);
    const water = unit(ambient?.water);
    ambientWindGain?.gain.setTargetAtTime(wind * 0.055, time, 0.24);
    waterGain?.gain.setTargetAtTime(water * 0.065, time, 0.18);
    const pan = typeof ambient?.waterPan === 'number' && Number.isFinite(ambient.waterPan)
      ? Math.max(-1, Math.min(1, ambient.waterPan)) : 0;
    waterPanner?.pan.setTargetAtTime(pan, time, 0.2);
    // Two quiet synthesized calls with slow, separated pulses. These are tones,
    // not recordings or spatially modeled wildlife.
    const forestPulse = Math.pow(Math.max(0, Math.sin(time * 4.7)), 5);
    const villagePulse = Math.pow(Math.max(0, Math.sin(time * 3.3 + 1.8)), 6);
    forestBirdGain?.gain.setTargetAtTime(forest * forestPulse * 0.018, time, 0.035);
    villageBirdGain?.gain.setTargetAtTime(village * villagePulse * 0.012, time, 0.045);
    const forestPhase = Math.max(0, Math.sin(time * 4.7));
    const villagePhase = Math.max(0, Math.sin(time * 3.3 + 1.8));
    forestBird?.frequency.setTargetAtTime(1740 + forestPhase * 360, time, 0.025);
    villageBird?.frequency.setTargetAtTime(2200 + villagePhase * 420, time, 0.03);

    const impact = unit(next.impact);
    if (allowImpact && enabled && impact >= 0.12 && time >= nextImpactTime && impactGain && impactFilter) {
      nextImpactTime = time + 0.22;
      impactEvents++;
      impactFilter.frequency.setTargetAtTime(180 + impact * 520, time, 0.012);
      impactGain.gain.cancelScheduledValues(time);
      impactGain.gain.setValueAtTime(0.0001, time);
      impactGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, impact * 0.32), time + 0.008);
      impactGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.095);
      impactGain.gain.setValueAtTime(0, time + 0.11);
    }
  };
  const update = (next: VehicleAudioInput) => applyInput(next, true);
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
      enabled, procedural: true, surface: input?.surface.type ?? null,
      ambient: Boolean(input?.ambient),
      ambientLevels: {
        wind: unit(input?.ambient?.wind), forest: unit(input?.ambient?.forest),
        village: unit(input?.ambient?.village), water: unit(input?.ambient?.water),
        waterPan: typeof input?.ambient?.waterPan === 'number' && Number.isFinite(input.ambient.waterPan)
          ? Math.max(-1, Math.min(1, input.ambient.waterPan)) : 0,
      },
      impactEvents }),
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
