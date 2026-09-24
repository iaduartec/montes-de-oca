/**
 * Configuración del terreno.
 *
 * REGLA DE ORO: acá NO vive ningún número de Villafranca. El origen, la proyección
 * y la escala entran por datos desde `public/terrain/config.json`. Si mañana se mueve
 * el centro del mapa, sólo cambia el JSON: ni una línea de este módulo se toca.
 */

/** Vector 2D en el plano horizontal del mundo (X = este, Z = norte). */
export type V2 = readonly [number, number];

/** Centro geográfico del mapa en WGS84. Placeholder hasta la FASE 2. */
export interface GeographicOrigin {
  readonly lon: number;
  readonly lat: number;
}

/**
 * Factores de conversión grados→metros para la proyección equirectangular local.
 * NO son universales: dependen de la latitud. A 42,4° (Villafranca) la conversión
 * de longitud es ~82.240 m/° y la de latitud ~111.320 m/°, valores que fija la
 * FASE 2 / pipeline DEM EPSG:25830. Acá quedan como placeholders.
 */
export interface ProjectionFactors {
  readonly metersPerDegreeLon: number;
  readonly metersPerDegreeLat: number;
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
}

/** Ruta pública del config. Es la ÚNICA URL fijada por código. */
const CONFIG_URL = '/terrain/config.json';

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
  return {
    schemaVersion: 1,
    origin: parseOrigin(raw.origin),
    projection: parseProjection(raw.projection),
    worldScale: raw.worldScale,
    verticalDatum,
    viewRadius,
    spawn: parseOptionalOrigin(raw.spawn),
    tiles: parseTiles(raw.tiles),
  };
}

/** Descarga y valida `public/terrain/config.json`. */
export async function loadTerrainConfig(fetchImpl: typeof fetch = fetch): Promise<TerrainConfig> {
  const response = await fetchImpl(CONFIG_URL);
  if (!response.ok) {
    throw new Error(`config: no se pudo cargar ${CONFIG_URL} (HTTP ${response.status})`);
  }
  return parseTerrainConfig((await response.json()) as unknown);
}

/**
 * Proyecta una coordenada WGS84 a unidades de mundo (X este, Z norte).
 * ÉSTA es la ÚNICA ocurrencia del origen geográfico en todo `src/`: cualquier
 * cambio de centro o de escala del mapa se resuelve desde el config.
 */
export function wgs84ToWorld(config: TerrainConfig, lon: number, lat: number): V2 {
  const { origin, projection, worldScale } = config;
  return [
    (lon - origin.lon) * projection.metersPerDegreeLon * worldScale,
    (lat - origin.lat) * projection.metersPerDegreeLat * worldScale,
  ];
}
