/**
 * renderer.js — WebGL2 renderer, lighting rig and post-processing stack.
 *
 * Visual target: Fortnite's "cartoon PBR" — physically based lighting and
 * shadows, but with saturated albedo, high roughness, low metalness and a rim
 * light that fakes the cel-shaded silhouette edge.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { GammaCorrectionShader } from 'three/addons/shaders/GammaCorrectionShader.js';

/** Full-screen pass: storm interior colour grade + damage vignette. */
const StormGradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uInStorm: { value: 0 },      // 0..1 blend factor
    uDamage: { value: 0 },       // red vignette pulse
    uTint: { value: new THREE.Color('#3A5AD0') },
    uTime: { value: 0 },
    uLowHealth: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uInStorm;
    uniform float uDamage;
    uniform float uLowHealth;
    uniform float uTime;
    uniform vec3 uTint;
    varying vec2 vUv;

    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5));

      // --- Storm interior: blue grade, desaturation, static hiss -----
      if (uInStorm > 0.001) {
        float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
        vec3 graded = mix(c.rgb, mix(vec3(lum), uTint, 0.55), 0.75);
        float hiss = fract(sin(dot(vUv * (1.0 + uTime), vec2(12.9898, 78.233))) * 43758.5453);
        graded += (hiss - 0.5) * 0.05;
        graded *= 1.0 - d * 0.45;
        c.rgb = mix(c.rgb, graded, uInStorm);
      }

      // --- Damage vignette -------------------------------------------
      if (uDamage > 0.001) {
        float v = smoothstep(0.18, 0.72, d);
        c.rgb = mix(c.rgb, vec3(0.75, 0.05, 0.08), v * uDamage * 0.85);
      }

      // --- Critical health pulse -------------------------------------
      if (uLowHealth > 0.001) {
        float pulse = 0.5 + 0.5 * sin(uTime * 4.5);
        float v = smoothstep(0.25, 0.85, d);
        c.rgb = mix(c.rgb, vec3(0.6, 0.0, 0.0), v * uLowHealth * pulse * 0.5);
      }

      gl_FragColor = c;
    }
  `,
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.info.autoReset = false;

    this.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();

    // Third-person gameplay camera. FOV is driven by the player camera rig.
    this.camera = new THREE.PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.15, 6000);
    this.camera.position.set(0, 60, 0);

    this._setupLighting();
    this._setupComposer();

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    this.frameCount = 0;
    this._fpsAccum = 0;
    this._fpsFrames = 0;
    this.fps = 60;
  }

  /* ---------------------------------------------------------------- */

  _setupLighting() {
    // Late-afternoon sun, low and warm — the OG Chapter 1 lighting mood.
    const sun = new THREE.DirectionalLight(0xfff2d6, 2.5);
    sun.position.set(-320, 420, 240);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);

    // Orthographic frustum covering 1200m x 1200m, re-centred on the player
    // each frame by updateShadowFocus().
    const half = 600;
    sun.shadow.camera.left = -half;
    sun.shadow.camera.right = half;
    sun.shadow.camera.top = half;
    sun.shadow.camera.bottom = -half;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 2200;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.9;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;

    // Sky/ground hemisphere fill keeps shadowed faces coloured rather than black.
    const hemi = new THREE.HemisphereLight(0xbcd9ff, 0x4a7a35, 1.15);
    this.scene.add(hemi);
    this.hemi = hemi;

    // Gentle ambient so nothing crushes to pure black (cartoon style).
    const ambient = new THREE.AmbientLight(0xffffff, 0.28);
    this.scene.add(ambient);
    this.ambient = ambient;

    // Rim/back light — this is what produces Fortnite's cel-shaded edge feel.
    const rim = new THREE.DirectionalLight(0xa8c8ff, 0.85);
    rim.position.set(280, 180, -320);
    this.scene.add(rim);
    this.rim = rim;

    this.scene.fog = new THREE.Fog(0xcfe6ff, 900, 3200);
  }

  _setupComposer() {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4, // MSAA x4
    });

    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    // Bloom drives chest glow, rarity auras, muzzle flash and the storm wall.
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.3,  // strength
      0.5,  // radius
      0.85, // threshold
    );
    this.composer.addPass(this.bloom);

    this.stormPass = new ShaderPass(StormGradeShader);
    this.composer.addPass(this.stormPass);

    this.fxaa = new ShaderPass(FXAAShader);
    this.composer.addPass(this.fxaa);

    this.composer.addPass(new ShaderPass(GammaCorrectionShader));

    this._updateFxaaResolution();
  }

  _updateFxaaResolution() {
    const pr = this.renderer.getPixelRatio();
    this.fxaa.material.uniforms.resolution.value.set(
      1 / (window.innerWidth * pr),
      1 / (window.innerHeight * pr),
    );
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloom.setSize(w, h);
    this._updateFxaaResolution();
  }

  /* ---------------------------------------------------------------- */

  /** Keep the shadow frustum centred ahead of the player. */
  updateShadowFocus(target) {
    const s = this.sun;
    s.target.position.copy(target);
    s.position.set(target.x - 320, target.y + 420, target.z + 240);
    s.target.updateMatrixWorld();
    s.shadow.camera.updateProjectionMatrix();
  }

  /** Storm post-process state. `inStorm` 0..1, `damage` 0..1, `lowHealth` 0..1. */
  setStormGrade(inStorm, damage, lowHealth, time) {
    const u = this.stormPass.material.uniforms;
    u.uInStorm.value = inStorm;
    u.uDamage.value = damage;
    u.uLowHealth.value = lowHealth;
    u.uTime.value = time;
  }

  /** Reduce visibility while inside the storm wall. */
  setFog(near, far, color) {
    this.scene.fog.near = near;
    this.scene.fog.far = far;
    if (color) this.scene.fog.color.set(color);
  }

  render(dt) {
    this.renderer.info.reset();
    this.composer.render(dt);
    this.frameCount++;

    this._fpsAccum += dt;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }
  }

  get drawCalls() {
    return this.renderer.info.render.calls;
  }

  get triangles() {
    return this.renderer.info.render.triangles;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.composer.dispose();
    this.renderer.dispose();
  }
}

export default Renderer;
