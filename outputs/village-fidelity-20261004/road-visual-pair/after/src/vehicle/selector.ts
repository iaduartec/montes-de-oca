/**
 * Selector de vehículo (Tarea 6: catálogo de ocho opciones agrupadas por categoría).
 *
 * Construye las tarjetas desde `VEHICLE_CATALOG` en tres grupos (todoterrenos,
 * coches, motos): si cambia el catálogo, la UI cambia sola. Expone
 * `setCurrent`/`toggle` para que `main.ts` lo cablee a la tecla V, al chip del
 * HUD y al botón táctil. Sin imágenes: las tarjetas muestran nombre, resumen y
 * cifras reales de cada definición.
 */

import { DEFAULT_VEHICLE_PARAMS } from './physics';
import { VEHICLE_CATALOG, type MotorcycleDefinition, type VehicleDefinition } from './catalog';
import type { VehicleCategory } from './types';

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

/** Grupos del selector, en el orden en que se muestran. */
const CATEGORIAS: readonly { readonly category: VehicleCategory; readonly label: string; readonly chip: string }[] = [
  { category: 'todoterreno', label: 'Todoterrenos', chip: '4x4' },
  { category: 'coche', label: 'Coches', chip: 'Coche' },
  { category: 'moto', label: 'Motos', chip: 'Moto' },
];

function statHtml(etiqueta: string, valor: string): string {
  return `<span class="vehiculo-stat">${etiqueta} <b>${valor}</b></span>`;
}

/** Cifras de una definición: los cuatro ruedas usan el merge de presets. */
function statsFor(definition: VehicleDefinition): string {
  if (definition.category === 'moto') return motoStats(definition);
  const merged = { ...DEFAULT_VEHICLE_PARAMS, ...definition.params };
  return (
    statHtml('Masa', `${merged.mass} kg`) +
    statHtml('Vel. máx', `${Math.round(merged.maxSpeed * 3.6)} km/h`) +
    statHtml('Tracción', `${(merged.maxDriveForce / 1000).toFixed(1)} kN`) +
    statHtml('Dirección', `${Math.round((merged.steerMax * 180) / Math.PI)}°`)
  );
}

function motoStats(definition: MotorcycleDefinition): string {
  const p = definition.params;
  return (
    statHtml('Masa', `${p.mass} kg`) +
    statHtml('Vel. máx', `${Math.round(p.maxSpeed * 3.6)} km/h`) +
    statHtml('Inclinación', `${Math.round((p.leanLimitRad * 180) / Math.PI)}°`) +
    statHtml('Manillar', `${Math.round((p.steerMax * 180) / Math.PI)}°`)
  );
}

export function createVehicleSelector(options: VehicleSelectorOptions): VehicleSelector {
  const { panel, chip, canvas, onSelect } = options;
  const list = panel.querySelector<HTMLElement>('.vehiculo-lista');
  if (!list) throw new Error('selector de vehículo: falta .vehiculo-lista en el panel');

  const cards = new Map<string, HTMLButtonElement>();
  for (const grupo of CATEGORIAS) {
    const definitions = VEHICLE_CATALOG.filter((definition) => definition.category === grupo.category);
    if (definitions.length === 0) continue;
    const section = document.createElement('div');
    section.className = 'vehiculo-grupo';
    section.dataset.categoria = grupo.category;
    const title = document.createElement('h3');
    title.className = 'vehiculo-grupo-titulo';
    title.textContent = grupo.label;
    section.appendChild(title);
    for (const definition of definitions) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'vehiculo-tarjeta';
      card.dataset.preset = definition.id;
      card.dataset.categoria = definition.category;
      card.setAttribute('aria-current', 'false');
      card.innerHTML =
        `<span class="vehiculo-nombre">${definition.name}</span>` +
        `<span class="vehiculo-marca" hidden>Actual</span>` +
        `<span class="vehiculo-resumen">${definition.summary}</span>` +
        `<span class="vehiculo-stats">${statsFor(definition)}</span>`;
      card.addEventListener('click', () => onSelect(definition.id));
      section.appendChild(card);
      cards.set(definition.id, card);
    }
    list.appendChild(section);
  }

  function setCurrent(id: string): void {
    const active = VEHICLE_CATALOG.find((definition) => definition.id === id) ?? VEHICLE_CATALOG[0];
    if (!active) return;
    for (const [presetId, card] of cards) {
      const isActive = presetId === active.id;
      card.classList.toggle('activa', isActive);
      card.setAttribute('aria-current', isActive ? 'true' : 'false');
      const badge = card.querySelector<HTMLElement>('.vehiculo-marca');
      if (badge) badge.hidden = !isActive;
    }
    const grupo = CATEGORIAS.find((entry) => entry.category === active.category);
    chip.textContent = `${grupo ? grupo.chip : 'Vehículo'} · ${active.name}`;
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