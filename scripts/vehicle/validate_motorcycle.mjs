import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
assert.ok(existsSync('src/vehicle/motorcycle-physics.ts'), 'missing motorcycle physics module');
const bundle = await build({ stdin: { contents: `export * from './src/vehicle/motorcycle-physics'; export * from './src/vehicle/index'; export * from './src/vehicle/catalog';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const { NullEngine } = await import('@babylonjs/core/Engines/nullEngine.js');
const { Scene } = await import('@babylonjs/core/scene.js');
const flat = { heightAt: () => 0, normalAt: () => ({ x: 0, y: 1, z: 0 }) };
const input = { throttle: 1, steer: 0, handbrake: false, neutral: false };
const engine = new NullEngine(); const scene = new Scene(engine);
const legacy = api.createVehicle({ scene, terrain: flat, spawn: { x: 0, z: 0 } });
assert.equal(legacy.category, 'todoterreno');
assert.equal(legacy.root.getChildMeshes().find(m => m.name === 'vehicle:body-estandar')?.isEnabled(), true);
legacy.dispose();
for (const definition of api.VEHICLE_CATALOG.filter(d => d.category === 'moto')) {
  const p = definition.params;
  const s = api.createMotorcycleState(0, 0);
  for (let i = 0; i < 120; i++) api.stepMotorcycle(s, input, 1 / 60, p, flat);
  assert.ok(s.speed > 0, `${definition.id} throttle`);
  for (let i = 0; i < 60; i++) api.stepMotorcycle(s, { ...input, throttle: 0, steer: 0.12 }, 1 / 60, p, flat);
  assert.equal(s.fallen, false, 'stable turn');
  assert.equal(Math.sign(s.leanRad), Math.sign(s.yawRate), 'lean follows turn');
  s.leanRad = p.fallAngleRad + 0.1;
  api.stepMotorcycle(s, input, 1 / 60, p, flat);
  assert.equal(s.fallen, true);
  const location = [s.x, s.z];
  api.stepMotorcycle(s, input, 0.1, p, flat);
  assert.deepEqual([s.x, s.z], location, 'fallen throttle cannot move');
  const invalid = { ...flat, heightAt: () => NaN };
  assert.equal(api.recoverMotorcycle(s, p, invalid), false);
  const steep = { heightAt: (x) => x * 3, normalAt: () => ({ x: -3 / Math.sqrt(10), y: 1 / Math.sqrt(10), z: 0 }) };
  assert.equal(api.recoverMotorcycle(s, p, steep), false);
  assert.equal(api.recoverMotorcycle(s, p, flat), true);
  assert.deepEqual([s.x, s.z], location);
  assert.equal(s.fallen, false);
  const unstable = api.createMotorcycleState(0, 0);
  unstable.speed = p.maxSpeed;
  for (let i = 0; i < 120; i++) api.stepMotorcycle(unstable, { ...input, steer: 1 }, 1 / 60, p, flat);
  assert.equal(unstable.fallen, true, 'excess turn demand causes fall');
  const slope = { heightAt: (_x, z) => z * 0.2, normalAt: () => ({ x: 0, y: 1 / Math.hypot(1, 0.2), z: -0.2 / Math.hypot(1, 0.2) }) };
  const downhill = api.createMotorcycleState(0, 0);
  api.stepMotorcycle(downhill, { ...input, throttle: 0, neutral: true }, 0.1, p, slope);
  assert.ok(downhill.speed < 0, 'gravity on slope');
  const before = [scene.meshes.length, scene.materials.length, scene.transformNodes.length];
  const actor = api.createVehicle({ scene, terrain: slope, spawn: { x: 0, z: 0 } }, definition);
  assert.equal(actor.category, 'moto');
  assert.equal(actor.telemetry().contacts.length, 2);
  assert.equal(actor.contactPoints(actor.state).length, 2);
  assert.ok(actor.riderSeat && actor.cameraTarget, 'rider and camera anchors');
  assert.ok(actor.root.getChildMeshes().some(m => m.name.includes(`body-${definition.id}`)));
  actor.setInput(input); actor.step(0.05);
  assert.ok(actor.state.speed > 0);
  assert.ok(actor.applyPose() < 0.02, 'slope wheel support residual');
  actor.state.leanRad = p.fallAngleRad + 0.1; actor.step(0.02);
  assert.equal(actor.telemetry().fallen, true);
  assert.equal(actor.recover(), true);
  actor.dispose();
  assert.deepEqual([scene.meshes.length, scene.materials.length, scene.transformNodes.length], before, 'owned resources disposed');
  console.log(`PASS ${definition.id}: drive, turn, instability, recovery, slope, two contacts, anchors and disposal`);
}
// ---------------------------------------------------------------------------
// Rediseño visual de las motos (TDD): formas facetadas diferenciadas, no
// ladrillos iguales. Trail = Honda CRF300L dual-sport (roja/blanca, faro y
// guardabarros alto); Enduro = KTM 450 SX-F (naranja, placa dorsal sin luces,
// guardabarros picudo). Ambas esbeltas/altas, con motor, horquilla,
// basculante, cadena, escape, depósito anguloso, asiento, radios y tacos.
// ---------------------------------------------------------------------------
const hexOf = (color) => `#${[color.r, color.g, color.b]
  .map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
const meshBox = (mesh) => {
  mesh.computeWorldMatrix(true);
  mesh.refreshBoundingInfo();
  const box = mesh.getBoundingInfo().boundingBox;
  return {
    minX: box.minimumWorld.x, minY: box.minimumWorld.y, minZ: box.minimumWorld.z,
    maxX: box.maximumWorld.x, maxY: box.maximumWorld.y, maxZ: box.maximumWorld.z,
  };
};
const sceneCount = () => [scene.meshes.length, scene.materials.length, scene.transformNodes.length];
const silhouettes = {};
for (const definition of api.VEHICLE_CATALOG.filter((entry) => entry.category === 'moto')) {
  const before = sceneCount();
  const actor = api.createVehicle({ scene, terrain: flat, spawn: { x: 0, z: 0 } }, definition);
  actor.applyPose();
  const label = definition.id;
  const { wheelBase, wheelRadius } = definition.params;
  const meshes = actor.root.getChildMeshes();
  const nodes = actor.root.getChildTransformNodes();
  const byName = (marker) => meshes.find((mesh) => mesh.name.includes(marker));
  const every = (marker) => meshes.filter((mesh) => mesh.name.includes(marker));
  const has = (marker) => meshes.some((mesh) => mesh.name.includes(marker));
  const wheelTop = wheelRadius * 2;

  // Depósito facetado con tapas angulosas, asiento, motor visible y escape alto.
  const tank = byName('tank');
  assert.ok(tank, `${label} falta el depósito`);
  assert.ok(tank.getTotalVertices() > 24, `${label} el depósito debe ser facetado, no una caja`);
  for (const side of ['left', 'right']) {
    const shroud = byName(`shroud-${side}`);
    assert.ok(shroud, `${label} falta la tapa lateral ${side}`);
    const shroudBox = meshBox(shroud);
    assert.ok(Math.min(Math.abs(shroudBox.minX), Math.abs(shroudBox.maxX)) > 0.09, `${label} tapa ${side} no lateral`);
    assert.ok(Math.abs(shroud.rotation.y) > 0.1 || Math.abs(shroud.rotation.z) > 0.1, `${label} tapa ${side} sin ángulo`);
  }
  const seat = byName('seat');
  const seatBox = meshBox(seat);
  assert.ok(seat, `${label} falta el asiento`);
  const engine = byName('engine');
  assert.ok(engine, `${label} motor no visible`);
  const engineBox = meshBox(engine);
  assert.ok(engineBox.maxY - engineBox.minY >= 0.16 && engineBox.maxZ - engineBox.minZ >= 0.24, `${label} motor demasiado pequeño`);
  assert.ok(engineBox.minY <= 0.5, `${label} motor mal ubicado`);
  const muffler = byName('muffler');
  assert.ok(muffler, `${label} falta el escape`);
  const mufflerBox = meshBox(muffler);
  assert.ok(mufflerBox.minY >= 0.42, `${label} escape no es lateral alto`);
  assert.ok(Math.max(Math.abs(mufflerBox.minX), Math.abs(mufflerBox.maxX)) >= 0.06, `${label} escape no es lateral`);

  // Horquilla y basculante claramente visibles hasta los ejes.
  const forks = every('fork');
  assert.equal(forks.length, 2, `${label} la horquilla necesita dos barras`);
  for (const leg of forks) {
    const legBox = meshBox(leg);
    assert.ok(Math.abs((legBox.minX + legBox.maxX) / 2) > 0.04, `${label} barra de horquilla centrada`);
    assert.ok(legBox.minY <= wheelRadius + 0.08, `${label} horquilla no llega al eje`);
    assert.ok(legBox.maxY >= wheelRadius + 0.35, `${label} horquilla demasiado corta`);
  }
  const swingarm = byName('swingarm');
  const swingBox = meshBox(swingarm);
  assert.ok(swingarm, `${label} falta el basculante`);
  assert.ok(swingBox.minZ <= -wheelBase / 2 + 0.12, `${label} basculante no llega al eje trasero`);
  assert.ok(swingBox.maxZ < 0.2, `${label} basculante no pivota en el chasis`);
  assert.ok(Math.abs((swingBox.minY + swingBox.maxY) / 2 - wheelRadius) <= 0.12, `${label} basculante fuera del eje`);
  assert.ok(byName('chain'), `${label} cadena no visible`);
  assert.ok(byName('sprocket'), `${label} piñón no visible`);

  // Ruedas de radios con tacos, montadas sobre el eje y animables.
  assert.equal(every('tire').length, 2, `${label} faltan neumáticos`);
  for (const tire of every('tire')) assert.ok(tire.getTotalVertices() >= 60, `${label} neumático sin perfil redondo`);
  assert.equal(every('rim').length, 2, `${label} faltan llantas`);
  for (const wheel of ['front', 'rear']) {
    const spin = nodes.find((node) => node.name === `motorcycle:wheel-${wheel}-spin`);
    assert.ok(spin, `${label} falta el giro de la rueda ${wheel}`);
    const parts = spin.getChildMeshes();
    const spokes = parts.filter((mesh) => mesh.name.includes('spoke'));
    const knobs = parts.filter((mesh) => mesh.name.includes('knob'));
    assert.ok(spokes.length >= 8, `${label} rueda ${wheel} sin radios suficientes`);
    assert.equal(new Set(spokes.map((mesh) => mesh.rotation.x.toFixed(3))).size, spokes.length, `${label} radios ${wheel} no radiales`);
    assert.ok(knobs.length >= 12, `${label} rueda ${wheel} sin tacos suficientes`);
    const angles = new Set(knobs.map((mesh) => Math.atan2(mesh.position.y, mesh.position.z).toFixed(2)));
    assert.ok(angles.size >= 10, `${label} tacos ${wheel} mal distribuidos`);
  }

  // Marcas propias: Honda con faro y guardabarros alto; KTM con placa sin luces.
  const frontFenderBox = meshBox(byName('front-fender'));
  const fender = byName('front-fender');
  assert.ok(fender && Math.abs(fender.rotation.x) > 0.1, `${label} guardabarros delantero plano`);
  if (definition.visual === 'trail') {
    const headlight = byName('headlight');
    assert.ok(headlight, 'trail (Honda) sin faro/máscara');
    const headlightBox = meshBox(headlight);
    assert.ok(headlightBox.maxZ >= wheelBase / 2 - 0.12 && headlightBox.minY >= 0.9, 'trail (Honda) faro mal ubicado');
    assert.ok(frontFenderBox.minY >= wheelTop + 0.03, `trail (Honda) guardabarros no es alto: ${frontFenderBox.minY.toFixed(3)}`);
    assert.ok(seatBox.maxZ - seatBox.minZ >= 0.55, 'trail (Honda) asiento no es largo');
    assert.equal(has('number-plate'), false, 'trail (Honda) sin placa dorsal');
    assert.equal(has('mirror'), false, 'trail (Honda) sin espejos');
    assert.equal(has('luggage'), false, 'trail (Honda) sin maletas');
  } else {
    const plate = byName('number-plate');
    assert.ok(plate, 'enduro (KTM) sin placa dorsal');
    const plateBox = meshBox(plate);
    assert.ok(plateBox.maxZ >= wheelBase / 2 - 0.12 && plateBox.minY >= 0.85, 'enduro (KTM) placa mal ubicada');
    assert.equal(has('headlight'), false, 'enduro (KTM) con faro');
    assert.equal(has('mirror'), false, 'enduro (KTM) con espejos');
    assert.equal(has('luggage'), false, 'enduro (KTM) con maletas');
    assert.ok(frontFenderBox.minY <= wheelTop + 0.14, 'enduro (KTM) guardabarros no es picudo');
    assert.ok(frontFenderBox.maxZ >= wheelBase / 2 + 0.18, 'enduro (KTM) guardabarros no apunta al frente');
    assert.ok(seatBox.maxX - seatBox.minX <= 0.3, 'enduro (KTM) asiento no es estrecho');
    assert.ok(seatBox.minY >= 0.8, 'enduro (KTM) asiento no es alto');
  }

  // Perfil low-poly realista: segmentado, sin texturas y con presupuesto moderado.
  const nonBoxes = meshes.filter((mesh) => mesh.getTotalVertices() > 24).length;
  const triangles = meshes.reduce((sum, mesh) => sum + mesh.getTotalIndices() / 3, 0);
  for (const material of new Set(meshes.map((mesh) => mesh.material))) {
    assert.equal(material.diffuseTexture, null, `${label} usa texturas foto-realistas`);
  }
  assert.ok(nonBoxes >= 12, `${label} usa demasiadas cajas: ${nonBoxes} formas segmentadas`);
  assert.ok(triangles >= 1500 && triangles <= 30000, `${label} presupuesto de triángulos fuera de rango: ${triangles}`);
  assert.ok(meshes.length >= 45 && meshes.length <= 130, `${label} número de piezas fuera de rango: ${meshes.length}`);

  const paints = [...new Set(meshes.map((mesh) => mesh.material).filter(Boolean).map((material) => hexOf(material.diffuseColor)))];
  if (definition.visual === 'trail') {
    assert.ok(paints.includes('#c1272d'), 'trail (Honda) sin rojo');
    assert.ok(paints.includes('#f2f4f7'), 'trail (Honda) sin blanco');
    assert.equal(paints.includes('#f26f21'), false, 'trail (Honda) con naranja de KTM');
  } else {
    assert.ok(paints.includes('#f26f21'), 'enduro (KTM) sin naranja');
    assert.ok(paints.includes('#f2f4f7'), 'enduro (KTM) sin placa blanca');
    assert.equal(paints.includes('#c1272d'), false, 'enduro (KTM) con rojo de Honda');
  }

  const extent = (axis) => {
    const boxes = meshes.map((mesh) => meshBox(mesh));
    return {
      min: Math.min(...boxes.map((box) => box[`min${axis}`])),
      max: Math.max(...boxes.map((box) => box[`max${axis}`])),
    };
  };
  const height = extent('Y');
  const width = extent('X');
  const length = extent('Z');
  const size = { height: height.max - height.min, width: width.max - width.min, length: length.max - length.min };
  assert.ok(size.height > 1.0, `${label} no es alta: ${size.height.toFixed(3)}`);
  assert.ok(size.width <= definition.bodySize.widthM + 0.05, `${label} demasiado ancha: ${size.width.toFixed(3)}`);
  assert.ok(size.length <= wheelBase + wheelTop + 0.25, `${label} demasiado larga: ${size.length.toFixed(3)}`);
  silhouettes[label] = { ...size, fenderMinY: frontFenderBox.minY, paints };

  // Controles vivos: giro de ruedas, dirección y manillar.
  actor.setInput({ throttle: 1, steer: 0.4, handbrake: false, neutral: false });
  for (let i = 0; i < 20; i++) actor.step(1 / 60);
  for (const wheel of ['front', 'rear']) {
    const spin = nodes.find((node) => node.name === `motorcycle:wheel-${wheel}-spin`);
    assert.notEqual(spin.rotation.x, 0, `${label} rueda ${wheel} no gira`);
  }
  assert.notEqual(nodes.find((node) => node.name === 'motorcycle:wheel-front').rotation.y, 0, `${label} no gira la dirección`);
  assert.notEqual(nodes.find((node) => node.name === 'motorcycle:handlebar').rotation.y, 0, `${label} manillar no sigue la dirección`);
  actor.setInput(null);

  console.log(`[geometría] ${label}: piezas=${meshes.length} triángulos=${triangles.toFixed(0)} formas=${nonBoxes} alto=${size.height.toFixed(3)} ancho=${size.width.toFixed(3)}`);
  actor.dispose();
  assert.deepEqual(sceneCount(), before, `${label} no libera sus recursos`);
}
assert.ok(silhouettes.trail.height > silhouettes.enduro.height + 0.04,
  `trail debe ser más alta: ${silhouettes.trail.height.toFixed(3)} vs ${silhouettes.enduro.height.toFixed(3)}`);
assert.ok(silhouettes.trail.fenderMinY > silhouettes.enduro.fenderMinY + 0.04,
  `guardabarros trail debe ser más alto: ${silhouettes.trail.fenderMinY.toFixed(3)} vs ${silhouettes.enduro.fenderMinY.toFixed(3)}`);
assert.notDeepEqual(silhouettes.trail.paints, silhouettes.enduro.paints, 'ambas motos comparten pintura');

scene.dispose(); engine.dispose();
console.log('PASS geometría de motos: trail (CRF300L) y enduro (450 SX-F) diferenciadas');
console.log('PASS motorcycle and legacy factory overload');
