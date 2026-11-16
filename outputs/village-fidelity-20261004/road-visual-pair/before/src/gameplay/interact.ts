/**
 * Interacción con objetos del mundo. PURO, sin Babylon: se testea en Node.
 *
 * Por qué separado de la misión: "¿puedo interactuar con esto?" es una pregunta
 * de DISTANCIA EN PLANTA, no de estado narrativo. Aislada así se puede reusar
 * para cualquier objeto (hoy el repetidor, mañana un vehículo o un cartel) y
 * testear sin motor.
 *
 * La distancia se mide en XZ (el mundo es Y-up y la cota sale del terreno): para
 * "alcanzar" algo la altura no cambia la decisión. Usar `hypot` y no `x²+z²`
 * mantiene el número en METROS, que es lo que consume el HUD.
 */

/** Algo con lo que el jugador puede interactuar, ubicado en el plano XZ. */
export interface Interactable {
  readonly id: string;
  readonly label: string;
  readonly x: number;
  readonly z: number;
  /** Alcance propio, en metros (cada objeto puede tener el suyo). */
  readonly radiusM: number;
}

export interface InteractionQuery {
  /** El interactuable alcanzable más cercano, o null. */
  readonly available: Interactable | null;
  /** Distancia al interactuable más cercano (Infinity si no hay ninguno). */
  readonly distanceM: number;
}

export interface Interactor {
  readonly targets: readonly Interactable[];
  query(x: number, z: number): InteractionQuery;
}

export function createInteractor(targets: readonly Interactable[]): Interactor {
  // Copia defensiva: si el llamador muta su lista, la instancia no cambia de
  // comportamiento a mitad de partida.
  const list: readonly Interactable[] = [...targets];

  return {
    targets: list,
    query(x: number, z: number): InteractionQuery {
      let nearest: Interactable | null = null;
      let nearestDistance = Infinity;
      for (const target of list) {
        const distance = Math.hypot(target.x - x, target.z - z);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = target;
        }
      }
      // `available` sólo si el más cercano cae dentro de SU radio. Aun si no es
      // alcanzable, `distanceM` devuelve la distancia al más cercano: el HUD la
      // usa para decir "te faltan X m".
      const available = nearest !== null && nearestDistance <= nearest.radiusM ? nearest : null;
      return { available, distanceM: nearestDistance };
    },
  };
}
