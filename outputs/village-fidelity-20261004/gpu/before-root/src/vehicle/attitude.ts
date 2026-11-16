/**
 * Actitud del vehículo a partir de los CUATRO puntos de apoyo.
 *
 * Por qué 4 y no 2: el modelo de referencia calculaba el cabeceo con dos puntos
 * (delante/detrás) y el alabeo con `-steer·speed·0.0025`, que es puramente
 * cosmético y no sigue la pendiente lateral (`city-world.ts:513`, audit §5).
 * Acá el coche se APOYA en el terreno: se muestrean las cuatro ruedas y de ahí
 * salen cabeceo y alabeo reales.
 *
 * Convención de signos (coincide con la referencia para el cabeceo):
 *   rotation.x = -atan2(frente - atrás, batalla)   → nariz arriba ⇒ x negativo
 *   rotation.z = -atan2(izquierda - derecha, vía)  → sube la derecha ⇒ z positivo
 */

/** Superficie de contacto: altura en Y de MUNDO (datum ya restado). */
export interface ContactSurface {
  heightAt(x: number, z: number): number;
}

/** Separación de las ruedas respecto del centro del vehículo (m). */
export interface WheelLayout {
  /** Distancia del eje delantero al centro. */
  readonly front: number;
  /** Distancia del eje trasero al centro. */
  readonly rear: number;
  /** Media vía (mitad de la distancia entre ruedas izquierda y derecha). */
  readonly halfTrack: number;
}

export interface AttitudeResult {
  /** Altura en Y de mundo del centro de apoyo (promedio de las 4 ruedas). */
  readonly centerY: number;
  /** Cabeceo a aplicar en `rotation.x`. */
  readonly pitch: number;
  /** Alabeo a aplicar en `rotation.z`. */
  readonly roll: number;
  /** Alturas de mundo en las 4 ruedas, en orden [FL, FR, RL, RR]. */
  readonly contacts: readonly [number, number, number, number];
  /** Desvío firmado de cada rueda respecto al plano ajustado del chasis. */
  readonly residuals: readonly [number, number, number, number];
  /**
   * Máximo desvío (m) entre la altura real de una rueda y el plano de apoyo que
   * definen las cuatro. Es la medida de "no flota / no atraviesa": si una rueda
   * se despega o el terreno no es plano, aparece acá.
   */
  readonly maxResidual: number;
}

/** Posiciones locales (X derecha, Z adelante) de las cuatro ruedas. */
function wheelLocals(layout: WheelLayout): readonly (readonly [number, number])[] {
  return [
    [-layout.halfTrack, layout.front], // FL
    [layout.halfTrack, layout.front], // FR
    [-layout.halfTrack, -layout.rear], // RL
    [layout.halfTrack, -layout.rear], // RR
  ];
}

/**
 * Muestrea el terreno en las cuatro ruedas y devuelve el plano de apoyo.
 * `x`/`z`/`yaw` son del centro del vehículo (no del morro).
 */
export function sampleAttitude(
  surface: ContactSurface,
  x: number,
  z: number,
  yaw: number,
  layout: WheelLayout,
): AttitudeResult {
  const fx = Math.sin(yaw);
  const fz = Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const locals = wheelLocals(layout);

  const c0 = surface.heightAt(x + locals[0]![0] * rx + locals[0]![1] * fx, z + locals[0]![0] * rz + locals[0]![1] * fz);
  const c1 = surface.heightAt(x + locals[1]![0] * rx + locals[1]![1] * fx, z + locals[1]![0] * rz + locals[1]![1] * fz);
  const c2 = surface.heightAt(x + locals[2]![0] * rx + locals[2]![1] * fx, z + locals[2]![0] * rz + locals[2]![1] * fz);
  const c3 = surface.heightAt(x + locals[3]![0] * rx + locals[3]![1] * fx, z + locals[3]![0] * rz + locals[3]![1] * fz);

  const frontAvg = (c0 + c1) / 2;
  const rearAvg = (c2 + c3) / 2;
  const leftAvg = (c0 + c2) / 2;
  const rightAvg = (c1 + c3) / 2;

  const wheelBase = layout.front + layout.rear;
  const track = 2 * layout.halfTrack;
  const pitch = -Math.atan2(frontAvg - rearAvg, wheelBase);
  const roll = -Math.atan2(leftAvg - rightAvg, track);
  const centerY = (c0 + c1 + c2 + c3) / 4;

  // Plano lineal ajustado: h ≈ centerY + gz·localZ + gx·localX.
  const gz = (frontAvg - rearAvg) / wheelBase;
  const gx = (rightAvg - leftAvg) / track;
  let maxResidual = 0;
  const contacts: [number, number, number, number] = [c0, c1, c2, c3];
  const residuals: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const [localX, localZ] = locals[i]!;
    const expected = centerY + gz * localZ + gx * localX;
    const residual = contacts[i]! - expected;
    residuals[i] = residual;
    if (Math.abs(residual) > maxResidual) maxResidual = Math.abs(residual);
  }

  return { centerY, pitch, roll, contacts, residuals, maxResidual };
}
