/**
 * main.js — Bootstrap. Wires the engine, world and game together.
 *
 * NOTE: this is the staged bootstrap used while systems come online. Each
 * subsystem registers itself here as it is completed.
 */

import * as THREE from 'three';
import Renderer from './engine/renderer.js';
import Input from './engine/input.js';
import audio from './engine/audio.js';
import Terrain from './world/terrain.js';
import Sky from './world/sky.js';
import mapConfig from './config/map.json' with { type: 'json' };
import { getWalkHeight } from './world/heightfield.js';

const TIPS = [
  'Land on a chest, not next to one. The first weapon wins the first fight.',
  'Wood builds fastest, metal survives longest. Choose by how much time you have.',
  'Hit the blue weak point while harvesting for 50% bonus materials.',
  'You can hear a chest humming from about 24 metres away. Listen before you look.',
  'High ground wins build fights. Ramp up, then take the shot from above.',
  'The storm deals more damage every phase. Late rotations are rarely survivable.',
  'A pump shotgun to the head at close range ends most fights instantly.',
  'Press B to build. A wall between you and incoming fire buys you a reload.',
];

class Game {
  constructor() {
    this.canvas = document.getElementById('game-canvas');
    this.clock = new THREE.Clock();
    this.running = false;
    this.debugEnabled = false;
    this._accum = 0;
  }

  async boot() {
    this._setStatus('Creating renderer…', 0.04);
    this.renderer = new Renderer(this.canvas);
    this.scene = this.renderer.scene;
    this.camera = this.renderer.camera;

    await this._frame();

    this._setStatus('Raising the island…', 0.15);
    this.terrain = new Terrain(this.scene);
    await this._frame();

    this._setStatus('Painting the sky…', 0.55);
    this.sky = new Sky(this.scene, this.renderer);
    await this._frame();

    this._setStatus('Ready', 1.0);
    await this._frame();

    this._setupFreeCamera();
    this._bindUI();
    this._hideLoading();
    this.start();
  }

  /* ---------------------------------------------------------------- */

  /** Temporary fly camera so the world can be inspected before the
   *  player controller lands. Replaced by the third-person rig. */
  _setupFreeCamera() {
    this.input = new Input(this.canvas);
    this.camPos = new THREE.Vector3(-520, 120, 120);
    this.camYaw = 0.6;
    this.camPitch = -0.35;
    this.camSpeed = 90;

    this.canvas.addEventListener('click', () => {
      this.input.requestPointerLock();
      audio.init().catch(() => {});
    });
  }

  _bindUI() {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        this.debugEnabled = !this.debugEnabled;
        document.getElementById('debug').classList.toggle('show', this.debugEnabled);
      }
    });
  }

  _setStatus(text, pct) {
    const s = document.getElementById('loading-status');
    const f = document.getElementById('loading-fill');
    if (s) s.textContent = text;
    if (f) f.style.width = `${Math.round(pct * 100)}%`;
  }

  _hideLoading() {
    const el = document.getElementById('loading-screen');
    el.classList.add('fade-out');
    setTimeout(() => el.classList.add('hud-hidden'), 520);
    document.getElementById('hud').classList.remove('hud-hidden');
    document.getElementById('debug').classList.add('show');
    this.debugEnabled = true;
  }

  _frame() {
    return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  }

  /* ---------------------------------------------------------------- */

  start() {
    this.running = true;
    this.clock.start();
    this._loop();
  }

  _loop = () => {
    if (!this.running) return;
    requestAnimationFrame(this._loop);

    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;

    this._updateFreeCamera(dt);
    this.terrain.update(dt, this.camPos);
    this.sky.update(dt, this.camPos);
    this.renderer.updateShadowFocus(this.camPos);

    this.renderer.render(dt);

    if (this.debugEnabled) this._updateDebug(dt);
    this.input.endFrame();
  };

  _updateFreeCamera(dt) {
    const look = this.input.getLookDelta(0);
    this.camYaw += look.yaw;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + look.pitch, -1.5, 1.5);

    const move = this.input.getMoveVector();
    const speed = this.camSpeed * (this.input.isDown('SPRINT') ? 4 : 1);

    const forward = new THREE.Vector3(
      -Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      -Math.cos(this.camYaw) * Math.cos(this.camPitch),
    );
    const right = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));

    this.camPos.addScaledVector(forward, -move.z * speed * dt);
    this.camPos.addScaledVector(right, move.x * speed * dt);
    if (this.input.isDown('JUMP')) this.camPos.y += speed * dt;
    if (this.input.isDown('CROUCH')) this.camPos.y -= speed * dt;

    const ground = getWalkHeight(this.camPos.x, this.camPos.z);
    if (this.camPos.y < ground + 2) this.camPos.y = ground + 2;

    this.camera.position.copy(this.camPos);
    this.camera.rotation.set(this.camPitch, this.camYaw, 0, 'YXZ');
  }

  _updateDebug() {
    const r = this.renderer;
    const nearest = this._nearestLocation();
    document.getElementById('debug').textContent =
      `FPS ${r.fps.toFixed(0)}  draws ${r.drawCalls}  tris ${(r.triangles / 1000).toFixed(0)}k\n` +
      `pos ${this.camPos.x.toFixed(0)}, ${this.camPos.y.toFixed(0)}, ${this.camPos.z.toFixed(0)}\n` +
      `near ${nearest}\n` +
      `[F3] debug  [click] mouse look  WASD+Shift move`;
  }

  _nearestLocation() {
    let best = null;
    let bestD = Infinity;
    for (const l of mapConfig.namedLocations) {
      const d = Math.hypot(l.x - this.camPos.x, l.z - this.camPos.z);
      if (d < bestD) { bestD = d; best = l; }
    }
    return best ? `${best.name} (${bestD.toFixed(0)}m)` : '—';
  }
}

const game = new Game();
window.game = game;
game.boot().catch((err) => {
  console.error(err);
  const s = document.getElementById('loading-status');
  if (s) {
    s.textContent = `Error: ${err.message}`;
    s.style.color = '#ff6b6b';
  }
});

// Rotating loading tips.
const tipEl = document.getElementById('loading-tip');
if (tipEl) {
  let i = Math.floor(Math.random() * TIPS.length);
  tipEl.textContent = TIPS[i];
  setInterval(() => {
    i = (i + 1) % TIPS.length;
    tipEl.textContent = TIPS[i];
  }, 4200);
}
