/**
 * weapon-base.js — The Weapon instance: state machine for every gun.
 *
 * One class drives all 13 weapons; behaviour differences come from the JSON
 * config (fire mode, timings, projectile type). This keeps every weapon
 * consistent while the DATA makes them feel distinct:
 *
 *   auto   — holds fire at rpm
 *   semi   — one shot per click
 *   burst  — 3 rounds at burstInterval, then burstCooldown
 *   pump   — fires, then a mandatory pump cycle before the next shot
 *   bolt   — fires, then a bolt cycle (with a distinct animation)
 *
 * Shell-reload weapons (shotguns) reload one shell at a time and can be
 * interrupted by firing — which is exactly how a real shotgun fight plays.
 */

import weaponsConfig from '../config/weapons.json' with { type: 'json' };
import audio from '../engine/audio.js';

/* ------------------------------------------------------------------ */
/* Config indexing                                                     */
/* ------------------------------------------------------------------ */

export const WEAPONS_BY_ID = new Map(weaponsConfig.weapons.map((w) => [w.id, w]));
export const THROWABLES_BY_ID = new Map(weaponsConfig.throwables.map((t) => [t.id, t]));
export const CONSUMABLES_BY_ID = new Map(weaponsConfig.consumables.map((c) => [c.id, c]));
export const RARITIES = weaponsConfig.rarities;
export const AMMO_TYPES = weaponsConfig.ammoTypes;

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** Every (weapon, rarity) pair that can spawn. */
export function allWeaponVariants() {
  const out = [];
  for (const w of weaponsConfig.weapons) {
    for (const [rarity, data] of Object.entries(w.rarities)) {
      out.push({ id: w.id, rarity, damage: data.damage, weight: data.weight, def: w });
    }
  }
  return out;
}

export function getWeaponDef(id) {
  return WEAPONS_BY_ID.get(id) || null;
}

export function getRarityColor(rarity) {
  return RARITIES[rarity]?.color || '#9E9E9E';
}

export function getRarityGlow(rarity) {
  return RARITIES[rarity]?.glow || '#808080';
}

/* ------------------------------------------------------------------ */
/* Weapon states                                                       */
/* ------------------------------------------------------------------ */

export const WeaponState = {
  READY: 'ready',
  FIRING: 'firing',
  CYCLING: 'cycling',   // pump / bolt action
  RELOADING: 'reloading',
  SWITCHING: 'switching',
  EMPTY: 'empty',
  OVERHEATED: 'overheated',
};

/* ------------------------------------------------------------------ */
/* Weapon                                                              */
/* ------------------------------------------------------------------ */

let _weaponSerial = 0;

export class Weapon {
  /**
   * @param {string} id      weapon id from weapons.json
   * @param {string} rarity  common|uncommon|rare|epic|legendary
   * @param {object} opts    { ammo, reserve }
   */
  constructor(id, rarity, opts = {}) {
    const def = WEAPONS_BY_ID.get(id);
    if (!def) throw new Error(`Weapon: unknown id "${id}"`);
    const rarityData = def.rarities[rarity];
    if (!rarityData) {
      // Fall back to the lowest available rarity rather than crashing.
      rarity = Object.keys(def.rarities)[0];
    }

    this.serial = ++_weaponSerial;
    this.id = id;
    this.def = def;
    this.rarity = rarity;
    this.damage = def.rarities[rarity].damage;

    this.name = def.name;
    this.class = def.class;
    this.family = def.family;
    this.ammoType = def.ammo;
    this.magSize = def.magSize;

    // Minigun has no magazine; it feeds from reserve directly.
    this.isBeltFed = def.magSize === 0;
    this.ammo = opts.ammo !== undefined ? opts.ammo : def.magSize;

    this.fireMode = def.fireMode;
    this.fireInterval = def.rpm > 0 ? 60 / def.rpm : 0.1;

    // --- runtime state ---
    this.state = WeaponState.READY;
    this.stateTime = 0;
    this.lastFireTime = -999;
    this.triggerHeld = false;
    this.triggerWasHeld = false;

    this.burstRemaining = 0;
    this.burstTimer = 0;

    this.reloadProgress = 0;
    this.reloadTotal = 0;
    this.shellsToLoad = 0;

    this.heat = 0;          // minigun
    this.spinUp = 0;        // minigun
    this.overheated = false;

    this.bloom = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilVelPitch = 0;
    this.recoilVelYaw = 0;
    this.shotIndex = 0;

    this.swayTime = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  get isEmpty() {
    return !this.isBeltFed && this.ammo <= 0;
  }

  get isReloading() {
    return this.state === WeaponState.RELOADING;
  }

  get isCycling() {
    return this.state === WeaponState.CYCLING;
  }

  get canFire() {
    if (this.state === WeaponState.RELOADING) return false;
    if (this.state === WeaponState.CYCLING) return false;
    if (this.state === WeaponState.SWITCHING) return false;
    if (this.overheated) return false;
    if (this.isEmpty) return false;
    return true;
  }

  get isScoped() {
    return !!this.def.scoped;
  }

  get adsFov() {
    return this.def.adsFov ?? 65;
  }

  get rarityColor() {
    return getRarityColor(this.rarity);
  }

  /** Ammo display string for the HUD. */
  getAmmoDisplay(reserve) {
    if (this.isBeltFed) return { mag: reserve, reserve: null };
    return { mag: this.ammo, reserve };
  }

  /* ---------------------------------------------------------------- */
  /* Firing                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Attempt to fire. Returns a shot descriptor or null.
   * @param {object} ctx { time, reserve, ads, moving, crouching, sprinting, airborne }
   */
  tryFire(ctx) {
    const now = ctx.time;

    // Burst continuation happens independently of the trigger.
    if (this.fireMode === 'burst' && this.burstRemaining > 0) {
      if (now - this.lastFireTime >= (this.def.burstInterval ?? 0.075)) {
        return this._doFire(ctx);
      }
      return null;
    }

    if (!this.triggerHeld) return null;
    if (!this.canFire) {
      // Dry fire click on an empty gun, once per trigger pull.
      if (this.isEmpty && !this.triggerWasHeld) {
        audio.play('weapon.dryfire', { volume: 0.4 });
      }
      return null;
    }

    // Semi/pump/bolt require a fresh trigger pull.
    const semiLike = ['semi', 'pump', 'bolt'].includes(this.fireMode);
    if (semiLike && this.triggerWasHeld) return null;

    // Rate of fire gate.
    if (now - this.lastFireTime < this.fireInterval) return null;

    // Minigun spin-up.
    if (this.def.spinUpTime) {
      if (this.spinUp < this.def.spinUpTime) return null;
    }

    if (this.fireMode === 'burst') {
      this.burstRemaining = this.def.burstCount ?? 3;
    }

    return this._doFire(ctx);
  }

  _doFire(ctx) {
    const def = this.def;

    // Consume ammo.
    if (this.isBeltFed) {
      if ((ctx.reserve ?? 0) <= 0) return null;
    } else {
      this.ammo--;
    }

    this.lastFireTime = ctx.time;
    this.shotIndex++;
    this.state = WeaponState.FIRING;

    if (this.fireMode === 'burst' && this.burstRemaining > 0) {
      this.burstRemaining--;
      if (this.burstRemaining === 0) {
        // Enforce the inter-burst cooldown.
        this.lastFireTime = ctx.time + (def.burstCooldown ?? 0.9) - this.fireInterval;
      }
    }

    // Pump / bolt cycle.
    if (this.fireMode === 'pump') {
      this.state = WeaponState.CYCLING;
      this.stateTime = def.pumpTime ?? 0.85;
    } else if (this.fireMode === 'bolt') {
      this.state = WeaponState.CYCLING;
      this.stateTime = def.boltTime ?? 1.2;
    }

    // Recoil impulse.
    this._applyRecoil();

    // Bloom.
    const s = def.spread;
    if (s) this.bloom = Math.min(s.maxBloom, this.bloom + s.bloomPerShot);

    // Heat.
    if (def.overheatTime) {
      this.heat += this.fireInterval;
      if (this.heat >= def.overheatTime) {
        this.overheated = true;
        this.state = WeaponState.OVERHEATED;
        this.stateTime = def.cooldownTime ?? 4.0;
      }
    }

    return {
      weapon: this,
      damage: this.damage,
      pellets: def.pellets ?? 1,
      spread: this._currentSpread(ctx),
      velocity: def.bulletVelocity ?? 800,
      projectile: def.projectile ?? null,
      suppressed: !!def.suppressed,
      shotIndex: this.shotIndex,
    };
  }

  _currentSpread(ctx) {
    const s = this.def.spread;
    if (!s) return 0;
    let spread = ctx.ads ? s.ads : s.hip;
    if (ctx.moving) spread += s.moving * (ctx.sprinting ? 1.5 : 1);
    if (ctx.crouching) spread += s.crouch;
    if (ctx.airborne) spread += s.hip * 1.4;
    return Math.max(0, spread + this.bloom);
  }

  _applyRecoil() {
    const r = this.def.recoil;
    if (!r) return;
    // Vertical climb with a horizontal wobble that alternates direction so
    // sustained fire draws a shallow zig-zag, not a straight line.
    const sign = (this.shotIndex % 2 === 0 ? 1 : -1) * (0.6 + Math.random() * 0.6);
    this.recoilVelPitch += r.vertical * (0.85 + Math.random() * 0.3);
    this.recoilVelYaw += r.horizontal * sign;
  }

  /* ---------------------------------------------------------------- */
  /* Reloading                                                         */
  /* ---------------------------------------------------------------- */

  /** Begin a reload. Returns true if one started. */
  startReload(reserve) {
    if (this.isBeltFed) return false;
    if (this.state === WeaponState.RELOADING) return false;
    if (this.ammo >= this.magSize) return false;
    if ((reserve ?? 0) <= 0) return false;
    if (this.state === WeaponState.CYCLING) return false;

    this.state = WeaponState.RELOADING;
    this.reloadTotal = this.def.reloadTime;
    this.reloadProgress = 0;

    if (this.def.shellReload) {
      // Shell-by-shell: each "reloadTime" loads one shell.
      this.shellsToLoad = Math.min(this.magSize - this.ammo, reserve);
    }

    audio.play('weapon.reload_start', { volume: 0.5, rate: 0.95 + Math.random() * 0.1 });
    return true;
  }

  /** Cancel a reload (shotguns can fire mid-reload). */
  cancelReload() {
    if (this.state !== WeaponState.RELOADING) return false;
    this.state = WeaponState.READY;
    this.reloadProgress = 0;
    this.shellsToLoad = 0;
    return true;
  }

  /**
   * Advance reload. Returns the number of rounds actually consumed from
   * reserve this frame so the inventory can deduct them.
   */
  _updateReload(dt, reserve) {
    this.reloadProgress += dt;
    let consumed = 0;

    if (this.def.shellReload) {
      // One shell per reloadTime interval.
      while (this.reloadProgress >= this.reloadTotal && this.shellsToLoad > 0 && this.ammo < this.magSize) {
        this.reloadProgress -= this.reloadTotal;
        this.ammo++;
        this.shellsToLoad--;
        consumed++;
        audio.play('weapon.reload_end', { volume: 0.35, rate: 1.1 + Math.random() * 0.15 });
      }
      if (this.shellsToLoad <= 0 || this.ammo >= this.magSize) {
        this.state = WeaponState.READY;
        this.reloadProgress = 0;
        audio.play('weapon.pump_rack', { volume: 0.45 });
      }
    } else if (this.reloadProgress >= this.reloadTotal) {
      const need = this.magSize - this.ammo;
      const take = Math.min(need, reserve);
      this.ammo += take;
      consumed = take;
      this.state = WeaponState.READY;
      this.reloadProgress = 0;
      audio.play('weapon.reload_end', { volume: 0.5 });
    }

    return consumed;
  }

  /* ---------------------------------------------------------------- */
  /* Frame update                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * @returns {object} { ammoConsumed } so the owner can update reserves.
   */
  update(dt, ctx = {}) {
    let ammoConsumed = 0;
    const def = this.def;

    // --- state timers ---
    if (this.state === WeaponState.CYCLING) {
      this.stateTime -= dt;
      if (this.stateTime <= 0) {
        this.state = this.isEmpty ? WeaponState.EMPTY : WeaponState.READY;
        // The pump/bolt sound lands at the END of the cycle.
        audio.play(this.fireMode === 'bolt' ? 'weapon.bolt_cycle' : 'weapon.pump_rack', {
          volume: 0.5, rate: 0.95 + Math.random() * 0.1,
        });
      }
    } else if (this.state === WeaponState.OVERHEATED) {
      this.stateTime -= dt;
      this.heat = Math.max(0, this.heat - dt * (def.overheatTime / (def.cooldownTime || 4)));
      if (this.stateTime <= 0) {
        this.overheated = false;
        this.heat = 0;
        this.state = WeaponState.READY;
      }
    } else if (this.state === WeaponState.RELOADING) {
      ammoConsumed = this._updateReload(dt, ctx.reserve ?? 0);
    } else if (this.state === WeaponState.SWITCHING) {
      this.stateTime -= dt;
      if (this.stateTime <= 0) this.state = WeaponState.READY;
    } else if (this.state === WeaponState.FIRING) {
      if (ctx.time - this.lastFireTime > this.fireInterval) {
        this.state = this.isEmpty ? WeaponState.EMPTY : WeaponState.READY;
      }
    }

    // --- minigun spin ---
    if (def.spinUpTime) {
      if (this.triggerHeld && !this.overheated) {
        this.spinUp = Math.min(def.spinUpTime, this.spinUp + dt);
      } else {
        this.spinUp = Math.max(0, this.spinUp - dt * 1.6);
        this.heat = Math.max(0, this.heat - dt * 1.2);
      }
    }

    // --- burst timer ---
    if (this.fireMode === 'burst' && this.burstRemaining > 0 && this.isEmpty) {
      this.burstRemaining = 0;
    }

    // --- bloom decay ---
    const s = def.spread;
    if (s) this.bloom = Math.max(0, this.bloom - s.decay * dt);

    // --- recoil recovery (spring toward zero) ---
    const r = def.recoil;
    if (r) {
      this.recoilPitch += this.recoilVelPitch * dt;
      this.recoilYaw += this.recoilVelYaw * dt;
      const recovery = r.recovery;
      this.recoilVelPitch -= this.recoilVelPitch * Math.min(1, recovery * dt);
      this.recoilVelYaw -= this.recoilVelYaw * Math.min(1, recovery * dt);
      this.recoilPitch -= this.recoilPitch * Math.min(1, recovery * 0.9 * dt);
      this.recoilYaw -= this.recoilYaw * Math.min(1, recovery * 0.9 * dt);
    }

    // --- scope sway ---
    if (def.swayAmplitude) this.swayTime += dt * (def.swaySpeed ?? 1);

    this.triggerWasHeld = this.triggerHeld;
    return { ammoConsumed };
  }

  /** Scope sway offset for sniper ADS. */
  getSway() {
    const a = this.def.swayAmplitude;
    if (!a) return { x: 0, y: 0 };
    const t = this.swayTime;
    return {
      x: Math.sin(t * 0.9) * a * 0.006 + Math.sin(t * 2.3) * a * 0.002,
      y: Math.cos(t * 0.7) * a * 0.005 + Math.cos(t * 1.9) * a * 0.0018,
    };
  }

  setTrigger(held) {
    this.triggerHeld = held;
  }

  /** Called when this weapon is equipped. */
  onEquip() {
    this.state = WeaponState.SWITCHING;
    // Heavier weapons take longer to bring up.
    const weight = { pistol: 0.28, smg: 0.36, shotgun: 0.45, 'assault-rifle': 0.42, sniper: 0.6, explosive: 0.66, heavy: 0.8 };
    this.stateTime = weight[this.class] ?? 0.4;
    this.burstRemaining = 0;
    this.bloom = 0;
    this.spinUp = 0;
    audio.play('weapon.switch', { volume: 0.4 });
    return this.stateTime;
  }

  onUnequip() {
    this.cancelReload();
    this.triggerHeld = false;
    this.burstRemaining = 0;
  }

  toJSON() {
    return { id: this.id, rarity: this.rarity, ammo: this.ammo };
  }

  static fromJSON(j) {
    return new Weapon(j.id, j.rarity, { ammo: j.ammo });
  }
}

export default Weapon;
