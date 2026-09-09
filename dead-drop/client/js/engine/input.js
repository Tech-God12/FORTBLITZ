/**
 * input.js — Keyboard/mouse state, pointer lock and action mapping.
 *
 * Design rule: input is polled, not evented, for anything that affects
 * gameplay this frame. Building placement reads `consumePressed()` so a
 * structure is placed on the exact frame the key went down — zero latency
 * is the single most important mechanical requirement in this build.
 */

export const ACTIONS = {
  MOVE_FORWARD: ['KeyW'],
  MOVE_BACK: ['KeyS'],
  MOVE_LEFT: ['KeyA'],
  MOVE_RIGHT: ['KeyD'],
  JUMP: ['Space'],
  SPRINT: ['ShiftLeft', 'ShiftRight'],
  CROUCH: ['ControlLeft', 'KeyC'],
  RELOAD: ['KeyR'],
  INTERACT: ['KeyF'],
  BUILD_MODE: ['KeyB'],
  EDIT: ['KeyE'],
  MAP: ['KeyM'],
  INVENTORY: ['Tab'],
  EMOTE: ['KeyG'],
  SHOULDER_SWAP: ['KeyQ'],
  HARVEST: ['Digit0'],
  SLOT_1: ['Digit1'],
  SLOT_2: ['Digit2'],
  SLOT_3: ['Digit3'],
  SLOT_4: ['Digit4'],
  SLOT_5: ['Digit5'],
  BUILD_WALL: ['KeyZ'],
  BUILD_FLOOR: ['KeyX'],
  BUILD_RAMP: ['KeyV'],
  BUILD_PYRAMID: ['KeyN'],
  DROP: ['KeyH'],
  SCOREBOARD: ['KeyO'],
};

export class Input {
  constructor(domElement) {
    this.dom = domElement;

    this.keys = new Set();
    this.pressedThisFrame = new Set();
    this.releasedThisFrame = new Set();

    this.mouse = {
      dx: 0,
      dy: 0,
      wheel: 0,
      left: false,
      right: false,
      middle: false,
      leftPressed: false,
      rightPressed: false,
      leftReleased: false,
      rightReleased: false,
      x: 0,
      y: 0,
    };

    this.pointerLocked = false;
    this.sensitivity = 0.0022;
    this.adsSensitivityScale = 0.65;
    this.invertY = false;
    this.enabled = true;

    this._bind();
  }

  _bind() {
    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      // Tab would move focus; Space would scroll.
      if (['Tab', 'Space', 'F1', 'F2'].includes(e.code) || e.code.startsWith('Digit')) {
        e.preventDefault();
      }
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressedThisFrame.add(e.code);
    };

    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.releasedThisFrame.add(e.code);
    };

    this._onMouseMove = (e) => {
      if (this.pointerLocked) {
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
      }
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    };

    this._onMouseDown = (e) => {
      if (!this.enabled) return;
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
      if (e.button === 1) { this.mouse.middle = true; e.preventDefault(); }
    };

    this._onMouseUp = (e) => {
      if (e.button === 0) { this.mouse.left = false; this.mouse.leftReleased = true; }
      if (e.button === 2) { this.mouse.right = false; this.mouse.rightReleased = true; }
      if (e.button === 1) this.mouse.middle = false;
    };

    this._onWheel = (e) => {
      if (!this.enabled) return;
      this.mouse.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    };

    this._onContext = (e) => e.preventDefault();

    this._onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.dom;
      if (!this.pointerLocked) {
        // Drop held state so the player does not keep running after unlock.
        this.keys.clear();
        this.mouse.left = false;
        this.mouse.right = false;
      }
      this.onPointerLockChange?.(this.pointerLocked);
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('contextmenu', this._onContext);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    window.addEventListener('blur', () => this.keys.clear());
  }

  requestPointerLock() {
    this.dom.requestPointerLock?.();
  }

  exitPointerLock() {
    document.exitPointerLock?.();
  }

  /* ------------------------------------------------------------- */

  /** True while any key bound to the action is held. */
  isDown(action) {
    const codes = ACTIONS[action];
    if (!codes) return false;
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /** True only on the frame the action went down. */
  wasPressed(action) {
    const codes = ACTIONS[action];
    if (!codes) return false;
    for (const c of codes) if (this.pressedThisFrame.has(c)) return true;
    return false;
  }

  wasReleased(action) {
    const codes = ACTIONS[action];
    if (!codes) return false;
    for (const c of codes) if (this.releasedThisFrame.has(c)) return true;
    return false;
  }

  /** Movement vector in local space, already normalised. */
  getMoveVector(out = { x: 0, z: 0 }) {
    let x = 0;
    let z = 0;
    if (this.isDown('MOVE_FORWARD')) z -= 1;
    if (this.isDown('MOVE_BACK')) z += 1;
    if (this.isDown('MOVE_LEFT')) x -= 1;
    if (this.isDown('MOVE_RIGHT')) x += 1;
    const len = Math.hypot(x, z);
    if (len > 0) { x /= len; z /= len; }
    out.x = x;
    out.z = z;
    return out;
  }

  /** Accumulated look delta in radians; call once per frame. */
  getLookDelta(adsFactor = 0) {
    const scale = this.sensitivity * (1 - adsFactor * (1 - this.adsSensitivityScale));
    const yaw = -this.mouse.dx * scale;
    const pitch = (this.invertY ? this.mouse.dy : -this.mouse.dy) * scale;
    return { yaw, pitch };
  }

  /** Which inventory slot key (0-4) was pressed this frame, or -1. */
  getSlotPressed() {
    for (let i = 1; i <= 5; i++) {
      if (this.wasPressed(`SLOT_${i}`)) return i - 1;
    }
    return -1;
  }

  /** Which build piece key was pressed this frame, or null. */
  getBuildPiecePressed() {
    if (this.wasPressed('BUILD_WALL')) return 'wall';
    if (this.wasPressed('BUILD_FLOOR')) return 'floor';
    if (this.wasPressed('BUILD_RAMP')) return 'ramp';
    if (this.wasPressed('BUILD_PYRAMID')) return 'pyramid';
    return null;
  }

  /** Must be called at the END of every frame. */
  endFrame() {
    this.pressedThisFrame.clear();
    this.releasedThisFrame.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
    this.mouse.leftPressed = false;
    this.mouse.rightPressed = false;
    this.mouse.leftReleased = false;
    this.mouse.rightReleased = false;
  }

  setEnabled(v) {
    this.enabled = v;
    if (!v) this.keys.clear();
  }
}

export default Input;
