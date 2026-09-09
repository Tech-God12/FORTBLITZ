/**
 * weapons.test.js — Weapon config integrity, fire modes, reload, ballistics.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The Weapon class plays audio; stub the engine so tests run headless.
vi.mock('../client/js/engine/audio.js', () => ({
  default: { play: () => null, loop: () => null, playShot: () => null },
}));

import weaponsConfig from '../client/js/config/weapons.json';
import Weapon, {
  WEAPONS_BY_ID, RARITY_ORDER, allWeaponVariants, WeaponState, getRarityColor,
} from '../client/js/weapons/weapon-base.js';
import {
  damageFalloff, computeDamage, raycastCapsule, applySpread, Bullet, BallisticsSystem,
} from '../client/js/weapons/ballistics.js';
import * as THREE from 'three';

/* ------------------------------------------------------------------ */

describe('weapon roster completeness', () => {
  it('covers every OG Chapter 1 category', () => {
    const families = new Set(weaponsConfig.weapons.map((w) => w.family));
    expect(families).toContain('ar');
    expect(families).toContain('shotgun');
    expect(families).toContain('smg');
    expect(families).toContain('sniper');
    expect(families).toContain('pistol');
    expect(families).toContain('explosive');
  });

  it('has all 13 required weapons', () => {
    const ids = weaponsConfig.weapons.map((w) => w.id);
    for (const required of [
      'scar', 'm16', 'suppressed_ar', 'pump', 'tactical_shotgun',
      'tactical_smg', 'minigun', 'bolt_sniper', 'semi_sniper',
      'hand_cannon', 'pistol', 'grenade_launcher', 'rpg',
    ]) {
      expect(ids).toContain(required);
    }
    expect(ids.length).toBe(13);
  });

  it('has the 3 tactical throwables and 6 healing items', () => {
    const t = weaponsConfig.throwables.map((x) => x.id);
    expect(t).toEqual(expect.arrayContaining(['frag_grenade', 'clinger', 'boogie_bomb']));
    const c = weaponsConfig.consumables.map((x) => x.id);
    expect(c).toEqual(expect.arrayContaining([
      'medkit', 'bandage', 'shield_potion', 'mini_shield', 'slurp_juice', 'chug_jug',
    ]));
  });

  it('matches OG healing values exactly', () => {
    const by = Object.fromEntries(weaponsConfig.consumables.map((c) => [c.id, c]));
    expect(by.medkit).toMatchObject({ heal: 100, useTime: 10, target: 'health' });
    expect(by.bandage).toMatchObject({ heal: 15, healCap: 75, useTime: 4 });
    expect(by.shield_potion).toMatchObject({ heal: 50, healCap: 100, useTime: 5 });
    expect(by.mini_shield).toMatchObject({ heal: 25, healCap: 50, useTime: 2 });
    expect(by.slurp_juice).toMatchObject({ heal: 75, duration: 25, tickRate: 1 });
    expect(by.chug_jug).toMatchObject({ heal: 100, useTime: 15, target: 'both' });
  });

  it('assigns every weapon a valid ammo type', () => {
    const types = Object.keys(weaponsConfig.ammoTypes);
    for (const w of weaponsConfig.weapons) expect(types).toContain(w.ammo);
  });

  it('uses only valid rarity keys and orders damage by rarity', () => {
    for (const w of weaponsConfig.weapons) {
      const rs = Object.keys(w.rarities);
      for (const r of rs) expect(RARITY_ORDER).toContain(r);
      // Higher rarity must never do less damage.
      const sorted = rs.sort((a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b));
      for (let i = 1; i < sorted.length; i++) {
        expect(w.rarities[sorted[i]].damage).toBeGreaterThanOrEqual(w.rarities[sorted[i - 1]].damage);
      }
    }
  });

  it('makes rarer variants rarer (lower spawn weight)', () => {
    for (const w of weaponsConfig.weapons) {
      const rs = Object.keys(w.rarities).sort(
        (a, b) => RARITY_ORDER.indexOf(a) - RARITY_ORDER.indexOf(b),
      );
      for (let i = 1; i < rs.length; i++) {
        expect(w.rarities[rs[i]].weight).toBeLessThan(w.rarities[rs[i - 1]].weight);
      }
    }
  });

  it('exposes 35 spawnable weapon variants', () => {
    expect(allWeaponVariants().length).toBe(35);
  });

  it('maps rarities to the correct Fortnite colours', () => {
    expect(getRarityColor('legendary').toLowerCase()).toBe('#ffc93a');
    expect(getRarityColor('epic').toLowerCase()).toBe('#b14cff');
    expect(getRarityColor('rare').toLowerCase()).toBe('#3a7bff');
    expect(getRarityColor('uncommon').toLowerCase()).toBe('#4cd137');
    expect(getRarityColor('common').toLowerCase()).toBe('#9e9e9e');
  });

  it('gives no two weapons an identical stat profile (TRAP-09)', () => {
    const sigs = weaponsConfig.weapons.map((w) =>
      [w.fireMode, w.magSize, w.rpm, w.reloadTime, w.range, w.ammo].join('|'),
    );
    expect(new Set(sigs).size).toBe(sigs.length);
  });
});

/* ------------------------------------------------------------------ */

describe('weapon fire modes', () => {
  let t;
  const ctx = (over = {}) => ({ time: t, reserve: 200, ads: false, moving: false, crouching: false, ...over });

  beforeEach(() => { t = 100; });

  it('auto weapons fire repeatedly while held', () => {
    const w = new Weapon('scar', 'legendary');
    w.state = WeaponState.READY;
    w.setTrigger(true);
    let shots = 0;
    for (let i = 0; i < 60; i++) {
      if (w.tryFire(ctx())) shots++;
      t += 1 / 60;
      w.update(1 / 60, ctx());
    }
    // 198 RPM over 1 second ~= 3 shots.
    expect(shots).toBeGreaterThanOrEqual(3);
    expect(shots).toBeLessThanOrEqual(5);
  });

  it('semi weapons need a fresh trigger pull per shot', () => {
    const w = new Weapon('pistol', 'common');
    w.state = WeaponState.READY;
    w.setTrigger(true);
    expect(w.tryFire(ctx())).toBeTruthy();
    w.update(1 / 60, ctx());
    t += 1;
    // Trigger still held -> no shot.
    expect(w.tryFire(ctx())).toBeNull();
    // Release and pull again.
    w.setTrigger(false);
    w.update(1 / 60, ctx());
    w.setTrigger(true);
    expect(w.tryFire(ctx())).toBeTruthy();
  });

  it('burst weapons fire exactly 3 rounds per pull', () => {
    const w = new Weapon('m16', 'rare');
    w.state = WeaponState.READY;
    w.setTrigger(true);
    let shots = 0;
    for (let i = 0; i < 40; i++) {
      if (w.tryFire(ctx())) shots++;
      t += 1 / 120;
      w.update(1 / 120, ctx());
    }
    expect(shots).toBe(3);
  });

  it('pump shotgun enters a cycling state after each shot', () => {
    const w = new Weapon('pump', 'rare');
    w.state = WeaponState.READY;
    w.setTrigger(true);
    expect(w.tryFire(ctx())).toBeTruthy();
    expect(w.state).toBe(WeaponState.CYCLING);
    expect(w.canFire).toBe(false);
    // Cycle finishes after pumpTime.
    for (let i = 0; i < 60; i++) w.update(0.02, ctx());
    expect(w.state).toBe(WeaponState.READY);
  });

  it('bolt sniper cycles for boltTime and holds one round', () => {
    const w = new Weapon('bolt_sniper', 'epic');
    expect(w.magSize).toBe(1);
    w.state = WeaponState.READY;
    w.setTrigger(true);
    expect(w.tryFire(ctx())).toBeTruthy();
    expect(w.ammo).toBe(0);
    expect(w.state).toBe(WeaponState.CYCLING);
  });

  it('refuses to fire when empty and reports empty state', () => {
    const w = new Weapon('pistol', 'common', { ammo: 1 });
    w.state = WeaponState.READY;
    w.setTrigger(true);
    expect(w.tryFire(ctx())).toBeTruthy();
    w.setTrigger(false);
    w.update(0.5, ctx());
    w.setTrigger(true);
    t += 1;
    expect(w.tryFire(ctx())).toBeNull();
    expect(w.isEmpty).toBe(true);
  });

  it('minigun requires spin-up and overheats', () => {
    const w = new Weapon('minigun', 'legendary');
    w.state = WeaponState.READY;
    w.setTrigger(true);
    // No spin yet -> cannot fire.
    expect(w.tryFire(ctx())).toBeNull();
    for (let i = 0; i < 60; i++) w.update(1 / 60, ctx());
    expect(w.spinUp).toBeCloseTo(w.def.spinUpTime, 1);
    // Now it fires.
    expect(w.tryFire(ctx())).toBeTruthy();
    // Force overheat.
    w.heat = w.def.overheatTime;
    t += 1;
    w.setTrigger(true);
    w.tryFire(ctx());
    w.update(0.01, ctx());
    expect(w.overheated || w.state === WeaponState.OVERHEATED).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('reloading', () => {
  const ctx = (reserve = 90) => ({ time: 0, reserve });

  it('refills the magazine from reserve after reloadTime', () => {
    const w = new Weapon('scar', 'epic', { ammo: 5 });
    w.state = WeaponState.READY;
    expect(w.startReload(90)).toBe(true);
    let consumed = 0;
    for (let i = 0; i < 200; i++) consumed += w.update(0.02, ctx()).ammoConsumed;
    expect(w.ammo).toBe(30);
    expect(consumed).toBe(25);
    expect(w.state).toBe(WeaponState.READY);
  });

  it('will not reload a full magazine or with no reserve', () => {
    const full = new Weapon('scar', 'epic');
    expect(full.startReload(90)).toBe(false);
    const dry = new Weapon('scar', 'epic', { ammo: 0 });
    expect(dry.startReload(0)).toBe(false);
  });

  it('shotguns load shell by shell', () => {
    const w = new Weapon('pump', 'rare', { ammo: 0 });
    w.state = WeaponState.READY;
    w.startReload(20);
    // After one shell interval only one shell is in.
    let consumed = 0;
    for (let i = 0; i < 40; i++) consumed += w.update(0.02, ctx(20)).ammoConsumed;
    expect(w.ammo).toBeGreaterThan(0);
    expect(w.ammo).toBeLessThanOrEqual(5);
    expect(consumed).toBe(w.ammo);
  });

  it('a reload can be cancelled', () => {
    const w = new Weapon('scar', 'epic', { ammo: 2 });
    w.state = WeaponState.READY;
    w.startReload(90);
    expect(w.isReloading).toBe(true);
    expect(w.cancelReload()).toBe(true);
    expect(w.ammo).toBe(2);
  });

  it('cannot fire while reloading', () => {
    const w = new Weapon('scar', 'epic', { ammo: 2 });
    w.state = WeaponState.READY;
    w.startReload(90);
    w.setTrigger(true);
    expect(w.canFire).toBe(false);
    expect(w.tryFire({ time: 5, reserve: 90 })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe('recoil and bloom', () => {
  it('accumulates bloom while firing and decays when stopped', () => {
    const w = new Weapon('scar', 'legendary');
    w.state = WeaponState.READY;
    w.setTrigger(true);
    let t = 0;
    for (let i = 0; i < 40; i++) {
      w.tryFire({ time: t, reserve: 100 });
      t += 1 / 60;
      w.update(1 / 60, { time: t, reserve: 100 });
    }
    const peak = w.bloom;
    expect(peak).toBeGreaterThan(0);
    w.setTrigger(false);
    for (let i = 0; i < 60; i++) w.update(1 / 60, { time: t, reserve: 100 });
    expect(w.bloom).toBeLessThan(peak);
    expect(w.bloom).toBe(0);
  });

  it('never exceeds maxBloom', () => {
    const w = new Weapon('tactical_smg', 'rare');
    w.state = WeaponState.READY;
    w.setTrigger(true);
    let t = 0;
    for (let i = 0; i < 400; i++) {
      w.ammo = 35; // keep it fed
      w.tryFire({ time: t, reserve: 999 });
      t += 1 / 120;
      w.update(1 / 120, { time: t, reserve: 999 });
    }
    expect(w.bloom).toBeLessThanOrEqual(w.def.spread.maxBloom + 1e-6);
  });

  it('recoil recovers toward zero', () => {
    const w = new Weapon('hand_cannon', 'legendary');
    w.state = WeaponState.READY;
    w.setTrigger(true);
    w.tryFire({ time: 0, reserve: 30 });
    w.update(1 / 60, { time: 0.02, reserve: 30 });
    const kick = Math.abs(w.recoilPitch) + Math.abs(w.recoilVelPitch);
    expect(kick).toBeGreaterThan(0);
    for (let i = 0; i < 240; i++) w.update(1 / 60, { time: 5, reserve: 30 });
    expect(Math.abs(w.recoilPitch)).toBeLessThan(0.05);
  });

  it('ADS is tighter than hip fire for every weapon', () => {
    for (const def of weaponsConfig.weapons) {
      if (!def.spread) continue;
      expect(def.spread.ads).toBeLessThanOrEqual(def.spread.hip);
    }
  });
});

/* ------------------------------------------------------------------ */

describe('ballistics', () => {
  it('shotguns fall off hard, snipers do not fall off', () => {
    const pump = WEAPONS_BY_ID.get('pump');
    expect(damageFalloff(pump, 5)).toBe(1);
    expect(damageFalloff(pump, 30)).toBeCloseTo(pump.falloffMin);
    expect(damageFalloff(pump, 15)).toBeLessThan(1);

    const sniper = WEAPONS_BY_ID.get('bolt_sniper');
    expect(damageFalloff(sniper, 10)).toBe(1);
    expect(damageFalloff(sniper, 300)).toBe(1);
  });

  it('applies headshot multipliers', () => {
    const scar = WEAPONS_BY_ID.get('scar');
    const body = computeDamage(scar, 35, 10, 'body');
    const head = computeDamage(scar, 35, 10, 'head');
    expect(head).toBeCloseTo(body * 2);
  });

  it('pump shotgun can one-shot at close range on a headshot', () => {
    const pump = WEAPONS_BY_ID.get('pump');
    // 105 base * 2.1 headshot = 220 -> lethal through full shield+health.
    const dmg = computeDamage(pump, 105, 4, 'head');
    expect(dmg).toBeGreaterThanOrEqual(200);
  });

  it('bolt sniper headshot is lethal to a full-shield target', () => {
    const s = WEAPONS_BY_ID.get('bolt_sniper');
    const dmg = computeDamage(s, 116, 150, 'head');
    expect(dmg).toBeGreaterThanOrEqual(200);
  });

  it('capsule raycast detects head, body and leg zones', () => {
    const cap = { x: 0, y: 0, z: -10, radius: 0.45, height: 1.8 };
    const dir = new THREE.Vector3(0, 0, -1);

    const body = raycastCapsule({ x: 0, y: 1.0, z: 0 }, dir, cap, 50);
    expect(body?.zone).toBe('body');

    const head = raycastCapsule({ x: 0, y: 1.7, z: 0 }, dir, cap, 50);
    expect(head?.zone).toBe('head');

    const leg = raycastCapsule({ x: 0, y: 0.4, z: 0 }, dir, cap, 50);
    expect(leg?.zone).toBe('leg');

    const miss = raycastCapsule({ x: 5, y: 1.0, z: 0 }, dir, cap, 50);
    expect(miss).toBeNull();
  });

  it('spread stays inside the requested cone', () => {
    const dir = new THREE.Vector3(0, 0, -1);
    const deg = 5;
    for (let i = 0; i < 500; i++) {
      const out = applySpread(dir, deg);
      const angle = THREE.MathUtils.radToDeg(dir.angleTo(out));
      expect(angle).toBeLessThanOrEqual(deg + 0.01);
    }
  });

  it('zero spread returns the exact aim direction', () => {
    const dir = new THREE.Vector3(0, 0, -1);
    const out = applySpread(dir, 0);
    expect(out.z).toBeCloseTo(-1);
  });

  it('bullets travel at their configured speed', () => {
    const b = new Bullet({
      origin: new THREE.Vector3(0, 0, 0),
      direction: new THREE.Vector3(0, 0, -1),
      speed: 800, damage: 35,
      weapon: WEAPONS_BY_ID.get('scar'),
      shooterId: 'x',
    });
    b.step(0.1);
    expect(b.position.z).toBeCloseTo(-80, 0);
    expect(b.distanceTravelled).toBeCloseTo(80, 0);
  });

  it('sniper bullets do not drop within 300m', () => {
    const b = new Bullet({
      origin: new THREE.Vector3(0, 10, 0),
      direction: new THREE.Vector3(0, 0, -1),
      speed: 1600, damage: 110,
      weapon: WEAPONS_BY_ID.get('bolt_sniper'),
      shooterId: 'x',
    });
    for (let i = 0; i < 20; i++) b.step(1 / 120);
    expect(b.distanceTravelled).toBeGreaterThan(200);
    expect(b.position.y).toBeCloseTo(10, 3);
  });

  it('registers a character hit through the ballistics system', () => {
    const hits = [];
    const target = {
      id: 'bot1', dead: false,
      capsule: { x: 0, y: 0, z: -20, radius: 0.45, height: 1.8 },
    };
    const sys = new BallisticsSystem({
      getTargets: () => [target],
      getStructures: () => [],
      onHitCharacter: (h) => hits.push(h),
    });
    sys.fire({
      origin: new THREE.Vector3(0, 1.0, 0),
      direction: new THREE.Vector3(0, 0, -1),
      speed: 800, damage: 35,
      weapon: WEAPONS_BY_ID.get('scar'),
      shooterId: 'player',
    });
    for (let i = 0; i < 30; i++) sys.update(1 / 60);
    expect(hits.length).toBe(1);
    expect(hits[0].target.id).toBe('bot1');
    expect(hits[0].zone).toBe('body');
  });

  it('does not let a bullet hit its own shooter', () => {
    const hits = [];
    const shooter = { id: 'player', dead: false, capsule: { x: 0, y: 0, z: 0, radius: 0.45, height: 1.8 } };
    const sys = new BallisticsSystem({
      getTargets: () => [shooter],
      getStructures: () => [],
      onHitCharacter: (h) => hits.push(h),
    });
    sys.fire({
      origin: new THREE.Vector3(0, 1.0, 0),
      direction: new THREE.Vector3(0, 0, -1),
      speed: 800, damage: 35,
      weapon: WEAPONS_BY_ID.get('scar'), shooterId: 'player',
    });
    for (let i = 0; i < 10; i++) sys.update(1 / 60);
    expect(hits.length).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

describe('spawn rule', () => {
  it('the player spawn loadout contains zero weapons (TRAP-03)', async () => {
    const { createSpawnInventory } = await import('../client/js/player/inventory.js');
    const inv = createSpawnInventory();
    for (const slot of inv.slots) expect(slot).toBeNull();
    expect(inv.hasAnyWeapon()).toBe(false);
  });
});
