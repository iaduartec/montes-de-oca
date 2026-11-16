import { MISSION_NAME, type MissionSnapshot, type MissionState } from '../gameplay/mission';

const ETIQUETA_ESTADO: Record<MissionState, string> = {
  NOT_STARTED: 'SIN EMPEZAR',
  ACTIVE: 'EN MARCHA',
  TARGET_REACHED: 'EN EL REPETIDOR',
  REPAIRED: 'ENLACE RESTABLECIDO',
  RETURNING: 'REGRESANDO',
  COMPLETED: 'COMPLETADA',
};

function formatMinutos(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function createMissionHud(misionEl: HTMLElement | null): (snap: MissionSnapshot) => void {
  if (misionEl) {
    misionEl.innerHTML =
      '<div class="mision-titulo"></div><div class="mision-estado"></div>' +
      '<div class="mision-pista"></div><div class="mision-progreso" hidden><i></i></div>';
  }
  const misionTitulo = misionEl?.querySelector<HTMLElement>('.mision-titulo') ?? null;
  const misionEstado = misionEl?.querySelector<HTMLElement>('.mision-estado') ?? null;
  const misionPista = misionEl?.querySelector<HTMLElement>('.mision-pista') ?? null;
  const misionProgreso = misionEl?.querySelector<HTMLElement>('.mision-progreso') ?? null;
  const misionBarra = misionEl?.querySelector<HTMLElement>('.mision-progreso > i') ?? null;

  return (snap: MissionSnapshot): void => {
    if (!misionEl || !misionTitulo || !misionEstado || !misionPista) return;
    misionEl.hidden = false;
    misionEl.classList.toggle('mision-completada', snap.completed);
    misionTitulo.textContent = MISSION_NAME;

    // La distancia que importa es siempre la del PRÓXIMO paso, no una fija.
    const volviendo = snap.state === 'REPAIRED' || snap.state === 'RETURNING' || snap.completed;
    const metros = volviendo ? snap.distanceToReturnM : snap.distanceToTargetM;
    misionEstado.textContent = `${ETIQUETA_ESTADO[snap.state]} · ${metros.toFixed(0)} m`;
    misionPista.textContent = snap.completed ? `Completada en ${formatMinutos(snap.elapsedS)}` : snap.hint;

    if (misionProgreso && misionBarra) {
      const reparando = snap.repairProgress > 0 && snap.repairProgress < 1;
      misionProgreso.hidden = !reparando;
      misionBarra.style.width = `${Math.round(snap.repairProgress * 100)}%`;
    }
  };

}
