/**
 * systems.test.js — Storm phases/damage, bus routing, skydive physics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../client/js/engine/audio.js', () => ({
  default: {
    ready: false,
    play: () => null,
    loop: () => ({ stop() {}, setVolume() {}, setPosition() {}, setRate() {} }),
    getLoop: () => null,
    playShot: () => null,
  },
}));

import * as THREE from 'three';
import stormConfig from '../client/js/config/storm-phases.json';
import mapConfig from '../client/js/config/map.json';
import Storm, { StormPhaseState } from '../client/js/systems/storm.js';
import BattleBus, { BUS_ALTITUDE, BusState } from '../client/js/systems/bus.js';
import { SkydiveController, SkydiveState, SKYDIVE } from '../client/js/player/skydive.js';

const makeScene = () => new THREE.Scene();

/** Deterministic RNG so circle placement is reproducible. */
function seededRng(seed = 12345) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ================================================================== */

describe('storm configuration', () => {
  it('has at least 6 shrink phases plus a prep phase', () => {
    expect(stormConfig.phases.length).toBeGreaterThanOrEqual(7);
  });

  it('shrinks monotonically to zero', () => {
    const factors = stormConfig.phases.map((p) => p.radiusFactor);
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]).toBeLessThan(factors[i - 1]);
    }
    expect(factors[factors.length - 1]).toBe(0);
  });

  it('escalates damage and never deals zero after the first phases', () => {
    const dmg = stormConfig.phases.map((p) => p.damage);
    for (let i = 1; i < dmg.length; i++) {
      expect(dmg[i]).toBeGreaterThanOrEqual(dmg[i - 1]);
    }
    expect(dmg[dmg.length - 1]).toBeGreaterThanOrEqual(10);
  });

  it('runs a full match in a reasonable time (15-25 min)', () => {
    const total = stormConfig.phases.reduce((s, p) => s + p.waitTime + p.shrinkTime, 0);
    expect(total).toBeGreaterThan(15 * 60);
    expect(total).toBeLessThan(25 * 60);
  });
});

describe('storm simulation', () => {
  let scene, storm;
  beforeEach(() => {
    scene = makeScene();
    storm = new Storm(scene, { rng: seededRng(7) });
  });

  it('adds a real 3D mesh to the scene (TRAP-05)', () => {
    const wall = scene.getObjectByName('StormWall');
    expect(wall).toBeTruthy();
    expect(wall.geometry.type).toBe('CylinderGeometry');
    // Must be tall enough to be a wall, not a flat ring.
    expect(stormConfig.visual.wallHeight).toBeGreaterThanOrEqual(300);
  });

  it('starts at full radius covering the island', () => {
    expect(storm.radius).toBe(stormConfig.initialRadius);
    expect(storm.radius * 2).toBeGreaterThanOrEqual(mapConfig.worldSize * 0.7);
  });

  it('does not shrink during the initial wait', () => {
    const r0 = storm.radius;
    for (let i = 0; i < 100; i++) storm.update(0.1);
    expect(storm.radius).toBe(r0);
    expect(storm.phaseState).toBe(StormPhaseState.WAITING);
  });

  it('shrinks after the wait expires', () => {
    const r0 = storm.radius;
    // Run past phase 0's wait time.
    for (let i = 0; i < 3000; i++) storm.update(0.1);
    expect(storm.radius).toBeLessThan(r0);
  });

  it('keeps each new circle inside the previous one', () => {
    for (let phase = 0; phase < 6; phase++) {
      const prevC = storm.center.clone();
      const prevR = storm.radius;
      const nextC = storm.nextCenter.clone();
      const nextR = storm.nextRadius;
      const dist = prevC.distanceTo(nextC);
      // Containment: distance between centres + new radius <= old radius.
      expect(dist + nextR).toBeLessThanOrEqual(prevR + 1e-6);
      // Advance a whole phase.
      for (let i = 0; i < 6000; i++) {
        storm.update(0.2);
        if (storm.phaseIndex > phase) break;
      }
    }
  });

  it('deals damage inside the storm and none inside the safe zone', () => {
    // Advance to a phase with damage.
    for (let i = 0; i < 8000; i++) storm.update(0.2);
    expect(storm.damagePerSecond).toBeGreaterThan(0);

    const outside = { x: storm.center.x + storm.radius + 200, z: storm.center.y };
    expect(storm.isInStorm(outside.x, outside.z)).toBe(true);
    expect(storm.computeDamage(outside.x, outside.z, 1)).toBeCloseTo(storm.damagePerSecond);

    expect(storm.isInStorm(storm.center.x, storm.center.y)).toBe(false);
    expect(storm.computeDamage(storm.center.x, storm.center.y, 1)).toBe(0);
  });

  it('reports a safe point that is actually inside the circle', () => {
    const far = { x: storm.center.x + storm.radius * 3, z: storm.center.y + 100 };
    const safe = storm.getSafePoint(far.x, far.z, 60);
    expect(storm.isInStorm(safe.x, safe.z)).toBe(false);
    const d = Math.hypot(safe.x - storm.center.x, safe.z - storm.center.y);
    expect(d).toBeLessThanOrEqual(storm.radius - 59);
  });

  it('leaves points already inside untouched', () => {
    const p = storm.getSafePoint(storm.center.x + 5, storm.center.y + 5);
    expect(p.x).toBeCloseTo(storm.center.x + 5);
  });

  it('scales intensity with depth into the storm', () => {
    const edge = storm.radius + 5;
    const deep = storm.radius + 400;
    const a = storm.stormIntensity(edge, 0);
    const b = storm.stormIntensity(deep, 0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThanOrEqual(1);
  });

  it('eventually closes to a zero-radius final circle', () => {
    for (let i = 0; i < 200000; i++) {
      storm.update(0.2);
      if (storm.finished || storm.radius < 5) break;
    }
    expect(storm.radius).toBeLessThan(30);
  });
});

/* ================================================================== */

describe('battle bus', () => {
  let scene, bus;
  beforeEach(() => {
    scene = makeScene();
    bus = new BattleBus(scene, { rng: seededRng(99) });
  });

  it('builds a bus with a balloon', () => {
    expect(scene.getObjectByName('BattleBus')).toBeTruthy();
    expect(bus.mesh.getObjectByName('balloon')).toBeTruthy();
  });

  it('flies at the correct altitude', () => {
    expect(bus.start.y).toBe(BUS_ALTITUDE);
    expect(bus.end.y).toBe(BUS_ALTITUDE);
  });

  it('crosses the entire island', () => {
    const half = mapConfig.halfSize;
    expect(bus.routeLength).toBeGreaterThan(half * 2);
  });

  it('takes a sane amount of time to cross', () => {
    expect(bus.duration).toBeGreaterThan(8);
    expect(bus.duration).toBeLessThan(40);
  });

  it('produces a different route each match', () => {
    const a = new BattleBus(makeScene(), { rng: seededRng(1) });
    const b = new BattleBus(makeScene(), { rng: seededRng(2) });
    expect(a.start.distanceTo(b.start)).toBeGreaterThan(50);
  });

  it('passes within drop range of the island centre', () => {
    // Distance from origin to the route line must be less than the map half.
    for (let seed = 1; seed <= 20; seed++) {
      const b = new BattleBus(makeScene(), { rng: seededRng(seed * 137) });
      const d = new THREE.Line3(b.start, b.end).closestPointToPoint(
        new THREE.Vector3(0, BUS_ALTITUDE, 0), true, new THREE.Vector3(),
      ).length();
      expect(d).toBeLessThan(mapConfig.halfSize);
    }
  });

  it('travels the route and finishes', () => {
    bus.launch();
    expect(bus.state).toBe(BusState.FLYING);
    for (let i = 0; i < 2000; i++) bus.update(1 / 60);
    expect(bus.state).toBe(BusState.FINISHED);
    expect(bus.progress).toBe(1);
  });

  it('moves monotonically along the route', () => {
    bus.launch();
    let last = -1;
    for (let i = 0; i < 200; i++) {
      bus.update(1 / 60);
      const t = bus.start.distanceTo(bus.position);
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });
});

/* ================================================================== */

describe('skydive physics', () => {
  const GROUND = 40;
  let sky;

  beforeEach(() => {
    sky = new SkydiveController({
      scene: makeScene(),
      getGroundHeight: () => GROUND,
    });
  });

  const jump = (y = 200) => {
    sky.jump(new THREE.Vector3(0, y, 0), new THREE.Vector3(0, 0, -1));
  };

  const input = (o = {}) => ({ forward: 0, right: 0, yaw: 0, pitch: 0, ...o });

  it('starts in the bus', () => {
    expect(sky.state).toBe(SkydiveState.IN_BUS);
  });

  it('enters freefall on jump', () => {
    jump();
    expect(sky.state).toBe(SkydiveState.FREEFALL);
    expect(sky.isAirborne).toBe(true);
  });

  it('reaches terminal velocity in freefall', () => {
    jump(3000);
    for (let i = 0; i < 600; i++) sky.update(1 / 60, input());
    expect(Math.abs(sky.velocity.y)).toBeGreaterThan(SKYDIVE.freefallTerminal * 0.9);
    expect(Math.abs(sky.velocity.y)).toBeLessThanOrEqual(SKYDIVE.freefallDiveMax + 1);
  });

  it('dives faster when looking straight down', () => {
    jump(5000);
    for (let i = 0; i < 400; i++) sky.update(1 / 60, input({ pitch: -Math.PI / 2, forward: 1 }));
    const diveSpeed = Math.abs(sky.velocity.y);

    const sky2 = new SkydiveController({ scene: makeScene(), getGroundHeight: () => GROUND });
    sky2.jump(new THREE.Vector3(0, 5000, 0), new THREE.Vector3(0, 0, -1));
    for (let i = 0; i < 400; i++) sky2.update(1 / 60, input({ pitch: 0 }));
    expect(diveSpeed).toBeGreaterThan(Math.abs(sky2.velocity.y));
  });

  it('gains horizontal speed when holding forward level', () => {
    jump(3000);
    for (let i = 0; i < 200; i++) sky.update(1 / 60, input({ forward: 1, pitch: 0 }));
    expect(sky.horizontalSpeed).toBeGreaterThan(20);
  });

  it('auto-deploys the glider before hitting the ground (TRAP)', () => {
    jump(GROUND + 400);
    let deployedAt = null;
    sky.onDeploy = () => { deployedAt = sky.altitudeAboveGround; };
    for (let i = 0; i < 4000; i++) {
      sky.update(1 / 60, input());
      if (sky.state === SkydiveState.LANDED) break;
    }
    expect(deployedAt).not.toBeNull();
    expect(deployedAt).toBeLessThanOrEqual(SKYDIVE.gliderDeployHeight + 5);
    expect(deployedAt).toBeGreaterThan(0);
  });

  it('descends much slower under the glider', () => {
    jump(3000);
    for (let i = 0; i < 300; i++) sky.update(1 / 60, input());
    const freefallRate = Math.abs(sky.velocity.y);
    sky.deployGlider();
    for (let i = 0; i < 200; i++) sky.update(1 / 60, input());
    expect(Math.abs(sky.velocity.y)).toBeLessThan(freefallRate * 0.5);
    expect(Math.abs(sky.velocity.y)).toBeCloseTo(SKYDIVE.gliderDescent, 0);
  });

  it('shows the glider mesh only while gliding', () => {
    jump(3000);
    expect(sky.gliderMesh.visible).toBe(false);
    sky.deployGlider();
    expect(sky.gliderMesh.visible).toBe(true);
  });

  it('cannot deploy twice', () => {
    jump(3000);
    expect(sky.deployGlider()).toBe(true);
    expect(sky.deployGlider()).toBe(false);
  });

  it('lands exactly on the ground and stops', () => {
    jump(GROUND + 300);
    for (let i = 0; i < 6000; i++) {
      sky.update(1 / 60, input());
      if (sky.state === SkydiveState.LANDED) break;
    }
    expect(sky.state).toBe(SkydiveState.LANDED);
    expect(sky.position.y).toBeCloseTo(GROUND, 5);
    expect(sky.velocity.length()).toBe(0);
  });

  it('fires the land callback once', () => {
    jump(GROUND + 200);
    let calls = 0;
    sky.onLand = () => calls++;
    for (let i = 0; i < 6000; i++) sky.update(1 / 60, input());
    expect(calls).toBe(1);
  });

  it('a full drop from bus altitude takes 20-60s', () => {
    sky.jump(new THREE.Vector3(0, BUS_ALTITUDE + 500, 0), new THREE.Vector3(0, 0, -1));
    let t = 0;
    for (let i = 0; i < 20000; i++) {
      sky.update(1 / 60, input({ forward: 1, pitch: -0.5 }));
      t += 1 / 60;
      if (sky.state === SkydiveState.LANDED) break;
    }
    expect(t).toBeGreaterThan(5);
    expect(t).toBeLessThan(60);
  });

  it('predicts a landing spot ahead of the player', () => {
    jump(1000);
    for (let i = 0; i < 120; i++) sky.update(1 / 60, input({ forward: 1 }));
    const p = sky.predictLanding();
    expect(p).not.toBeNull();
    expect(p.y).toBeCloseTo(GROUND, 3);
  });
});
