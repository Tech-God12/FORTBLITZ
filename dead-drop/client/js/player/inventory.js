/**
 * inventory.js — 5-slot inventory, ammo pools and material counts.
 *
 * SPAWN RULE (non-negotiable): players spawn with the pickaxe only. Every
 * slot starts null. createSpawnInventory() is the single entry point for a
 * fresh loadout and it is covered by a test.
 *
 * Slots hold one of:
 *   { kind: 'weapon',     weapon: Weapon }
 *   { kind: 'consumable', id, count }
 *   { kind: 'throwable',  id, count }
 */

import Weapon, {
  WEAPONS_BY_ID, CONSUMABLES_BY_ID, THROWABLES_BY_ID, AMMO_TYPES,
} from '../weapons/weapon-base.js';

export const SLOT_COUNT = 5;

/** Ammo reserve caps. */
export const AMMO_CAP = 999;

/* ------------------------------------------------------------------ */

export class Inventory {
  constructor() {
    /** @type {Array<object|null>} */
    this.slots = new Array(SLOT_COUNT).fill(null);
    this.activeSlot = 0;

    /** Reserve ammo by type. Players start with none. */
    this.ammo = { light: 0, medium: 0, heavy: 0, shells: 0, rockets: 0 };

    /** Build materials. Players start with none (TRAP: no free mats). */
    this.materials = { wood: 0, brick: 0, metal: 0 };

    this.onChange = null;
    this.onSlotChange = null;
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  get(index) {
    return this.slots[index] ?? null;
  }

  get active() {
    return this.slots[this.activeSlot] ?? null;
  }

  /** The equipped Weapon instance, or null if the slot is not a weapon. */
  get activeWeapon() {
    const s = this.active;
    return s && s.kind === 'weapon' ? s.weapon : null;
  }

  hasAnyWeapon() {
    return this.slots.some((s) => s && s.kind === 'weapon');
  }

  firstEmptySlot() {
    return this.slots.findIndex((s) => s === null);
  }

  isFull() {
    return this.firstEmptySlot() === -1;
  }

  /** Reserve ammo available for the active weapon. */
  getReserveFor(weapon) {
    if (!weapon) return 0;
    return this.ammo[weapon.ammoType] ?? 0;
  }

  get activeReserve() {
    return this.getReserveFor(this.activeWeapon);
  }

  /** Count of a stackable item across all slots. */
  countItem(id) {
    let n = 0;
    for (const s of this.slots) {
      if (s && (s.kind === 'consumable' || s.kind === 'throwable') && s.id === id) n += s.count;
    }
    return n;
  }

  /* ---------------------------------------------------------------- */
  /* Slot selection                                                    */
  /* ---------------------------------------------------------------- */

  selectSlot(index) {
    if (index < 0 || index >= SLOT_COUNT) return false;
    if (index === this.activeSlot) return false;

    const prev = this.active;
    if (prev?.kind === 'weapon') prev.weapon.onUnequip();

    this.activeSlot = index;

    const next = this.active;
    if (next?.kind === 'weapon') next.weapon.onEquip();

    this.onSlotChange?.(index, next);
    this.onChange?.();
    return true;
  }

  cycleSlot(dir) {
    let i = this.activeSlot;
    for (let n = 0; n < SLOT_COUNT; n++) {
      i = (i + dir + SLOT_COUNT) % SLOT_COUNT;
      // Cycling skips empty slots unless everything is empty.
      if (this.slots[i]) return this.selectSlot(i);
    }
    return false;
  }

  /** Pick the best available slot after picking something up. */
  selectBestSlot() {
    const weaponSlot = this.slots.findIndex((s) => s && s.kind === 'weapon');
    if (weaponSlot >= 0) this.selectSlot(weaponSlot);
  }

  /* ---------------------------------------------------------------- */
  /* Adding items                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Add a weapon. Returns { added, slot, replaced } — `replaced` is the item
   * that was dropped if the inventory was full.
   */
  addWeapon(weapon, preferredSlot = -1) {
    let slot = preferredSlot >= 0 && this.slots[preferredSlot] === null
      ? preferredSlot
      : this.firstEmptySlot();

    let replaced = null;
    if (slot === -1) {
      // Full: swap with the ACTIVE slot, which is what Fortnite does.
      slot = this.activeSlot;
      replaced = this.slots[slot];
      if (replaced?.kind === 'weapon') replaced.weapon.onUnequip();
    }

    this.slots[slot] = { kind: 'weapon', weapon };
    if (slot === this.activeSlot) weapon.onEquip();
    this.onChange?.();
    return { added: true, slot, replaced };
  }

  /**
   * Add a stackable consumable/throwable. Merges into an existing stack when
   * possible, respecting per-item stack sizes.
   */
  addStackable(kind, id, count = 1) {
    const def = kind === 'consumable' ? CONSUMABLES_BY_ID.get(id) : THROWABLES_BY_ID.get(id);
    if (!def) return { added: false, remaining: count };

    let remaining = count;

    // 1. Top up existing stacks.
    for (const s of this.slots) {
      if (remaining <= 0) break;
      if (s && s.kind === kind && s.id === id && s.count < def.stackSize) {
        const room = def.stackSize - s.count;
        const take = Math.min(room, remaining);
        s.count += take;
        remaining -= take;
      }
    }

    // 2. Fill empty slots with new stacks.
    while (remaining > 0) {
      const empty = this.firstEmptySlot();
      if (empty === -1) break;
      const take = Math.min(def.stackSize, remaining);
      this.slots[empty] = { kind, id, count: take };
      remaining -= take;
    }

    this.onChange?.();
    return { added: remaining < count, remaining };
  }

  /** Add reserve ammo. Returns how much was actually taken. */
  addAmmo(type, amount) {
    if (!(type in this.ammo)) return 0;
    const before = this.ammo[type];
    this.ammo[type] = Math.min(AMMO_CAP, before + amount);
    const taken = this.ammo[type] - before;
    if (taken > 0) this.onChange?.();
    return taken;
  }

  /** Add build materials, capped at 999 each. */
  addMaterial(type, amount) {
    if (!(type in this.materials)) return 0;
    const before = this.materials[type];
    this.materials[type] = Math.min(999, before + amount);
    const taken = this.materials[type] - before;
    if (taken > 0) this.onChange?.();
    return taken;
  }

  spendMaterial(type, amount) {
    if ((this.materials[type] ?? 0) < amount) return false;
    this.materials[type] -= amount;
    this.onChange?.();
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Consuming                                                         */
  /* ---------------------------------------------------------------- */

  /** Consume ammo from reserve when reloading. */
  consumeAmmo(type, amount) {
    const have = this.ammo[type] ?? 0;
    const take = Math.min(have, amount);
    this.ammo[type] = have - take;
    if (take > 0) this.onChange?.();
    return take;
  }

  /** Use one unit from a stackable slot. Empties the slot when it runs out. */
  consumeStack(slotIndex, amount = 1) {
    const s = this.slots[slotIndex];
    if (!s || (s.kind !== 'consumable' && s.kind !== 'throwable')) return false;
    s.count -= amount;
    if (s.count <= 0) this.slots[slotIndex] = null;
    this.onChange?.();
    return true;
  }

  /** Remove and return the item in a slot. */
  removeSlot(index) {
    const item = this.slots[index];
    if (!item) return null;
    if (item.kind === 'weapon') item.weapon.onUnequip();
    this.slots[index] = null;
    this.onChange?.();
    return item;
  }

  /** Drop the active item. */
  dropActive() {
    return this.removeSlot(this.activeSlot);
  }

  /** Swap two slots (drag-and-drop reordering). */
  swapSlots(a, b) {
    if (a < 0 || b < 0 || a >= SLOT_COUNT || b >= SLOT_COUNT) return false;
    const tmp = this.slots[a];
    this.slots[a] = this.slots[b];
    this.slots[b] = tmp;
    this.onChange?.();
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Death / serialization                                             */
  /* ---------------------------------------------------------------- */

  /**
   * Everything this inventory drops on elimination: all 5 slots as separate
   * world items, plus ammo and half the materials.
   */
  getDropContents(materialRetention = 0.5) {
    const drops = [];
    for (const s of this.slots) {
      if (!s) continue;
      if (s.kind === 'weapon') {
        drops.push({ kind: 'weapon', id: s.weapon.id, rarity: s.weapon.rarity, ammo: s.weapon.ammo });
      } else {
        drops.push({ kind: s.kind, id: s.id, count: s.count });
      }
    }
    for (const [type, amount] of Object.entries(this.ammo)) {
      if (amount > 0) drops.push({ kind: 'ammo', id: type, count: amount });
    }
    for (const [type, amount] of Object.entries(this.materials)) {
      const give = Math.floor(amount * materialRetention);
      if (give > 0) drops.push({ kind: 'material', id: type, count: give });
    }
    return drops;
  }

  clear() {
    for (let i = 0; i < SLOT_COUNT; i++) this.slots[i] = null;
    this.ammo = { light: 0, medium: 0, heavy: 0, shells: 0, rockets: 0 };
    this.materials = { wood: 0, brick: 0, metal: 0 };
    this.activeSlot = 0;
    this.onChange?.();
  }

  toJSON() {
    return {
      slots: this.slots.map((s) => {
        if (!s) return null;
        if (s.kind === 'weapon') return { kind: 'weapon', ...s.weapon.toJSON() };
        return { kind: s.kind, id: s.id, count: s.count };
      }),
      ammo: { ...this.ammo },
      materials: { ...this.materials },
      activeSlot: this.activeSlot,
    };
  }
}

/* ------------------------------------------------------------------ */

/**
 * The canonical fresh-spawn loadout: pickaxe only, nothing else.
 * This function exists so the "zero weapons on spawn" rule has one
 * authoritative definition that tests can assert against.
 */
export function createSpawnInventory() {
  const inv = new Inventory();
  // Deliberately empty: no weapons, no ammo, no materials, no heals.
  return inv;
}

/** Helper used by loot pickups to build an inventory entry from loot data. */
export function makeInventoryItem(loot) {
  if (loot.kind === 'weapon') {
    return { kind: 'weapon', weapon: new Weapon(loot.id, loot.rarity, { ammo: loot.ammo }) };
  }
  return { kind: loot.kind, id: loot.id, count: loot.count ?? 1 };
}

export default Inventory;
