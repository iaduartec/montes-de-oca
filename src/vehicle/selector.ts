/**
 * Selector de vehículo (FASE 2: UI sobre los presets de `presets.ts`).
 *
 * Construye las tarjetas desde `VEHICLE_PRESETS` (data-driven: si cambia la
 * lista, la UI cambia sola) y expone `setCurrent`/`toggle` para que `main.ts`
 * lo cablee a la tecla V, al chip del HUD y al botón táctil. Sin imágenes:
 * las tarjetas muestran nombre, resumen y cifras reales del preset.
 */

import { DEFAULT_VEHICLE_PARAMS, type VehicleParams } from './physics';
import { VEHICLE_PRESETS } from './presets';

export interface VehicleSelectorOptions {
  panel: HTMLElement;
  chip: HTMLButtonElement;
  canvas: HTMLElement;
  initialId: string;
  onSelect(id: string): void;
}

export interface VehicleSelector {
  setCurrent(id: string): void;
  toggle(abrir?: boolean): void;
  isOpen(): boolean;
}

function mergedParams(presetId: string): VehicleParams {
  const preset = VEHICLE_PRESETS.find((p) => p.id === presetId);
  return { ...DEFAULT_VEHICLE_PARAMS, ...(preset ? preset.params : {}) };
}

function statHtml(etiqueta: string, valor: string): string {
  return `<span class="vehiculo-stat">${etiqueta} <b>${valor}</b></span>`;
}

export function createVehicleSelector(options: VehicleSelectorOptions): VehicleSelector {
  const { panel, chip, canvas, onSelect } = options;
  const list = panel.querySelector<HTMLElement>('.vehiculo-lista');
  if (!list) throw new Error('selector de vehículo: falta .vehiculo-lista en el panel');

  const cards = new Map<string, HTMLButtonElement>();
  for (const preset of VEHICLE_PRESETS) {
    const merged = mergedParams(preset.id);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'vehiculo-tarjeta';
    card.dataset.preset = preset.id;
    card.setAttribute('aria-current', 'false');
    card.innerHTML =
      `<span class="vehiculo-nombre">${preset.name}</span>` +
      `<span class="vehiculo-marca" hidden>Actual</span>` +
      `<span class="vehiculo-resumen">${preset.summary}</span>` +
      `<span class="vehiculo-stats">` +
      statHtml('Masa', `${merged.mass} kg`) +
      statHtml('Vel. máx', `${Math.round(merged.maxSpeed * 3.6)} km/h`) +
      statHtml('Tracción', `${(merged.maxDriveForce / 1000).toFixed(1)} kN`) +
      statHtml('Dirección', `${Math.round((merged.steerMax * 180) / Math.PI)}°`) +
      `</span>`;
    card.addEventListener('click', () => onSelect(preset.id));
    list.appendChild(card);
    cards.set(preset.id, card);
  }

  function setCurrent(id: string): void {
    const active = VEHICLE_PRESETS.find((p) => p.id === id) ?? VEHICLE_PRESETS[0];
    if (!active) return;
    for (const [presetId, card] of cards) {
      const isActive = presetId === active.id;
      card.classList.toggle('activa', isActive);
      card.setAttribute('aria-current', isActive ? 'true' : 'false');
      const badge = card.querySelector<HTMLElement>('.vehiculo-marca');
      if (badge) badge.hidden = !isActive;
    }
    chip.textContent = `4x4 · ${active.name}`;
  }

  function toggle(abrir?: boolean): void {
    const open = abrir ?? panel.hidden;
    panel.hidden = !open;
    chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      const active = panel.querySelector<HTMLButtonElement>('.vehiculo-tarjeta.activa') ??
        panel.querySelector<HTMLButtonElement>('.vehiculo-tarjeta');
      active?.focus();
    } else if (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)) {
      canvas.focus({ preventScroll: true });
    }
  }

  chip.addEventListener('click', () => toggle());
  panel.addEventListener('keydown', (event) => {
    if (event.code === 'Escape') toggle(false);
  });

  setCurrent(options.initialId);

  return {
    setCurrent,
    toggle,
    isOpen: () => !panel.hidden,
  };
}
