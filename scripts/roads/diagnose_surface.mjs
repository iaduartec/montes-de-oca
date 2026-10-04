import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const generated = [];
async function moduleFrom(path, source = readFileSync(path, 'utf8')) {
  const dest = path.replace('.ts', '.diagnostic.mjs');
  let code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/(['"])(@babylonjs\/core\/[^'"]+)\1/g, '$1$2.js$1');
  writeFileSync(dest, code);
  generated.push(dest);
  code = code.replace(/(['"])(\.\.?\/[^'"]+)\1/g, (match, quote, rel) => quote + rel + '.diagnostic.mjs' + quote);
  writeFileSync(dest, code);
  return import(pathToFileURL(`${process.cwd()}/${dest}`).href);
}

const metricBins = {
  longitudinalSlope: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1],
  crossSlope: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1],
  sourceBranchCrossSlope: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1],
  ownFacetBank: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1],
  centerlineFiniteSlope: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1],
  crossSectionSlope: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1],
  heightDeltaPerMeter: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1],
  networkHeightDeltaPerMeter: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1],
  slopeDerivative: [0.025, 0.05, 0.1, 0.2, 0.4, 0.8],
  normalDeltaPerMeter: [0.025, 0.05, 0.1, 0.2, 0.4, 0.8],
  triangleGrade: [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2],
  triangleSlopeDeg: [5, 10, 15, 20, 30, 45, 60, 75, 80, 85, 89, 90],
};

function pointAt(points, distance) {
  let remaining = Math.max(0, distance);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 1e-9) continue;
    if (remaining <= length || i === points.length - 1) {
      const t = Math.max(0, Math.min(1, remaining / length));
      return { x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t };
    }
    remaining -= length;
  }
  const last = points.at(-1);
  return { x: last[0], z: last[1] };
}

function summarize(rows, key) {
  const sorted = rows.map(row => row[key]).filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  const percentile = p => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] : null;
  const bounds = metricBins[key];
  const histogram = Object.fromEntries([...bounds.map((limit, i) => [i === 0 ? `<=${limit}` : `>${bounds[i - 1]}..<=${limit}`, 0]), [`>${bounds.at(-1)}`, 0]]);
  for (const value of sorted) {
    const index = bounds.findIndex(limit => value <= limit);
    const label = index < 0 ? `>${bounds.at(-1)}` : index === 0 ? `<=${bounds[0]}` : `>${bounds[index - 1]}..<=${bounds[index]}`;
    histogram[label]++;
  }
  return {
    unit: key === 'normalDeltaPerMeter' ? 'rad/m' : key === 'slopeDerivative' ? 'slope-ratio/m' : key === 'heightDeltaPerMeter' || key === 'networkHeightDeltaPerMeter' ? 'm/m' : 'slope-ratio',
    p50: percentile(0.5), p90: percentile(0.9), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1) ?? null,
    histogram,
    top10: rows.filter(row => Number.isFinite(row[key])).slice().sort((a, b) => Math.abs(b[key]) - Math.abs(a[key])).slice(0, 10),
  };
}

try {
  const { createHeightfield } = await moduleFrom('src/heightfield.ts');
  const cfg = JSON.parse(readFileSync('public/terrain/config.json', 'utf8'));
  const samplers = cfg.tiles.map(tile => createHeightfield(JSON.parse(readFileSync(`public${tile.url}`, 'utf8')).grid, cfg.worldScale));
  const terrain = {
    heightAt(x, z) {
      x = Math.max(0, Math.min(6000, x));
      z = Math.max(0, Math.min(6000, z));
      const sampler = samplers.find(item => x >= item.grid.x0 && z >= item.grid.z0 && x <= item.grid.x0 + 1000 && z <= item.grid.z0 + 1000);
      if (!sampler) throw new Error(`No hay tile DEM para (${x.toFixed(2)}, ${z.toFixed(2)})`);
      return sampler.heightAt(x, z) - cfg.verticalDatum;
    },
    normalAt(x, z, out) {
      const e = 0.1;
      const { Vector3 } = globalThis;
      return (out ?? new Vector3()).set(
        -(this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e), 1,
        -(this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e),
      ).normalize();
    },
  };
  globalThis.Vector3 = (await import('@babylonjs/core/Maths/math.vector.js')).Vector3;
  const roads = JSON.parse(readFileSync('public/roads/roads.json', 'utf8')).roads;
  const after = process.argv.includes('--after');
  const baseline = process.argv.includes('--baseline') || process.argv.includes('--before');
  const driving = process.argv.includes('--driving');
  let sampler = null;
  let diagnosticBands = null;
  if (after || baseline) {
    await moduleFrom('src/world/road-surface.ts');
    await moduleFrom('src/road-visuals.ts');
    if (!baseline) await moduleFrom('src/road-profile.ts');
    let source = readFileSync('src/road-draping.ts', 'utf8');
    if (baseline) source = execFileSync('git', ['show', 'caef87e:src/road-draping.ts'], { encoding: 'utf8' });
    if (!driving) {
      const needle = 'stations: buffers[cls].stations })))';
      if (!source.includes(needle)) throw new Error('No se encontró la llamada a createRenderedRoadSurface para activar geometryOnly');
      source = source.replace(needle, 'stations: buffers[cls].stations })), { geometryOnly: true })');
    }
    source = source.replace('  return {\n    meshes,\n    surface:', '  return {\n    meshes,\n    diagnosticBands: CLASSES.map((cls) => ({ class: cls, ...typed[cls] })),\n    surface:');
    const { loadRoadNetwork } = await moduleFrom('src/road-draping.ts', source);
    const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');
    const { Scene } = await import('@babylonjs/core/scene.js');
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const network = await loadRoadNetwork(scene, terrain, { fetchImpl: async () => ({ ok: true, json: async () => ({ roads }) }) });
    sampler = network.surface;
    diagnosticBands = network.diagnosticBands ?? null;
  }

  const mode = !after && !baseline ? 'RAW TERRAIN' : driving ? `DRIVING SURFACE ${after ? 'AFTER' : 'caef87e BEFORE'}` : `RENDERED ROAD GEOMETRY ${after ? 'AFTER' : 'caef87e BEFORE'}`;
  const values = { ROAD: [], TRACK: [], PATH: [] };
  const heightAt = (x, z) => sampler ? sampler.heightAt(x, z) : terrain.heightAt(x, z);
  const normalAt = (x, z) => (sampler ?? terrain).normalAt(x, z);

  // Sample once per chainage metre. Segment endpoints are excluded except for
  // the route's final endpoint, so OSM vertices never get counted twice.
  for (const road of roads) {
    const cumulative = [0];
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1], b = road.points[i];
      cumulative.push(cumulative.at(-1) + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const total = cumulative.at(-1);
    if (!(total > 0)) continue;
    const intervalCount = Math.max(1, Math.ceil(total));
    const chainages = Array.from({ length: intervalCount + 1 }, (_, i) => total * i / intervalCount);
    let previous = null;
    for (const chainage of chainages) {
      const point = pointAt(road.points, chainage);
      const beforeChainage = Math.max(0, chainage - 0.5);
      const aheadChainage = Math.min(total, chainage + 0.5);
      const before = pointAt(road.points, beforeChainage);
      const ahead = pointAt(road.points, aheadChainage);
      let dx = ahead.x - before.x, dz = ahead.z - before.z;
      const tangentLength = Math.hypot(dx, dz) || 1;
      dx /= tangentLength; dz /= tangentLength;
      const nx = -dz, nz = dx;
      const contact = sampler?.sampleAt(point.x, point.z) ?? null;
      const centerY = contact?.height ?? heightAt(point.x, point.z);
      const centerlineFiniteSlope = (heightAt(ahead.x, ahead.z) - heightAt(before.x, before.z)) / Math.max(1e-6, aheadChainage - beforeChainage);
      const sourceBranchSlope = contact?.normal ? {
        longitudinalSlope: -(contact.normal.x * dx + contact.normal.z * dz) / (Math.abs(contact.normal.y) < 1e-9 ? 1e-9 : contact.normal.y),
        crossSlope: (contact.normal.x * dz - contact.normal.z * dx) / (Math.abs(contact.normal.y) < 1e-9 ? 1e-9 : contact.normal.y),
      } : null;
      const longitudinalSlope = sourceBranchSlope?.longitudinalSlope ?? centerlineFiniteSlope;
      const lateral = road.width * 0.4;
      const sampleLateral = (sign) => {
        const x = point.x + nx * lateral * sign, z = point.z + nz * lateral * sign;
        const sideContact = sampler?.sampleAt(x, z) ?? null;
        return {
          x, z,
          height: sideContact?.height ?? terrain.heightAt(x, z),
          missing: Boolean(sampler && !sideContact),
          skirt: sideContact?.skirt ?? false,
          class: sideContact?.class ?? null,
        };
      };
      const left = sampleLateral(1), right = sampleLateral(-1);
      const crossSectionSlope = (left.height - right.height) / (2 * lateral);
      const sourceBranchCrossSlope = sourceBranchSlope?.crossSlope ?? crossSectionSlope;
      const crossSlope = sourceBranchCrossSlope;
      // The caef87e buffers have no per-vertex tangent stream. There the
      // source polyline tangent at this chainage is the independent ownership
      // fallback; AFTER uses the rendered triangle's interpolated tangent.
      const ownFacetBank = !contact ? null : baseline ? sourceBranchCrossSlope : contact.crossSlope;
      const normal = contact?.normal ?? normalAt(point.x, point.z);
      const normalDeltaPerMeter = previous
        ? Math.acos(Math.max(-1, Math.min(1, normal.x * previous.normal.x + normal.y * previous.normal.y + normal.z * previous.normal.z))) / Math.max(1e-6, chainage - previous.chainage)
        : 0;
      const sample = {
        id: road.id, class: road.class, chainageM: chainage, contactClass: contact?.class ?? null,
        contactRoadId: contact?.roadId ?? null,
        previousContactRoadId: previous?.contactRoadId ?? null,
        ownerTransition: Boolean(previous?.contactRoadId && contact?.roadId && previous.contactRoadId !== contact.roadId),
        contactSkirt: contact?.skirt ?? false, contactBridge: contact?.bridge ?? false,
        centerlineMissing: Boolean(sampler && !contact), slopeSource: sourceBranchSlope ? 'sampled-triangle-normal-dot-source-tangent' : 'centerline-finite-fallback',
        normalY: contact?.normal?.y ?? normal.y, nearVerticalContact: Boolean(contact && Math.abs(contact.normal.y) < 0.15),
        ownFacetTangentSource: !contact ? null : baseline ? 'source-polyline-tangent-fallback' : 'rendered-triangle-tangent',
        lateralMissing: left.missing || right.missing,
        lateralLeft: { skirt: left.skirt, class: left.class }, lateralRight: { skirt: right.skirt, class: right.class },
        lateralSkirt: left.skirt || right.skirt,
        lateralClassMismatch: (left.class !== null && left.class !== road.class) || (right.class !== null && right.class !== road.class),
        x: point.x, z: point.z, tangentX: dx, tangentZ: dz, height: centerY,
        longitudinalSlope, crossSlope, sourceBranchCrossSlope, ownFacetBank, centerlineFiniteSlope, crossSectionSlope,
        heightDeltaPerMeter: previous ? Math.abs(centerY - previous.height) / (chainage - previous.chainage) : 0,
        // This is the delta along the highest sampled network surface. It may
        // cross source-road ownership at junctions; ownerTransition marks that.
        networkHeightDeltaPerMeter: previous ? Math.abs(centerY - previous.height) / (chainage - previous.chainage) : 0,
        slopeDerivative: previous ? Math.abs(longitudinalSlope - previous.longitudinalSlope) / (chainage - previous.chainage) : 0,
        normalDeltaPerMeter,
      };
      values[road.class].push(sample);
      previous = { chainage, height: centerY, longitudinalSlope, normal, contactRoadId: contact?.roadId ?? null };
    }
  }

  const report = { mode, sampling: { targetSpacingM: 1, duplicatePolylineVertices: false, metricsUseRoadCenterlineTangent: true }, ownerMetadata: diagnosticBands?.some(band => (band.owners || band.roadOrdinal) && band.roadIds) ? 'available' : 'unknown (buffer has no owner stream)', classes: {} };
  for (const [className, rows] of Object.entries(values)) {
    const metrics = {};
    for (const key of Object.keys(metricBins).filter(key => !key.startsWith('triangle'))) metrics[key] = summarize(rows.filter(row => !row.contactSkirt), key);
    const skirtRows = rows.filter(row => row.contactSkirt);
    const mismatchRows = rows.filter(row => row.contactClass && row.contactClass !== className);
    report.classes[className] = {
      count: rows.length,
      surfaceSamples: {
        pavementOrUnmatched: rows.length - skirtRows.length,
        skirtContact: skirtRows.length,
        differentClassContact: mismatchRows.length,
        ownerTransitions: rows.filter(row => row.ownerTransition).length,
        unknownOwnerSamples: rows.filter(row => row.contactRoadId === null).length,
        centerlineMissing: rows.filter(row => row.centerlineMissing).length,
        lateral: {
          missingEitherSide: rows.filter(row => row.lateralMissing).length,
          skirtEitherSide: rows.filter(row => row.lateralSkirt).length,
          differentClassEitherSide: rows.filter(row => row.lateralClassMismatch).length,
        },
        skirtMetrics: Object.fromEntries(Object.keys(metricBins).filter(key => !key.startsWith('triangle')).map(key => [key, summarize(skirtRows, key)])),
        differentClassTop10: mismatchRows.slice().sort((a, b) => Math.max(Math.abs(b.longitudinalSlope), Math.abs(b.crossSlope)) - Math.max(Math.abs(a.longitudinalSlope), Math.abs(a.crossSlope))).slice(0, 10),
        ownerTransitionTop10: rows.filter(row => row.ownerTransition).slice().sort((a, b) => b.networkHeightDeltaPerMeter - a.networkHeightDeltaPerMeter).slice(0, 10),
      },
      metrics,
    };
  }
  if (diagnosticBands) {
    const roleNames = { 0: 'PAVEMENT', 1: 'SKIRT', 2: 'BRIDGE', 3: 'SIGN', 4: 'PAINT', 5: 'TERMINAL_EARTHWORK' };
    report.triangles = {};
    for (const band of diagnosticBands) {
      const grouped = Object.fromEntries(Object.values(roleNames).map(name => [name, []]));
      const { positions, indices, roles } = band;
      for (let i = 0; i < indices.length; i += 3) {
        const ia = indices[i], ib = indices[i + 1], ic = indices[i + 2];
        const role = Math.max(roles[ia], roles[ib], roles[ic]);
        const a = ia * 3, b = ib * 3, c = ic * 3;
        const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2];
        const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
        const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
        const horizontalNormal = Math.hypot(nx, nz);
        const slope = horizontalNormal / Math.max(1e-12, Math.abs(ny));
        const angle = Math.atan2(horizontalNormal, Math.abs(ny)) * 180 / Math.PI;
        const bucket = grouped[roleNames[role] ?? 'PAVEMENT_ROLE_INCLUDES_PAINT'];
        bucket.push({ triangle: i / 3, slope, center: [
          (positions[a] + positions[b] + positions[c]) / 3,
          (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3,
        ], triangleSlopeDeg: angle });
      }
      report.triangles[band.class] = Object.fromEntries(Object.entries(grouped).map(([role, rows]) => [role, {
        count: rows.length,
        nearVerticalCount: rows.filter(row => row.triangleSlopeDeg >= 80).length,
        gradeRatio: summarize(rows.map(row => ({ ...row, triangleGrade: row.slope })), 'triangleGrade'),
        slopeAngle: summarize(rows, 'triangleSlopeDeg'),
      }]));
    }
  } else if (sampler) {
    report.triangles = { unavailable: 'The diagnostic source did not expose typed road buffers.' };
  }
  const out = process.env.ROAD_DIAGNOSTIC_OUT ?? 'outputs/road-v3-20261001';
  mkdirSync(out, { recursive: true });
  const filename = !after && !baseline ? 'raw.json' : `${driving ? 'driving' : 'rendered'}-${after ? 'after' : 'before'}.json`;
  writeFileSync(`${out}/${filename}`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ mode, classes: Object.fromEntries(Object.entries(report.classes).map(([key, value]) => [key, Object.fromEntries(Object.entries(value.metrics).map(([metric, summary]) => [metric, { p90: summary.p90, p95: summary.p95, p99: summary.p99, max: summary.max }]))])) }, null, 2));
} finally {
  for (const path of generated) rmSync(path, { force: true });
}
