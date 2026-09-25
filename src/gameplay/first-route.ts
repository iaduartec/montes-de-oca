// GENERADO POR scripts/gameplay/build_first_route.mjs — NO EDITAR A MANO.
// Se regenera con: node scripts/gameplay/build_first_route.mjs
// Verificado por: npm test (modo --check).
//
// Ruta: Repetidor sin señal
// 2361 m en planta · ROAD 661 m · TRACK 1700 m
// Desnivel: +184 m / -20 m · pendiente máx 21.8°
// Origen de la red: navigation.json sha256 a172885cfd7eed5f…
import type { FirstRoute } from './route-types';

export const FIRST_ROUTE: FirstRoute = {
  id: 'villafranca-pista-objetivo',
  name: 'Repetidor sin señal',
  generatedBy: 'scripts/gameplay/build_first_route.mjs',
  sourceSha256: 'a172885cfd7eed5f9ea41d5950cdca00c3cafa317785ead654e56532394b49f0',
  start: {
    x: 3087.53,
    z: 3935.05,
  },
  startYaw: -3.037375,
  waypoints: [
    {
      x: 3087.53,
      z: 3935.05,
      role: 'start',
      leg: 'ROAD',
      atM: 0,
    },
    {
      x: 3068.01,
      z: 3759.65,
      role: 'road',
      leg: 'ROAD',
      atM: 176,
    },
    {
      x: 3102.39,
      z: 3508.26,
      role: 'road',
      leg: 'ROAD',
      atM: 436,
    },
    {
      x: 3210.79,
      z: 3441.23,
      role: 'road',
      leg: 'ROAD',
      atM: 568,
    },
    {
      x: 3269.04,
      z: 3371.58,
      role: 'junction',
      leg: 'ROAD',
      atM: 661,
    },
    {
      x: 3440.85,
      z: 3142.69,
      role: 'track',
      leg: 'TRACK',
      atM: 947,
    },
    {
      x: 3519.67,
      z: 2932.75,
      role: 'track',
      leg: 'TRACK',
      atM: 1172,
    },
    {
      x: 3527.78,
      z: 2850.4,
      role: 'track',
      leg: 'TRACK',
      atM: 1257,
    },
    {
      x: 3601.66,
      z: 2753.86,
      role: 'track',
      leg: 'TRACK',
      atM: 1379,
    },
    {
      x: 3617.96,
      z: 2611.02,
      role: 'track',
      leg: 'TRACK',
      atM: 1523,
    },
    {
      x: 3660.54,
      z: 2509.47,
      role: 'track',
      leg: 'TRACK',
      atM: 1634,
    },
    {
      x: 3821.57,
      z: 2358.16,
      role: 'track',
      leg: 'TRACK',
      atM: 1856,
    },
    {
      x: 4033.15,
      z: 2286.87,
      role: 'track',
      leg: 'TRACK',
      atM: 2082,
    },
    {
      x: 4097.2,
      z: 2240.95,
      role: 'track',
      leg: 'TRACK',
      atM: 2161,
    },
    {
      x: 4178.26,
      z: 2060.45,
      role: 'target',
      leg: 'TRACK',
      atM: 2361,
    },
  ],
  trackEntry: {
    x: 3269.04,
    z: 3371.58,
  },
  target: {
    x: 4178.26,
    z: 2060.45,
  },
  targetYaw: -0.526965,
  targetClearRadiusM: 18,
  returnPoint: {
    x: 3087.53,
    z: 3935.05,
  },
  checkpoints: [
    {
      id: 'start',
      label: 'Villafranca Montes de Oca',
      x: 3087.53,
      z: 3935.05,
      atM: 0,
    },
    {
      id: 'junction',
      label: 'Dejar la carretera',
      x: 3269.04,
      z: 3371.58,
      atM: 661,
    },
    {
      id: 'track-entry',
      label: 'Entrada a la pista',
      x: 3269.04,
      z: 3371.58,
      atM: 661,
    },
    {
      id: 'target',
      label: 'Repetidor',
      x: 4178.26,
      z: 2060.45,
      atM: 2361,
    },
    {
      id: 'return',
      label: 'Regreso a Villafranca',
      x: 3087.53,
      z: 3935.05,
      atM: 2361,
    },
  ],
  profile: {
    lengthM: 2361,
    roadM: 661,
    trackM: 1700,
    pathM: 0,
    ascentM: 184,
    descentM: 20,
    slopeP50Deg: 8.1,
    slopeP95Deg: 18,
    slopeMaxDeg: 21.8,
    stepsOver20Deg: 2,
    worstRampDeg: 20.5,
  },
};
