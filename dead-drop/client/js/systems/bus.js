/**
 * bus.js — The Battle Bus.
 *
 * The emotional start of every match. A yellow school bus slung under a
 * blue-and-white striped balloon, crossing the island on a random diagonal
 * at 300 m/s (roughly 13 seconds corner to corner, matching OG timing).
 *
 * The route is decided at match start and is visible on the map screen
 * before the jump, so players can plan their drop.
 */

import * as THREE from 'three';
import mapConfig from '../config/map.json' with { type: 'json' };
import audio from '../engine/audio.js';

export const BUS_ALTITUDE = 200;
export const BUS_SPEED = 300;
/** Extra distance flown beyond the island edge at each end of the route. */
const ROUTE_MARGIN = 700;

/* ------------------------------------------------------------------ */
/* Bus model                                                           */
/* ------------------------------------------------------------------ */

function mat(color, roughness = 0.7, metalness = 0.05, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}

/**
 * Builds the iconic silhouette: a chunky school bus with a huge balloon
 * above it, connected by tethers. Reads instantly even at 200m.
 */
function buildBus() {
  const group = new THREE.Group();
  group.name = 'BattleBus';

  const yellow = mat(0xf2b705, 0.62, 0.08);
  const darkTrim = mat(0x2a2a30, 0.7, 0.1);
  const glass = mat(0x7fc4e8, 0.15, 0.3, { transparent: true, opacity: 0.72 });
  const tyre = mat(0x17181c, 0.95, 0.0);
  const chrome = mat(0xc8ced6, 0.3, 0.85);

  /* --- body ------------------------------------------------------- */
  const bodyLen = 12.5;
  const bodyW = 3.0;
  const bodyH = 3.1;

  const body = new THREE.Mesh(new THREE.BoxGeometry(bodyW, bodyH, bodyLen), yellow);
  body.position.y = 1.9;
  body.castShadow = true;
  group.add(body);

  // Sloped hood at the front.
  const hood = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 0.94, 1.5, 2.2), yellow);
  hood.position.set(0, 1.1, -bodyLen / 2 - 0.9);
  hood.castShadow = true;
  group.add(hood);

  // Roof cap.
  const roof = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 1.02, 0.22, bodyLen * 0.99), mat(0xd9a404, 0.7));
  roof.position.y = 3.5;
  group.add(roof);

  // Black skirt along the bottom.
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 1.03, 0.5, bodyLen), darkTrim);
  skirt.position.y = 0.5;
  group.add(skirt);

  /* --- windows ---------------------------------------------------- */
  // Side windows: a row down each flank.
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 6; i++) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.15, 1.42), glass);
      w.position.set(side * (bodyW / 2 + 0.01), 2.45, -bodyLen / 2 + 1.4 + i * 1.85);
      group.add(w);
      // Window divider.
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.2, 0.14), darkTrim);
      d.position.set(side * (bodyW / 2 + 0.02), 2.45, -bodyLen / 2 + 0.62 + i * 1.85);
      group.add(d);
    }
  }
  // Windshield.
  const ws = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 0.88, 1.3, 0.1), glass);
  ws.position.set(0, 2.5, -bodyLen / 2 - 0.02);
  group.add(ws);
  // Rear window.
  const rw = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 0.8, 1.1, 0.1), glass);
  rw.position.set(0, 2.5, bodyLen / 2 + 0.02);
  group.add(rw);

  /* --- wheels ----------------------------------------------------- */
  const wheelGeo = new THREE.CylinderGeometry(0.62, 0.62, 0.42, 14);
  for (const [x, z] of [[-1, -4.2], [1, -4.2], [-1, 3.4], [1, 3.4], [-1, 4.6], [1, 4.6]]) {
    const w = new THREE.Mesh(wheelGeo, tyre);
    w.rotation.z = Math.PI / 2;
    w.position.set(x * (bodyW / 2 + 0.04), 0.42, z);
    w.castShadow = true;
    group.add(w);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.46, 10), chrome);
    hub.rotation.z = Math.PI / 2;
    hub.position.copy(w.position);
    group.add(hub);
  }

  /* --- details ---------------------------------------------------- */
  // Front bumper + headlights.
  const bumper = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 1.05, 0.35, 0.3), chrome);
  bumper.position.set(0, 0.62, -bodyLen / 2 - 1.9);
  group.add(bumper);
  for (const x of [-0.95, 0.95]) {
    const hl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 0.1, 10),
      mat(0xfff4c0, 0.2, 0.1, { emissive: 0xffe680, emissiveIntensity: 0.9 }),
    );
    hl.rotation.x = Math.PI / 2;
    hl.position.set(x, 1.35, -bodyLen / 2 - 1.95);
    group.add(hl);
  }
  // Stop sign on the side.
  const sign = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.06, 8), mat(0xd0342c, 0.6));
  sign.rotation.set(Math.PI / 2, 0, Math.PI / 8);
  sign.position.set(-bodyW / 2 - 0.08, 2.0, -1.0);
  group.add(sign);

  /* --- balloon ---------------------------------------------------- */
  const balloonGroup = new THREE.Group();
  balloonGroup.name = 'balloon';

  const R = 7.2;
  const balloonGeo = new THREE.SphereGeometry(R, 28, 20);
  // Squash into the classic hot-air-balloon teardrop.
  const pos = balloonGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = (y + R) / (2 * R); // 0 bottom, 1 top
    const taper = 0.55 + 0.45 * Math.sin(k * Math.PI * 0.86 + 0.2);
    pos.setX(i, pos.getX(i) * taper);
    pos.setZ(i, pos.getZ(i) * taper);
    pos.setY(i, y * 1.12 + R * 0.18);
  }
  balloonGeo.computeVertexNormals();

  // Blue and white vertical stripes, built as alternating gore panels.
  const balloonWhite = new THREE.Mesh(balloonGeo, mat(0xf5f7fa, 0.72, 0.0));
  balloonWhite.castShadow = true;
  balloonGroup.add(balloonWhite);

  const stripeCount = 10;
  for (let i = 0; i < stripeCount; i += 2) {
    const a0 = (i / stripeCount) * Math.PI * 2;
    const seg = new THREE.SphereGeometry(R * 1.005, 8, 20, a0, (Math.PI * 2) / stripeCount);
    const sp = seg.attributes.position;
    for (let v = 0; v < sp.count; v++) {
      const y = sp.getY(v);
      const k = (y + R) / (2 * R);
      const taper = 0.55 + 0.45 * Math.sin(k * Math.PI * 0.86 + 0.2);
      sp.setX(v, sp.getX(v) * taper);
      sp.setZ(v, sp.getZ(v) * taper);
      sp.setY(v, y * 1.12 + R * 0.18);
    }
    seg.computeVertexNormals();
    const stripe = new THREE.Mesh(seg, mat(0x2f6fd0, 0.7, 0.0));
    balloonGroup.add(stripe);
  }

  // Balloon skirt / burner ring.
  const ring = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.28, 8, 20), mat(0xd94f2a, 0.6));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -R * 0.72;
  balloonGroup.add(ring);

  balloonGroup.position.y = 13.5;
  group.add(balloonGroup);

  /* --- tethers ---------------------------------------------------- */
  const ropeMat = mat(0x4a4a52, 0.9, 0.0);
  for (const [x, z] of [[-1.2, -4.5], [1.2, -4.5], [-1.2, 4.5], [1.2, 4.5]]) {
    const len = 8.0;
    const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, len, 6), ropeMat);
    rope.position.set(x * 0.9, 3.6 + len / 2, z * 0.55);
    // Angle the ropes inward toward the balloon skirt.
    rope.rotation.x = Math.atan2(-z * 0.45, len) * 0.6;
    rope.rotation.z = Math.atan2(x * 0.35, len) * 0.6;
    group.add(rope);
  }

  return group;
}

/* ------------------------------------------------------------------ */
/* Bus system                                                          */
/* ------------------------------------------------------------------ */

export const BusState = {
  IDLE: 'idle',
  FLYING: 'flying',
  FINISHED: 'finished',
};

export class BattleBus {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts { rng }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.rng = opts.rng || Math.random;

    this.mesh = buildBus();
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.state = BusState.IDLE;
    this.progress = 0;      // 0..1 along the route
    this.speed = BUS_SPEED;
    this.altitude = BUS_ALTITUDE;

    this.start = new THREE.Vector3();
    this.end = new THREE.Vector3();
    this.position = new THREE.Vector3();
    this.direction = new THREE.Vector3();
    this.routeLength = 0;

    this._engineLoop = null;
    this._hornPlayed = false;

    this.generateRoute();
  }

  /**
   * Pick a random diagonal across the island. The route always passes near
   * the centre so every named location is a plausible drop.
   */
  generateRoute() {
    const half = mapConfig.halfSize;

    // Random entry angle; the route is a chord through a point near centre.
    const angle = this.rng() * Math.PI * 2;
    // Offset the chord from dead-centre so routes vary.
    const offset = (this.rng() - 0.5) * half * 0.65;

    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    // Perpendicular offset.
    const perpX = -dirZ * offset;
    const perpZ = dirX * offset;

    const reach = half + ROUTE_MARGIN;
    this.start.set(perpX - dirX * reach, this.altitude, perpZ - dirZ * reach);
    this.end.set(perpX + dirX * reach, this.altitude, perpZ + dirZ * reach);

    this.direction.copy(this.end).sub(this.start).normalize();
    this.routeLength = this.start.distanceTo(this.end);
    this.duration = this.routeLength / this.speed;

    this.position.copy(this.start);
    this.progress = 0;

    return { start: this.start.clone(), end: this.end.clone() };
  }

  /** Launch the bus. */
  launch() {
    this.state = BusState.FLYING;
    this.progress = 0;
    this.mesh.visible = true;
    this._hornPlayed = false;

    audio.play('bus.horn', { volume: 0.75, bus: 'ui' });
    this._engineLoop = audio.loop('bus.engine', {
      key: 'bus.engine', volume: 0.4, bus: 'ambient',
    });
  }

  /** How long until the bus reaches the end of its route. */
  get timeRemaining() {
    return Math.max(0, (1 - this.progress) * this.duration);
  }

  get isFlying() {
    return this.state === BusState.FLYING;
  }

  update(dt) {
    if (this.state !== BusState.FLYING) return;

    this.progress += (this.speed * dt) / this.routeLength;

    if (this.progress >= 1) {
      this.progress = 1;
      this.state = BusState.FINISHED;
      this.mesh.visible = false;
      this._engineLoop?.stop(1.0);
      this._engineLoop = null;
    }

    this.position.lerpVectors(this.start, this.end, this.progress);

    // Gentle bob so the bus feels airborne rather than on rails.
    const bob = Math.sin(this.progress * this.routeLength * 0.012) * 1.8;
    this.mesh.position.set(this.position.x, this.position.y + bob, this.position.z);

    // Face along the route, with a slight roll into the drift.
    this.mesh.rotation.y = Math.atan2(this.direction.x, this.direction.z) + Math.PI;
    this.mesh.rotation.z = Math.sin(this.progress * 6.0) * 0.02;

    // Balloon sways.
    const balloon = this.mesh.getObjectByName('balloon');
    if (balloon) {
      balloon.rotation.z = Math.sin(this.progress * 9.0) * 0.035;
      balloon.rotation.x = Math.cos(this.progress * 7.0) * 0.025;
    }

    if (this._engineLoop) {
      this._engineLoop.setPosition(this.mesh.position);
    }
  }

  /** Position on the route at a given progress value (for previews). */
  getPositionAt(t) {
    return new THREE.Vector3().lerpVectors(this.start, this.end, THREE.MathUtils.clamp(t, 0, 1));
  }

  /**
   * Where a passenger stands relative to the bus (used to place the
   * player/bots while riding, and as the jump-off point).
   */
  getJumpPosition() {
    return new THREE.Vector3(
      this.mesh.position.x,
      this.mesh.position.y - 2.0,
      this.mesh.position.z,
    );
  }

  /** Route as 2D points for the map overlay. */
  getRouteLine() {
    return {
      from: { x: this.start.x, z: this.start.z },
      to: { x: this.end.x, z: this.end.z },
      progress: this.progress,
      current: { x: this.position.x, z: this.position.z },
    };
  }

  reset() {
    this.state = BusState.IDLE;
    this.mesh.visible = false;
    this._engineLoop?.stop(0.2);
    this._engineLoop = null;
    this.generateRoute();
  }

  dispose() {
    this.scene.remove(this.mesh);
    this._engineLoop?.stop(0.1);
  }
}

export default BattleBus;
