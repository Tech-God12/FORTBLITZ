/**
 * models.js — Procedural weapon meshes in Fortnite's cartoon-PBR style.
 *
 * Style rules applied to every model here:
 *   - Exaggerated proportions: thick stocks, chunky grips, round scopes.
 *     These are toys that happen to shoot bullets.
 *   - Saturated colours, never muted military tones.
 *   - Polymer parts: metalness 0.0-0.1, roughness 0.55-0.75
 *   - Metal parts:   metalness 0.6-0.8, roughness 0.3-0.45
 *   - Every weapon's barrel points down -Z with the grip at the origin,
 *     so the viewmodel rig can position them uniformly.
 *
 * ADS RULE: no geometry may intrude on the centre sight line. Iron sights are
 * modelled to either side of x=0 with a clear channel between them.
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* Shared materials                                                    */
/* ------------------------------------------------------------------ */

const _mats = new Map();

function mat(name, color, roughness, metalness, extra = {}) {
  const key = `${name}:${color}:${roughness}:${metalness}`;
  if (_mats.has(key)) return _mats.get(key);
  const m = new THREE.MeshStandardMaterial({
    color, roughness, metalness, ...extra,
  });
  m.name = name;
  _mats.set(key, m);
  return m;
}

export const WEAPON_MATERIALS = {
  // Polymer furniture — the dominant material on Fortnite guns.
  polymerDark:  () => mat('polymerDark', 0x2b2f36, 0.68, 0.05),
  polymerBlack: () => mat('polymerBlack', 0x1c1f24, 0.62, 0.08),
  polymerTan:   () => mat('polymerTan', 0xb99a63, 0.7, 0.03),
  polymerGrey:  () => mat('polymerGrey', 0x4a5058, 0.66, 0.06),
  // Metals.
  steel:        () => mat('steel', 0x8f98a3, 0.38, 0.75),
  steelDark:    () => mat('steelDark', 0x4c525a, 0.42, 0.7),
  gunmetal:     () => mat('gunmetal', 0x36393f, 0.4, 0.72),
  brass:        () => mat('brass', 0xc9a227, 0.35, 0.8),
  // Accents.
  wood:         () => mat('wood', 0x9a6b3f, 0.72, 0.02),
  glassBlue:    () => mat('glassBlue', 0x5aa0d8, 0.12, 0.35, { transparent: true, opacity: 0.65 }),
  rubber:       () => mat('rubber', 0x18191c, 0.92, 0.0),
  accentOrange: () => mat('accentOrange', 0xd4702a, 0.6, 0.1),
};

/* ------------------------------------------------------------------ */
/* Primitive helpers                                                   */
/* ------------------------------------------------------------------ */

function box(w, h, d, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(g, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  return m;
}

function cyl(rTop, rBot, h, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, seg = 12) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  const m = new THREE.Mesh(g, material);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  return m;
}

/** A cylinder lying along the Z axis (barrels, tubes). */
function tube(r, len, material, x = 0, y = 0, z = 0, seg = 12) {
  return cyl(r, r, len, material, x, y, z, Math.PI / 2, 0, 0, seg);
}

/** Rounded box via a scaled sphere-ish shape — used for chunky bodies. */
function chunk(w, h, d, material, x = 0, y = 0, z = 0, radius = 0.02) {
  // Three.js has no rounded box primitive; approximate with a slightly
  // beveled box using a lathe-free approach: box + edge cylinders is
  // overkill, so we use a box with smoothed normals.
  const g = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  const m = new THREE.Mesh(g, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  return m;
}

/**
 * Standard iron sights: a front post and a rear notch, both offset so the
 * centre channel (x = 0, the aim line) is completely clear.
 */
function ironSights(group, frontZ, rearZ, height, material) {
  // Front post — thin, centred, but LOW enough to sit under the sight line.
  const post = box(0.012, height * 0.55, 0.012, material, 0, height * 0.72, frontZ);
  group.add(post);
  // Front sight hood: two side rails, open in the middle.
  group.add(box(0.008, height * 0.7, 0.03, material, -0.026, height * 0.78, frontZ));
  group.add(box(0.008, height * 0.7, 0.03, material, 0.026, height * 0.78, frontZ));

  // Rear aperture: two uprights with a clear gap between them.
  group.add(box(0.012, height * 0.62, 0.02, material, -0.024, height * 0.76, rearZ));
  group.add(box(0.012, height * 0.62, 0.02, material, 0.024, height * 0.76, rearZ));
  // Rear base.
  group.add(box(0.07, height * 0.16, 0.03, material, 0, height * 0.52, rearZ));
}

/** Pistol grip angled back, chunky Fortnite proportions. */
function pistolGrip(group, x, y, z, material, scale = 1) {
  const g = box(0.058 * scale, 0.15 * scale, 0.072 * scale, material, x, y - 0.075 * scale, z);
  g.rotation.x = 0.28;
  group.add(g);
  // Grip base flare.
  group.add(box(0.062 * scale, 0.022 * scale, 0.08 * scale, material, x, y - 0.15 * scale, z + 0.018 * scale));
}

/** Magazine — curved box hanging below the receiver. */
function magazine(group, x, y, z, w, h, d, material, curve = 0.12) {
  const m1 = box(w, h * 0.6, d, material, x, y - h * 0.3, z);
  m1.rotation.x = curve;
  group.add(m1);
  const m2 = box(w * 0.96, h * 0.5, d * 0.95, material, x, y - h * 0.75, z + h * 0.12);
  m2.rotation.x = curve * 2.1;
  group.add(m2);
}

/** Trigger guard loop. */
function triggerGuard(group, z, material) {
  const g = new THREE.TorusGeometry(0.032, 0.007, 6, 12, Math.PI);
  const m = new THREE.Mesh(g, material);
  m.rotation.set(Math.PI / 2, 0, 0);
  m.position.set(0, -0.032, z);
  m.castShadow = true;
  group.add(m);
  // Trigger blade.
  group.add(box(0.01, 0.03, 0.008, material, 0, -0.022, z + 0.004));
}

/* ------------------------------------------------------------------ */
/* Weapon builders                                                     */
/* ------------------------------------------------------------------ */

/**
 * SCAR — the iconic legendary assault rifle. Long handguard, solid stock,
 * distinctive raised carry handle profile.
 */
function buildScar() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = M.polymerTan();
  const metal = M.gunmetal();

  // Receiver.
  g.add(chunk(0.072, 0.088, 0.34, body, 0, 0, -0.02));
  // Upper rail.
  g.add(box(0.05, 0.016, 0.3, M.polymerBlack(), 0, 0.052, -0.03));
  // Handguard with vent slots.
  g.add(chunk(0.062, 0.062, 0.24, body, 0, -0.004, -0.26));
  for (let i = 0; i < 4; i++) {
    g.add(box(0.066, 0.008, 0.018, M.polymerBlack(), 0, 0.006, -0.19 - i * 0.045));
  }
  // Barrel.
  g.add(tube(0.014, 0.2, metal, 0, 0.002, -0.46));
  // Muzzle brake.
  g.add(tube(0.021, 0.05, M.steelDark(), 0, 0.002, -0.575, 10));
  // Stock — thick, Fortnite-chunky.
  g.add(chunk(0.056, 0.07, 0.16, body, 0, 0.004, 0.21));
  g.add(box(0.05, 0.038, 0.06, M.rubber(), 0, 0.0, 0.3));
  // Cheek riser.
  g.add(box(0.046, 0.026, 0.11, body, 0, 0.05, 0.19));

  pistolGrip(g, 0, -0.035, 0.075, M.polymerBlack());
  triggerGuard(g, 0.04, metal);
  magazine(g, 0, -0.05, -0.045, 0.05, 0.15, 0.085, M.polymerBlack());
  // Charging handle.
  g.add(box(0.018, 0.014, 0.05, metal, 0.042, 0.03, 0.06));
  ironSights(g, -0.34, 0.02, 0.06, M.polymerBlack());

  return g;
}

/** M16 — burst rifle. Triangular handguard, carry handle, longer profile. */
function buildM16() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = M.polymerBlack();
  const metal = M.gunmetal();

  g.add(chunk(0.066, 0.082, 0.3, body, 0, 0, 0.0));
  // Distinctive carry handle.
  g.add(box(0.03, 0.014, 0.16, body, 0, 0.066, -0.02));
  g.add(box(0.028, 0.05, 0.022, body, 0, 0.042, 0.05));
  g.add(box(0.028, 0.05, 0.022, body, 0, 0.042, -0.09));
  // Triangular handguard (round in section).
  g.add(cyl(0.038, 0.042, 0.26, body, 0, -0.004, -0.29, Math.PI / 2, 0, 0, 10));
  // Barrel + flash hider.
  g.add(tube(0.012, 0.26, metal, 0, 0.0, -0.53));
  g.add(tube(0.019, 0.055, M.steelDark(), 0, 0.0, -0.68, 8));
  // Front sight tower — the M16's signature silhouette.
  g.add(box(0.022, 0.062, 0.03, body, 0, 0.042, -0.42));
  g.add(box(0.05, 0.014, 0.03, body, 0, 0.016, -0.42));
  // Fixed A2 stock.
  g.add(chunk(0.052, 0.066, 0.2, body, 0, -0.004, 0.22));
  g.add(box(0.05, 0.058, 0.035, M.rubber(), 0, -0.004, 0.33));

  pistolGrip(g, 0, -0.036, 0.085, body);
  triggerGuard(g, 0.05, metal);
  magazine(g, 0, -0.05, -0.02, 0.046, 0.14, 0.08, body, 0.1);
  ironSights(g, -0.42, -0.02, 0.055, body);

  return g;
}

/** Suppressed AR — same family, fat suppressor can, no muzzle flash. */
function buildSuppressedAR() {
  const g = buildScar();
  const M = WEAPON_MATERIALS;
  // Replace the muzzle with a long suppressor.
  g.add(tube(0.032, 0.22, M.polymerGrey(), 0, 0.002, -0.66, 14));
  // Suppressor end cap.
  g.add(tube(0.034, 0.02, M.steelDark(), 0, 0.002, -0.77, 14));
  return g;
}

/** Pump shotgun — wide receiver, prominent pump handle, big bore. */
function buildPump() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = M.polymerDark();
  const wood = M.wood();
  const metal = M.steelDark();

  // Chunky receiver.
  g.add(chunk(0.078, 0.096, 0.24, body, 0, 0, 0.02));
  // Big bore barrel.
  g.add(tube(0.024, 0.44, metal, 0, 0.012, -0.32, 14));
  // Magazine tube under the barrel.
  g.add(tube(0.018, 0.4, M.gunmetal(), 0, -0.026, -0.3, 12));
  // The pump — this is the visual signature.
  const pump = tube(0.032, 0.14, wood, 0, -0.018, -0.28, 14);
  pump.name = 'pump';
  g.add(pump);
  // Pump grooves.
  for (let i = 0; i < 5; i++) {
    g.add(tube(0.034, 0.008, M.polymerBlack(), 0, -0.018, -0.34 + i * 0.028, 14));
  }
  // Wooden stock.
  g.add(chunk(0.06, 0.078, 0.2, wood, 0, -0.01, 0.2));
  g.add(box(0.056, 0.07, 0.03, M.rubber(), 0, -0.014, 0.31));
  // Ejection port.
  g.add(box(0.006, 0.03, 0.07, M.gunmetal(), 0.04, 0.012, 0.0));

  pistolGrip(g, 0, -0.04, 0.09, wood, 0.95);
  triggerGuard(g, 0.055, metal);
  // Bead front sight (shotguns have no rear sight).
  g.add(cyl(0.008, 0.008, 0.012, M.brass(), 0, 0.042, -0.52, 0, 0, 0, 8));

  return g;
}

/** Tactical shotgun — semi-auto, box mag look, shorter and boxier. */
function buildTacticalShotgun() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = M.polymerBlack();
  const metal = M.gunmetal();

  g.add(chunk(0.074, 0.09, 0.26, body, 0, 0, 0.0));
  g.add(tube(0.022, 0.32, M.steelDark(), 0, 0.01, -0.3, 14));
  // Heat shield with vents.
  g.add(tube(0.03, 0.2, M.polymerGrey(), 0, 0.01, -0.26, 12));
  for (let i = 0; i < 4; i++) {
    g.add(box(0.05, 0.01, 0.02, body, 0, 0.036, -0.19 - i * 0.04));
  }
  // Side-saddle shell holder — reads as "shotgun" instantly.
  for (let i = 0; i < 4; i++) {
    g.add(tube(0.011, 0.05, M.accentOrange(), 0.042, 0.02 - i * 0.022, 0.02, 8));
  }
  // Collapsible stock.
  g.add(box(0.03, 0.03, 0.16, M.steelDark(), 0, 0.0, 0.2));
  g.add(box(0.055, 0.07, 0.035, M.rubber(), 0, -0.008, 0.29));

  pistolGrip(g, 0, -0.038, 0.075, body);
  triggerGuard(g, 0.04, metal);
  magazine(g, 0, -0.052, -0.035, 0.056, 0.12, 0.09, body, 0.06);
  ironSights(g, -0.36, 0.02, 0.055, body);

  return g;
}

/** Tactical SMG — compact, high-cap mag, short barrel. */
function buildTacticalSMG() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = M.polymerGrey();
  const metal = M.gunmetal();

  g.add(chunk(0.062, 0.078, 0.2, body, 0, 0, 0.0));
  g.add(tube(0.012, 0.14, metal, 0, 0.004, -0.17));
  g.add(tube(0.02, 0.05, M.steelDark(), 0, 0.004, -0.26, 10));
  // Short handguard.
  g.add(chunk(0.05, 0.05, 0.12, M.polymerBlack(), 0, -0.002, -0.15));
  // Folding stock — thin struts.
  g.add(box(0.012, 0.012, 0.14, M.steelDark(), -0.024, 0.01, 0.15));
  g.add(box(0.012, 0.012, 0.14, M.steelDark(), 0.024, 0.01, 0.15));
  g.add(box(0.062, 0.05, 0.022, M.rubber(), 0, 0.01, 0.225));
  // Top rail.
  g.add(box(0.04, 0.012, 0.18, M.polymerBlack(), 0, 0.046, -0.02));

  pistolGrip(g, 0, -0.032, 0.05, M.polymerBlack());
  triggerGuard(g, 0.018, metal);
  // Long high-capacity magazine — the SMG's identity.
  magazine(g, 0, -0.048, -0.02, 0.042, 0.2, 0.07, M.polymerBlack(), 0.06);
  ironSights(g, -0.2, 0.04, 0.05, M.polymerBlack());

  return g;
}

/** Minigun — six rotating barrels, huge, absurd. Pure Fortnite. */
function buildMinigun() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = M.polymerDark();
  const metal = M.steelDark();

  // Main body drum.
  g.add(cyl(0.09, 0.09, 0.26, body, 0, 0, 0.06, Math.PI / 2, 0, 0, 16));
  // Rotating barrel assembly.
  const barrels = new THREE.Group();
  barrels.name = 'barrels';
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    barrels.add(tube(0.016, 0.42, metal, Math.cos(a) * 0.045, Math.sin(a) * 0.045, 0, 8));
  }
  barrels.position.set(0, 0, -0.3);
  g.add(barrels);
  // Barrel shroud rings.
  g.add(cyl(0.07, 0.07, 0.02, M.gunmetal(), 0, 0, -0.14, Math.PI / 2, 0, 0, 16));
  g.add(cyl(0.07, 0.07, 0.02, M.gunmetal(), 0, 0, -0.48, Math.PI / 2, 0, 0, 16));
  // Ammo drum on the side.
  g.add(cyl(0.08, 0.08, 0.09, M.accentOrange(), 0.095, -0.05, 0.1, 0, 0, Math.PI / 2, 14));
  // Rear handles.
  g.add(box(0.03, 0.11, 0.03, M.rubber(), -0.07, -0.03, 0.19));
  g.add(box(0.03, 0.11, 0.03, M.rubber(), 0.07, -0.03, 0.19));
  g.add(box(0.18, 0.024, 0.03, body, 0, 0.02, 0.19));

  return g;
}

/** Bolt-action sniper — long barrel, big scope, bipod suggestion. */
function buildBoltSniper() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = M.polymerGrey();
  const metal = M.gunmetal();

  // Long receiver.
  g.add(chunk(0.062, 0.078, 0.36, body, 0, 0, 0.0));
  // Very long heavy barrel.
  g.add(tube(0.017, 0.62, M.steelDark(), 0, 0.004, -0.5, 14));
  // Muzzle brake.
  g.add(tube(0.026, 0.06, metal, 0, 0.004, -0.83, 12));
  // Barrel fluting rings.
  for (let i = 0; i < 3; i++) {
    g.add(tube(0.021, 0.014, metal, 0, 0.004, -0.45 - i * 0.16, 12));
  }

  // SCOPE — mounted high, rings, clear glass. Round and chunky.
  const scope = new THREE.Group();
  scope.name = 'scope';
  scope.add(tube(0.032, 0.26, M.polymerBlack(), 0, 0, 0, 16));
  // Objective bell.
  scope.add(cyl(0.042, 0.032, 0.07, M.polymerBlack(), 0, 0, -0.16, Math.PI / 2, 0, 0, 16));
  // Eyepiece.
  scope.add(cyl(0.036, 0.03, 0.05, M.polymerBlack(), 0, 0, 0.15, Math.PI / 2, 0, 0, 16));
  // Lens glass.
  scope.add(cyl(0.038, 0.038, 0.006, M.glassBlue(), 0, 0, -0.194, Math.PI / 2, 0, 0, 16));
  // Turrets.
  scope.add(cyl(0.016, 0.016, 0.028, M.steelDark(), 0, 0.038, -0.02, 0, 0, 0, 10));
  scope.add(cyl(0.016, 0.016, 0.028, M.steelDark(), 0.038, 0, -0.02, 0, 0, Math.PI / 2, 10));
  scope.position.set(0, 0.086, -0.05);
  g.add(scope);
  // Scope rings.
  g.add(box(0.026, 0.05, 0.022, metal, 0, 0.062, -0.14));
  g.add(box(0.026, 0.05, 0.022, metal, 0, 0.062, 0.04));

  // Bolt handle — sticks out to the right.
  const bolt = box(0.05, 0.014, 0.014, metal, 0.045, 0.022, 0.06);
  bolt.name = 'bolt';
  g.add(bolt);
  g.add(cyl(0.012, 0.012, 0.018, metal, 0.072, 0.022, 0.06, 0, 0, Math.PI / 2, 8));

  // Thumbhole stock.
  g.add(chunk(0.056, 0.084, 0.24, body, 0, -0.006, 0.24));
  g.add(box(0.052, 0.03, 0.12, body, 0, 0.05, 0.22)); // cheek rest
  g.add(box(0.056, 0.075, 0.032, M.rubber(), 0, -0.01, 0.37));

  // Bipod, folded back along the handguard.
  g.add(box(0.01, 0.09, 0.01, metal, -0.026, -0.05, -0.3, 0.35, 0, -0.25));
  g.add(box(0.01, 0.09, 0.01, metal, 0.026, -0.05, -0.3, 0.35, 0, 0.25));

  pistolGrip(g, 0, -0.038, 0.1, body);
  triggerGuard(g, 0.065, metal);
  magazine(g, 0, -0.05, -0.01, 0.04, 0.09, 0.075, M.polymerBlack(), 0.04);

  return g;
}

/** Semi-auto sniper — shorter than the bolt, box mag, smaller scope. */
function buildSemiSniper() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = M.polymerBlack();
  const metal = M.gunmetal();

  g.add(chunk(0.068, 0.084, 0.34, body, 0, 0, 0.0));
  g.add(tube(0.015, 0.46, M.steelDark(), 0, 0.004, -0.42, 12));
  g.add(tube(0.023, 0.05, metal, 0, 0.004, -0.67, 10));
  // Handguard.
  g.add(chunk(0.056, 0.056, 0.22, M.polymerGrey(), 0, -0.002, -0.28));

  // Compact scope.
  const scope = new THREE.Group();
  scope.name = 'scope';
  scope.add(tube(0.026, 0.2, body, 0, 0, 0, 14));
  scope.add(cyl(0.032, 0.026, 0.05, body, 0, 0, -0.12, Math.PI / 2, 0, 0, 14));
  scope.add(cyl(0.03, 0.03, 0.005, M.glassBlue(), 0, 0, -0.146, Math.PI / 2, 0, 0, 14));
  scope.position.set(0, 0.076, -0.04);
  g.add(scope);
  g.add(box(0.024, 0.042, 0.02, metal, 0, 0.056, -0.11));
  g.add(box(0.024, 0.042, 0.02, metal, 0, 0.056, 0.03));

  g.add(chunk(0.054, 0.072, 0.2, body, 0, -0.004, 0.22));
  g.add(box(0.052, 0.062, 0.03, M.rubber(), 0, -0.008, 0.33));

  pistolGrip(g, 0, -0.036, 0.085, body);
  triggerGuard(g, 0.05, metal);
  magazine(g, 0, -0.05, -0.02, 0.046, 0.13, 0.08, body, 0.08);

  return g;
}

/** Hand cannon — visually MUCH bigger than the pistol. Deagle energy. */
function buildHandCannon() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = M.steelDark();
  const metal = M.steel();

  // Massive slide.
  g.add(chunk(0.05, 0.07, 0.24, metal, 0, 0.028, -0.06));
  // Slide serrations.
  for (let i = 0; i < 5; i++) {
    g.add(box(0.052, 0.05, 0.007, M.gunmetal(), 0, 0.028, 0.01 + i * 0.014));
  }
  // Frame.
  g.add(chunk(0.046, 0.05, 0.2, body, 0, -0.012, -0.04));
  // Big vented barrel rib.
  g.add(box(0.03, 0.014, 0.2, M.gunmetal(), 0, 0.066, -0.08));
  for (let i = 0; i < 4; i++) {
    g.add(box(0.032, 0.018, 0.012, body, 0, 0.06, -0.13 + i * 0.032));
  }
  // Muzzle.
  g.add(tube(0.018, 0.03, M.gunmetal(), 0, 0.026, -0.185, 10));

  pistolGrip(g, 0, -0.03, 0.055, M.polymerBlack(), 1.15);
  triggerGuard(g, 0.01, body);
  ironSights(g, -0.16, 0.055, 0.05, M.polymerBlack());

  return g;
}

/** Standard pistol — compact, unremarkable, reliable. */
function buildPistol() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = M.polymerBlack();
  const metal = M.gunmetal();

  g.add(chunk(0.036, 0.052, 0.17, metal, 0, 0.022, -0.03));
  for (let i = 0; i < 4; i++) {
    g.add(box(0.038, 0.04, 0.006, M.steelDark(), 0, 0.022, 0.012 + i * 0.012));
  }
  g.add(chunk(0.034, 0.04, 0.14, body, 0, -0.008, -0.02));
  g.add(tube(0.011, 0.022, M.steelDark(), 0, 0.02, -0.122, 10));

  pistolGrip(g, 0, -0.026, 0.042, body, 0.9);
  triggerGuard(g, 0.005, body);
  ironSights(g, -0.1, 0.048, 0.042, body);

  return g;
}

/** Grenade launcher — fat revolving cylinder, stubby barrel. */
function buildGrenadeLauncher() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = M.polymerDark();
  const metal = M.gunmetal();

  // The drum — six chambers, unmistakable.
  const drum = cyl(0.088, 0.088, 0.14, M.accentOrange(), 0, 0, -0.02, Math.PI / 2, 0, 0, 18);
  drum.name = 'drum';
  g.add(drum);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.add(tube(0.024, 0.15, M.gunmetal(), Math.cos(a) * 0.052, Math.sin(a) * 0.052, -0.02, 10));
  }
  // Wide bore barrel.
  g.add(tube(0.035, 0.24, metal, 0, 0, -0.21, 14));
  g.add(tube(0.04, 0.02, M.steelDark(), 0, 0, -0.32, 14));
  // Frame over the top.
  g.add(box(0.036, 0.024, 0.4, body, 0, 0.072, -0.08));
  // Stock.
  g.add(box(0.028, 0.028, 0.16, M.steelDark(), 0, 0.0, 0.17));
  g.add(box(0.06, 0.075, 0.03, M.rubber(), 0, -0.006, 0.26));
  // Foregrip.
  g.add(box(0.03, 0.09, 0.036, M.rubber(), 0, -0.09, -0.14, 0.2, 0, 0));

  pistolGrip(g, 0, -0.04, 0.08, M.polymerBlack());
  triggerGuard(g, 0.045, metal);
  // Ladder sight.
  g.add(box(0.03, 0.05, 0.008, M.polymerBlack(), 0, 0.104, 0.02));

  return g;
}

/** RPG — long launch tube with a fat warhead sticking out the front. */
function buildRPG() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const tubeMat = M.polymerGrey();
  const metal = M.gunmetal();

  // Launch tube.
  g.add(tube(0.05, 0.86, tubeMat, 0, 0, -0.1, 16));
  // Rear venturi flare.
  g.add(cyl(0.078, 0.05, 0.14, M.steelDark(), 0, 0, 0.39, Math.PI / 2, 0, 0, 16));
  // Warhead — the big conical rocket up front.
  const warhead = new THREE.Group();
  warhead.name = 'warhead';
  warhead.add(cyl(0.001, 0.058, 0.13, M.accentOrange(), 0, 0, -0.06, -Math.PI / 2, 0, 0, 14));
  warhead.add(tube(0.03, 0.13, M.polymerDark(), 0, 0, 0.06, 12));
  // Fins.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const fin = box(0.004, 0.05, 0.06, M.polymerDark(), Math.cos(a) * 0.035, Math.sin(a) * 0.035, 0.1);
    fin.rotation.z = a;
    warhead.add(fin);
  }
  warhead.position.set(0, 0, -0.62);
  g.add(warhead);
  // Grip and trigger group.
  pistolGrip(g, 0, -0.05, 0.06, M.polymerBlack(), 1.05);
  triggerGuard(g, 0.025, metal);
  // Front grip.
  g.add(box(0.03, 0.1, 0.036, M.rubber(), 0, -0.098, -0.24, 0.18, 0, 0));
  // Optic block on top.
  g.add(box(0.05, 0.036, 0.12, M.polymerBlack(), 0, 0.07, -0.05));
  g.add(cyl(0.02, 0.02, 0.006, M.glassBlue(), 0, 0.076, -0.112, Math.PI / 2, 0, 0, 12));
  // Shoulder rest.
  g.add(box(0.07, 0.03, 0.09, M.rubber(), 0, -0.052, 0.24));

  return g;
}

/** Pickaxe — always equipped, two-handed, chunky Fortnite silhouette. */
function buildPickaxe() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;

  // Handle.
  g.add(cyl(0.019, 0.022, 0.62, M.polymerDark(), 0, 0, 0, Math.PI / 2, 0, 0, 10));
  // Grip wrap.
  g.add(cyl(0.024, 0.024, 0.16, M.rubber(), 0, 0, 0.2, Math.PI / 2, 0, 0, 10));
  // Head mount.
  g.add(box(0.05, 0.05, 0.07, M.steelDark(), 0, 0.01, -0.29));
  // The blade — swept forward, tapering to a point.
  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0, 0);
  bladeShape.lineTo(0.055, 0.03);
  bladeShape.lineTo(0.17, 0.02);
  bladeShape.lineTo(0.19, -0.035);
  bladeShape.lineTo(0.06, -0.028);
  bladeShape.lineTo(0, -0.02);
  bladeShape.lineTo(0, 0);
  const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, { depth: 0.024, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.005, bevelSegments: 1 });
  const blade = new THREE.Mesh(bladeGeo, M.steel());
  blade.rotation.set(0, Math.PI / 2, 0);
  blade.position.set(-0.012, 0.03, -0.3);
  blade.castShadow = true;
  g.add(blade);
  // Counterweight spike at the back of the head.
  g.add(cyl(0.0, 0.026, 0.09, M.steelDark(), 0, -0.03, -0.29, -Math.PI / 2, 0, 0, 8));

  return g;
}

/* ------------------------------------------------------------------ */
/* Throwables & consumables                                            */
/* ------------------------------------------------------------------ */

function buildFragGrenade() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const bodyGeo = new THREE.SphereGeometry(0.055, 14, 12);
  const body = new THREE.Mesh(bodyGeo, mat('gren', 0x3f5a32, 0.7, 0.15));
  body.castShadow = true;
  g.add(body);
  // Segmentation bands.
  for (let i = 0; i < 3; i++) {
    g.add(cyl(0.057, 0.057, 0.006, mat('grenband', 0x2a3d22, 0.75, 0.15), 0, -0.02 + i * 0.02, 0, 0, 0, 0, 14));
  }
  g.add(cyl(0.02, 0.02, 0.03, M.steelDark(), 0, 0.062, 0, 0, 0, 0, 10));
  // Spoon.
  g.add(box(0.012, 0.05, 0.008, M.steel(), 0.026, 0.05, 0));
  // Pin ring.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.004, 6, 12), M.steel());
  ring.position.set(-0.03, 0.062, 0);
  ring.rotation.y = Math.PI / 2;
  g.add(ring);
  return g;
}

function buildClinger() {
  const g = new THREE.Group();
  const M = WEAPON_MATERIALS;
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 12), mat('cling', 0xd8b23a, 0.6, 0.1));
  body.castShadow = true;
  g.add(body);
  // Sticky goo blobs.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const blob = new THREE.Mesh(new THREE.SphereGeometry(0.016, 8, 6), mat('goo', 0x8fd44a, 0.35, 0.0));
    blob.position.set(Math.cos(a) * 0.048, Math.sin(a * 1.7) * 0.03, Math.sin(a) * 0.048);
    g.add(blob);
  }
  g.add(cyl(0.016, 0.016, 0.026, M.steelDark(), 0, 0.056, 0, 0, 0, 0, 8));
  return g;
}

function buildBoogieBomb() {
  const g = new THREE.Group();
  // Disco ball!
  const ball = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.055, 1),
    mat('disco', 0xc8d8f0, 0.18, 0.9, { flatShading: true }),
  );
  ball.castShadow = true;
  g.add(ball);
  g.add(cyl(0.014, 0.014, 0.028, WEAPON_MATERIALS.steelDark(), 0, 0.062, 0, 0, 0, 0, 8));
  // Coloured facet accents.
  const colors = [0xff4fa3, 0x4fd0ff, 0xffe14f];
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    const p = new THREE.Mesh(
      new THREE.BoxGeometry(0.016, 0.016, 0.004),
      mat(`disco${i % 3}`, colors[i % 3], 0.25, 0.6, { emissive: colors[i % 3], emissiveIntensity: 0.35 }),
    );
    p.position.set(Math.cos(a) * 0.05, Math.sin(a * 2.1) * 0.035, Math.sin(a) * 0.05);
    p.lookAt(0, 0, 0);
    g.add(p);
  }
  return g;
}

function buildMedkit() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.11, 0.09), mat('medkit', 0xf2f2f2, 0.55, 0.0));
  body.castShadow = true;
  g.add(body);
  // Red cross.
  g.add(box(0.07, 0.022, 0.002, mat('cross', 0xe03a3a, 0.5, 0.0), 0, 0, 0.046));
  g.add(box(0.022, 0.07, 0.002, mat('cross', 0xe03a3a, 0.5, 0.0), 0, 0, 0.046));
  // Handle.
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.007, 6, 12, Math.PI), mat('mh', 0x555, 0.6, 0.2));
  handle.position.set(0, 0.055, 0);
  g.add(handle);
  return g;
}

function buildBandage() {
  const g = new THREE.Group();
  const roll = cyl(0.035, 0.035, 0.055, mat('gauze', 0xf5efe0, 0.85, 0.0), 0, 0, 0, 0, 0, Math.PI / 2, 14);
  g.add(roll);
  g.add(box(0.02, 0.006, 0.058, mat('tape', 0xd94f4f, 0.6, 0.0), 0, 0.032, 0));
  return g;
}

function buildShieldPotion(small = false) {
  const g = new THREE.Group();
  const s = small ? 0.62 : 1.0;
  // Glass flask.
  const glass = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032 * s, 0.042 * s, 0.13 * s, 14),
    mat('flask', 0x9fd8ff, 0.12, 0.1, { transparent: true, opacity: 0.55 }),
  );
  glass.castShadow = true;
  g.add(glass);
  // Liquid inside — the iconic blue.
  const liquid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028 * s, 0.037 * s, 0.09 * s, 14),
    mat('shieldliq', 0x2f7fe8, 0.2, 0.0, { emissive: 0x1a4fa0, emissiveIntensity: 0.5 }),
  );
  liquid.position.y = -0.016 * s;
  g.add(liquid);
  // Cork.
  g.add(cyl(0.018 * s, 0.02 * s, 0.026 * s, mat('cork', 0x8a6a3a, 0.8, 0.0), 0, 0.075 * s, 0, 0, 0, 0, 10));
  return g;
}

function buildSlurpJuice() {
  const g = new THREE.Group();
  const can = cyl(0.036, 0.036, 0.14, mat('slurpcan', 0x39c7c7, 0.35, 0.55), 0, 0, 0, 0, 0, 0, 16);
  can.castShadow = true;
  g.add(can);
  g.add(cyl(0.037, 0.037, 0.012, mat('slurptop', 0xc8d0d8, 0.3, 0.8), 0, 0.072, 0, 0, 0, 0, 16));
  g.add(cyl(0.037, 0.037, 0.012, mat('slurptop', 0xc8d0d8, 0.3, 0.8), 0, -0.072, 0, 0, 0, 0, 16));
  // Label band.
  g.add(cyl(0.0375, 0.0375, 0.06, mat('slurplabel', 0x7fe86a, 0.4, 0.1, { emissive: 0x2f8a20, emissiveIntensity: 0.3 }), 0, 0, 0, 0, 0, 0, 16));
  return g;
}

function buildChugJug() {
  const g = new THREE.Group();
  // Big jug body.
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.062, 0.07, 0.2, 16),
    mat('jug', 0xf0c33a, 0.3, 0.15, { emissive: 0x8a6a10, emissiveIntensity: 0.25 }),
  );
  body.castShadow = true;
  g.add(body);
  // Neck + cap.
  g.add(cyl(0.026, 0.03, 0.05, mat('jugneck', 0xd8a92a, 0.35, 0.15), 0, 0.12, 0, 0, 0, 0, 12));
  g.add(cyl(0.032, 0.032, 0.022, mat('jugcap', 0x8a4f1a, 0.6, 0.05), 0, 0.152, 0, 0, 0, 0, 12));
  // Handle.
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.009, 6, 12, Math.PI * 1.1), mat('jugh', 0xd8a92a, 0.4, 0.15));
  handle.position.set(0.07, 0.06, 0);
  handle.rotation.set(0, Math.PI / 2, -0.4);
  g.add(handle);
  return g;
}

/* ------------------------------------------------------------------ */
/* Ammo box                                                            */
/* ------------------------------------------------------------------ */

function buildAmmoBox(type = 'medium') {
  const colors = {
    light: 0xf2c94c, medium: 0xc89b5a, heavy: 0x6fcf6f,
    shells: 0xeb5757, rockets: 0xf2994a,
  };
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.17, 0.1, 0.11),
    mat(`ammobox_${type}`, colors[type] || 0xc89b5a, 0.65, 0.1),
  );
  body.castShadow = true;
  g.add(body);
  // Lid rim.
  g.add(box(0.175, 0.014, 0.115, mat('ammolid', 0x3a3f45, 0.6, 0.3), 0, 0.05, 0));
  // Latch.
  g.add(box(0.02, 0.02, 0.006, mat('ammolatch', 0x8f98a3, 0.4, 0.7), 0, 0.03, 0.058));
  return g;
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

const BUILDERS = {
  scar: buildScar,
  m16: buildM16,
  suppressed_ar: buildSuppressedAR,
  pump: buildPump,
  tactical_shotgun: buildTacticalShotgun,
  tactical_smg: buildTacticalSMG,
  minigun: buildMinigun,
  bolt_sniper: buildBoltSniper,
  semi_sniper: buildSemiSniper,
  hand_cannon: buildHandCannon,
  pistol: buildPistol,
  grenade_launcher: buildGrenadeLauncher,
  rpg: buildRPG,
  pickaxe: buildPickaxe,

  frag: buildFragGrenade,
  clinger: buildClinger,
  boogie: buildBoogieBomb,

  medkit: buildMedkit,
  bandage: buildBandage,
  shield_potion: () => buildShieldPotion(false),
  mini_shield: () => buildShieldPotion(true),
  slurp: buildSlurpJuice,
  chugjug: buildChugJug,
};

const _protoCache = new Map();

/**
 * Get a weapon/item model. Returns a fresh clone each call so multiple
 * instances (world pickups, viewmodel, bot hands) can coexist.
 */
export function createModel(id) {
  const build = BUILDERS[id];
  if (!build) {
    // Fallback so an unknown id never crashes the game.
    const g = new THREE.Group();
    g.add(box(0.1, 0.06, 0.4, WEAPON_MATERIALS.polymerDark()));
    return g;
  }
  let proto = _protoCache.get(id);
  if (!proto) {
    proto = build();
    proto.name = `weapon_${id}`;
    _protoCache.set(id, proto);
  }
  return proto.clone(true);
}

export function createAmmoBox(type) {
  return buildAmmoBox(type);
}

/** Bounding size of a model, used to sit world pickups flat on the ground. */
export function getModelBounds(id) {
  const m = createModel(id);
  const box3 = new THREE.Box3().setFromObject(m);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box3.getSize(size);
  box3.getCenter(center);
  return { size, center, min: box3.min.clone(), max: box3.max.clone() };
}

export const MODEL_IDS = Object.keys(BUILDERS);

export default { createModel, createAmmoBox, getModelBounds, MODEL_IDS, WEAPON_MATERIALS };
