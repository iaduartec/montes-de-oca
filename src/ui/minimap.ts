export type RoadClass = 'ROAD' | 'TRACK' | 'PATH';
export interface RoadMapLine {
  readonly id: string;
  readonly class: RoadClass;
  readonly points: readonly (readonly [number, number])[];
}
export interface MapPoint { readonly x: number; readonly z: number }
export interface LandmarkLabel extends MapPoint {
  readonly id: string;
  readonly name: string;
  readonly kind: 'church' | 'square' | 'bar' | 'dam';
}
export interface MinimapState extends MapPoint { readonly headingRad: number | null }
export interface MinimapOptions {
  readonly canvas: HTMLCanvasElement;
  readonly roads: readonly RoadMapLine[];
  readonly route: readonly MapPoint[];
  readonly labels: readonly LandmarkLabel[];
  readonly recenterButton?: HTMLButtonElement;
  readonly radiusM?: number;
}
export interface Minimap {
  update(state: MinimapState): void;
  dispose(): void;
}

const MIN_SCALE = 0.55;
const MAX_SCALE = 4;
const UPDATE_INTERVAL_MS = 100;

export function normalizedHeading(value: number | null, previous: number): number {
  return value !== null && Number.isFinite(value) ? value : previous;
}

export function clampZoom(value: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
}

export function panMapCenter(center: MapPoint, deltaXpx: number, deltaYpx: number, headingRad: number, pixelsPerMetre: number): MapPoint {
  const dx = deltaXpx / pixelsPerMetre;
  const dy = deltaYpx / pixelsPerMetre;
  return {
    x: center.x - Math.cos(headingRad) * dx + Math.sin(headingRad) * dy,
    z: center.z + Math.sin(headingRad) * dx + Math.cos(headingRad) * dy,
  };
}

export function nextDrawDelay(nowMs: number, lastDrawMs: number, immediate = false): number {
  return immediate ? 0 : Math.max(0, UPDATE_INTERVAL_MS - (nowMs - lastDrawMs));
}

/** Projects world XZ into screen pixels with the current heading pointing up. */
export function projectMapPoint(
  point: MapPoint,
  center: MapPoint,
  headingRad: number,
  pixelsPerMetre: number,
): { x: number; y: number } {
  const dx = point.x - center.x;
  const dz = point.z - center.z;
  return {
    x: (Math.cos(headingRad) * dx - Math.sin(headingRad) * dz) * pixelsPerMetre,
    y: -(Math.sin(headingRad) * dx + Math.cos(headingRad) * dz) * pixelsPerMetre,
  };
}

export function createMinimap(options: MinimapOptions): Minimap {
  const { canvas } = options;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('minimapa: Canvas 2D no disponible');
  const radiusM = options.radiusM ?? 110;
  let latest: MinimapState | null = null;
  let center: MapPoint | null = null;
  let heading = 0;
  let zoom = 1;
  let following = true;
  let lastDraw = -Infinity;
  let drawCount = 0;
  let timer: number | null = null;
  let disposed = false;
  const pointers = new Map<number, { x: number; y: number }>();
  let dragPoint: { x: number; y: number } | null = null;
  let pinchDistance: number | null = null;

  const stop = (event: Event): void => {
    event.stopPropagation();
  };
  const pixelRatio = (): number => Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const resize = (): void => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const dpr = pixelRatio();
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };
  const drawNow = (): void => {
    if (!latest || disposed) return;
    resize();
    const width = canvas.width;
    const height = canvas.height;
    if (width === 0 || height === 0) return;
    const scale = (Math.min(width, height) / (radiusM * 2)) * zoom;
    const mapCenter = center ?? latest;
    context!.clearRect(0, 0, width, height);
    context!.save();
    context!.beginPath();
    context!.arc(width / 2, height / 2, Math.min(width, height) / 2 - 1, 0, Math.PI * 2);
    context!.clip();
    context!.fillStyle = 'rgba(12, 21, 22, .88)';
    context!.fillRect(0, 0, width, height);
    const px = (p: MapPoint): { x: number; y: number } => {
      const v = projectMapPoint(p, mapCenter, heading, scale);
      return { x: width / 2 + v.x, y: height / 2 + v.y };
    };
    for (const road of options.roads) {
      if (road.points.length < 2) continue;
      context!.beginPath();
      road.points.forEach(([x, z], index) => {
        const p = px({ x, z });
        if (index === 0) context!.moveTo(p.x, p.y);
        else context!.lineTo(p.x, p.y);
      });
      context!.lineWidth = road.class === 'ROAD' ? 2.5 : road.class === 'TRACK' ? 1.8 : 1.2;
      context!.strokeStyle = road.class === 'ROAD' ? '#d6c8aa' : road.class === 'TRACK' ? '#a88b63' : '#7f896c';
      context!.globalAlpha = road.class === 'PATH' ? 0.65 : 0.92;
      context!.stroke();
    }
    context!.globalAlpha = 1;
    if (options.route.length > 1) {
      context!.beginPath();
      options.route.forEach((point, index) => {
        const p = px(point);
        if (index === 0) context!.moveTo(p.x, p.y);
        else context!.lineTo(p.x, p.y);
      });
      context!.lineWidth = 2;
      context!.strokeStyle = '#e6a34d';
      context!.setLineDash([5 * pixelRatio(), 3 * pixelRatio()]);
      context!.stroke();
      context!.setLineDash([]);
    }
    for (const label of options.labels) {
      const p = px(label);
      if (Math.abs(p.x - width / 2) > width * 0.46 || Math.abs(p.y - height / 2) > height * 0.46) continue;
      context!.fillStyle = label.kind === 'church' ? '#f4dfaa' : label.kind === 'dam' ? '#85c7d2' : '#d6b68a';
      context!.beginPath();
      context!.arc(p.x, p.y, 3 * pixelRatio(), 0, Math.PI * 2);
      context!.fill();
      context!.font = `${10 * pixelRatio()}px system-ui, sans-serif`;
      context!.fillStyle = '#fff8e9';
      context!.fillText(label.name, p.x + 5 * pixelRatio(), p.y - 4 * pixelRatio(), width * 0.36);
    }
    // Vehicle marker is fixed at the center; north-up rotation is expressed by the map.
    context!.translate(width / 2, height / 2);
    context!.fillStyle = '#fff3d5';
    context!.strokeStyle = '#362919';
    context!.lineWidth = 1.5 * pixelRatio();
    context!.beginPath();
    context!.moveTo(0, -8 * pixelRatio());
    context!.lineTo(5.5 * pixelRatio(), 6 * pixelRatio());
    context!.lineTo(0, 3 * pixelRatio());
    context!.lineTo(-5.5 * pixelRatio(), 6 * pixelRatio());
    context!.closePath();
    context!.fill();
    context!.stroke();
    context!.restore();
    context!.beginPath();
    context!.arc(width / 2, height / 2, Math.min(width, height) / 2 - pixelRatio(), 0, Math.PI * 2);
    context!.strokeStyle = 'rgba(255, 245, 222, .65)';
    context!.lineWidth = pixelRatio();
    context!.stroke();
    lastDraw = performance.now();
    canvas.dataset.drawCount = String(++drawCount);
    canvas.dataset.followingPlayer = String(following);
    canvas.dataset.zoom = zoom.toFixed(2);
  };
  const schedule = (immediate = false): void => {
    if (disposed) return;
    if (timer !== null) window.clearTimeout(timer);
    const delay = nextDrawDelay(performance.now(), lastDraw, immediate);
    timer = window.setTimeout(() => {
      timer = null;
      drawNow();
    }, delay);
  };
  const recenter = (): void => {
    following = true;
    canvas.dataset.followingPlayer = 'true';
    if (latest) center = { x: latest.x, z: latest.z };
    schedule(true);
  };
  const onPointerDown = (event: PointerEvent): void => {
    stop(event);
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) dragPoint = { x: event.clientX, y: event.clientY };
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      dragPoint = null;
    }
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!pointers.has(event.pointerId)) return;
    stop(event);
    const previous = pointers.get(event.pointerId)!;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const rect = canvas.getBoundingClientRect();
    const scale = (Math.min(rect.width, rect.height) / (radiusM * 2)) * zoom;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchDistance && distance > 0) zoom = clampZoom(zoom * distance / pinchDistance);
      pinchDistance = distance;
    } else if (dragPoint && latest && center) {
      const dx = event.clientX - previous.x;
      const dy = event.clientY - previous.y;
      center = panMapCenter(center, dx, dy, heading, scale);
      following = false;
      canvas.dataset.followingPlayer = 'false';
    }
    dragPoint = pointers.size === 1 ? { x: event.clientX, y: event.clientY } : null;
    schedule(true);
  };
  const onPointerUp = (event: PointerEvent): void => {
    stop(event);
    pointers.delete(event.pointerId);
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (pointers.size < 2) pinchDistance = null;
    dragPoint = pointers.size === 1 ? [...pointers.values()][0] ?? null : null;
  };
  const onWheel = (event: WheelEvent): void => {
    stop(event);
    event.preventDefault();
    zoom = clampZoom(zoom * Math.exp(-event.deltaY * 0.001));
    schedule(true);
  };
  const onContextMenu = (event: Event): void => { stop(event); event.preventDefault(); };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  const onRecenter = (): void => recenter();
  options.recenterButton?.addEventListener('click', onRecenter);
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule(true));
  observer?.observe(canvas);

  return {
    update: (state): void => {
      latest = state;
      heading = normalizedHeading(state.headingRad, heading);
      if (following || center === null) center = { x: state.x, z: state.z };
      schedule();
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      observer?.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      options.recenterButton?.removeEventListener('click', onRecenter);
    },
  };
}
