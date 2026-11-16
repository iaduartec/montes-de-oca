/**
 * Configuración del terreno.
 *
 * REGLA DE ORO: acá NO vive ningún número de Villafranca. El origen, la proyección
 * y la escala entran por datos desde `public/terrain/config.json`. Si mañana se mueve
 * el centro del mapa, sólo cambia el JSON: ni una línea de este módulo se toca.
 */

/** Vector 2D en el plano horizontal del mundo (X = este, Z = norte). */
export type V2 = readonly [number, number];

/** Centro geográfico del mapa en WGS84. */
export interface GeographicOrigin {
  readonly lon: number;
  readonly lat: number;
}

/**
 * Factores heredados del config para compatibilidad con datos antiguos. Las
 * coordenadas geográficas se convierten usando `crs` y `bounds` más abajo.
 */
export interface ProjectionFactors {
  readonly metersPerDegreeLon: number;
  readonly metersPerDegreeLat: number;
}

/** Ventana UTM usada por carreteras, terreno y datos derivados del mapa. */
export interface ProjectedBounds {
  readonly e: readonly [number, number];
  readonly n: readonly [number, number];
}

/** Referencia a un tile de heightfield publicado en `public/`. */
export interface TerrainTileRef {
  readonly id: string;
  readonly url: string;
}

/** Contrato completo que el motor consume. Todo dato geográfico entra por acá. */
export interface TerrainConfig {
  readonly schemaVersion: 1;
  readonly origin: GeographicOrigin;
  readonly projection: ProjectionFactors;
  /** CRS proyectado compartido por todas las capas geográficas del mapa. */
  readonly crs: string;
  readonly bounds: ProjectedBounds;
  /** Unidades de mundo por metro. 1 = identidad (el mundo se mide en metros). */
  readonly worldScale: number;
  /**
   * Cota de referencia que se resta para que Y arranque cerca de 0
   * (`floor(min(elevación)/10)*10` del DEM). Los `heights` del grid siguen en
   * metros ABSOLUTOS; el datum se aplica al construir la malla y en `heightAt`.
   */
  readonly verticalDatum: number;
  /** Radio de vista en metros para el culling multi-tile (distancia + frustum). */
  readonly viewRadius: number;
  /** Punto de aparición en WGS84 (el pueblo), o `null` si el config no lo trae. */
  readonly spawn: GeographicOrigin | null;
  readonly tiles: readonly TerrainTileRef[];
  /** Optional local static orthophoto manifest; legacy configs omit it. */
  readonly orthophotoManifestUrl?: string;
}

/** Ruta pública del config. Es la ÚNICA URL fijada por código. */
export const TERRAIN_CONFIG_PATH = '/terrain/config.json';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseOrigin(raw: unknown): GeographicOrigin {
  if (!isRecord(raw) || !isFiniteNumber(raw.lon) || !isFiniteNumber(raw.lat)) {
    throw new Error('config: "origin" debe ser {lon, lat} numéricos');
  }
  return { lon: raw.lon, lat: raw.lat };
}

function parseProjection(raw: unknown): ProjectionFactors {
  if (
    !isRecord(raw) ||
    !isFiniteNumber(raw.metersPerDegreeLon) ||
    !isFiniteNumber(raw.metersPerDegreeLat)
  ) {
    throw new Error('config: "projection" debe ser {metersPerDegreeLon, metersPerDegreeLat} numéricos');
  }
  return {
    metersPerDegreeLon: raw.metersPerDegreeLon,
    metersPerDegreeLat: raw.metersPerDegreeLat,
  };
}

function parseProjectedBounds(raw: unknown): ProjectedBounds {
  if (!isRecord(raw) || !Array.isArray(raw.e) || !Array.isArray(raw.n) ||
      raw.e.length !== 2 || raw.n.length !== 2) {
    throw new Error('config: "bounds" debe incluir intervalos UTM e/n de dos números');
  }
  const [e0, e1] = raw.e;
  const [n0, n1] = raw.n;
  if (![e0, e1, n0, n1].every(isFiniteNumber)) {
    throw new Error('config: "bounds" debe incluir intervalos UTM e/n de dos números');
  }
  return { e: [e0, e1], n: [n0, n1] };
}

function parseTiles(raw: unknown): readonly TerrainTileRef[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('config: "tiles" debe ser una lista no vacía');
  }
  return raw.map((tile, index) => {
    if (!isRecord(tile) || typeof tile.id !== 'string' || typeof tile.url !== 'string') {
      throw new Error(`config: tile #${index} inválido, se esperaba {id, url} string`);
    }
    return { id: tile.id, url: tile.url };
  });
}

function parseOptionalOrigin(raw: unknown): GeographicOrigin | null {
  if (raw === undefined || raw === null) return null;
  return parseOrigin(raw);
}

/**
 * Valida y normaliza un objeto crudo. Pensado para datos de `fetch` (unknown).
 * Falla ruidosamente ante un config corrupto en lugar de arrancar a medias.
 */
export function parseTerrainConfig(raw: unknown): TerrainConfig {
  if (!isRecord(raw)) throw new Error('config: la raíz debe ser un objeto');
  if (raw.schemaVersion !== 1) throw new Error('config: schemaVersion no soportada (se espera 1)');
  if (!isFiniteNumber(raw.worldScale) || raw.worldScale <= 0) {
    throw new Error('config: "worldScale" debe ser un número > 0');
  }
  const verticalDatum = raw.verticalDatum === undefined ? 0 : raw.verticalDatum;
  if (!isFiniteNumber(verticalDatum)) {
    throw new Error('config: "verticalDatum" debe ser numérico si está presente');
  }
  const viewRadius = raw.viewRadius === undefined ? 900 : raw.viewRadius;
  if (!isFiniteNumber(viewRadius) || viewRadius <= 0) {
    throw new Error('config: "viewRadius" debe ser un número > 0 si está presente');
  }
  if (raw.crs !== 'EPSG:25830') {
    throw new Error('config: "crs" debe ser EPSG:25830 (UTM 30N)');
  }
  if (raw.orthophotoManifestUrl !== undefined &&
      (typeof raw.orthophotoManifestUrl !== 'string' || !raw.orthophotoManifestUrl.trim() ||
       !raw.orthophotoManifestUrl.trim().startsWith('/') || raw.orthophotoManifestUrl.trim().startsWith('//'))) {
    throw new Error('config: "orthophotoManifestUrl" debe ser una ruta local absoluta si está presente');
  }
  const bounds = parseProjectedBounds(raw.bounds);
  if (bounds.e[1] <= bounds.e[0] || bounds.n[1] <= bounds.n[0]) {
    throw new Error('config: los límites UTM deben estar en orden creciente');
  }
  return {
    schemaVersion: 1,
    origin: parseOrigin(raw.origin),
    projection: parseProjection(raw.projection),
    crs: raw.crs,
    bounds,
    worldScale: raw.worldScale,
    verticalDatum,
    viewRadius,
    spawn: parseOptionalOrigin(raw.spawn),
    tiles: parseTiles(raw.tiles),
    ...(typeof raw.orthophotoManifestUrl === 'string' && raw.orthophotoManifestUrl.trim()
      ? { orthophotoManifestUrl: raw.orthophotoManifestUrl.trim() }
      : {}),
  };
}

/** Descarga y valida `public/terrain/config.json`. */
export async function loadTerrainConfig(
  fetchImpl: typeof fetch = fetch,
  url: string = TERRAIN_CONFIG_PATH,
): Promise<TerrainConfig> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`config: no se pudo cargar ${url} (HTTP ${response.status})`);
  }
  return parseTerrainConfig((await response.json()) as unknown);
}

/**
 * Proyecta una coordenada WGS84 a unidades de mundo (X este, Z norte).
 * ÉSTA es la ÚNICA ocurrencia del origen geográfico en todo `src/`: cualquier
 * cambio de centro o de escala del mapa se resuelve desde el config.
 */
export function wgs84ToWorld(config: TerrainConfig, lon: number, lat: number): V2 {
  if (config.crs !== 'EPSG:25830') {
    throw new Error(`config: proyección WGS84 no soportada para ${config.crs}`);
  }
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -80 || lat > 84) {
    throw new Error('config: coordenada WGS84 inválida para UTM');
  }

  // WGS84 -> UTM 30N (EPSG:25830). Carreteras y DEM ya usan esta rejilla;
  // una equirectangular local desplazaba edificios y vegetación ~20 m.
  const a = 6378137;
  const e2 = 0.0066943799901413165;
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const phi = lat * Math.PI / 180;
  const lambda = lon * Math.PI / 180;
  const lambda0 = -3 * Math.PI / 180;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const tanPhi = Math.tan(phi);
  const n = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
  const t = tanPhi * tanPhi;
  const c = ep2 * cosPhi * cosPhi;
  const aa = cosPhi * (lambda - lambda0);
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const m = a * (
    (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
    - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi)
    - (35 * e6 / 3072) * Math.sin(6 * phi)
  );
  const easting = 500000 + k0 * n * (
    aa + (1 - t + c) * aa ** 3 / 6
      + (5 - 18 * t + t * t + 72 * c - 58 * ep2) * aa ** 5 / 120
  );
  const northing = k0 * (m + n * tanPhi * (
    aa * aa / 2 + (5 - t + 9 * c + 4 * c * c) * aa ** 4 / 24
      + (61 - 58 * t + t * t + 600 * c - 330 * ep2) * aa ** 6 / 720
  ));
  return [
    (easting - config.bounds.e[0]) * config.worldScale,
    (northing - config.bounds.n[0]) * config.worldScale,
  ];
}
