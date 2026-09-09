/**
 * sky.js — Procedural sky dome, volumetric-ish cloud layers and sun disc.
 *
 * Fortnite skies are never a flat gradient (TRAP-37). This builds:
 *   - a physically-motivated Rayleigh/Mie sky shader on a large inverted sphere
 *   - three parallax cloud layers using procedurally generated alpha textures
 *   - a sun disc with a soft bloom-friendly halo
 *   - distant island haze so the horizon reads as depth, not a hard edge
 */

import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* Sky dome shader                                                     */
/* ------------------------------------------------------------------ */

const SkyShader = {
  uniforms: {
    uSunDirection: { value: new THREE.Vector3(-0.55, 0.6, 0.45).normalize() },
    uRayleigh: { value: 1.9 },
    uTurbidity: { value: 3.2 },
    uMieCoefficient: { value: 0.006 },
    uMieDirectionalG: { value: 0.82 },
    uZenithColor: { value: new THREE.Color('#2E74C8') },
    uHorizonColor: { value: new THREE.Color('#BFE0F5') },
    uGroundColor: { value: new THREE.Color('#8FA98C') },
    uSunColor: { value: new THREE.Color('#FFF6DC') },
    uExposure: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec3 vWorldDirection;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldDirection = normalize(worldPos.xyz - cameraPosition);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position.z = gl_Position.w; // force to far plane
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec3 vWorldDirection;

    uniform vec3 uSunDirection;
    uniform float uRayleigh;
    uniform float uTurbidity;
    uniform float uMieCoefficient;
    uniform float uMieDirectionalG;
    uniform vec3 uZenithColor;
    uniform vec3 uHorizonColor;
    uniform vec3 uGroundColor;
    uniform vec3 uSunColor;
    uniform float uExposure;

    // Henyey-Greenstein phase function for forward Mie scattering.
    float hgPhase(float cosTheta, float g) {
      float g2 = g * g;
      return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
    }

    float rayleighPhase(float cosTheta) {
      return 0.75 * (1.0 + cosTheta * cosTheta);
    }

    void main() {
      vec3 dir = normalize(vWorldDirection);
      float h = dir.y;

      float cosTheta = dot(dir, normalize(uSunDirection));

      // Vertical gradient: horizon haze -> deep zenith blue.
      float t = clamp(h, 0.0, 1.0);
      vec3 sky = mix(uHorizonColor, uZenithColor, pow(t, 0.42));

      // Below the horizon fade toward a hazy ground tone so the dome never
      // shows a hard cut against distant terrain.
      if (h < 0.0) {
        sky = mix(uHorizonColor, uGroundColor, clamp(-h * 3.5, 0.0, 1.0));
      }

      // Rayleigh in-scatter brightens the whole sky near the sun.
      float rp = rayleighPhase(cosTheta);
      sky += uSunColor * rp * 0.055 * uRayleigh * (1.0 - clamp(t, 0.0, 0.85));

      // Mie halo around the sun.
      float mie = hgPhase(cosTheta, uMieDirectionalG) * uMieCoefficient * uTurbidity;
      sky += uSunColor * mie * 4.0;

      // Sun disc with a soft edge — bright enough to trigger bloom.
      float sunDisc = smoothstep(0.9993, 0.99975, cosTheta);
      sky += uSunColor * sunDisc * 9.0;

      // Wide soft glow.
      float glow = pow(max(cosTheta, 0.0), 220.0);
      sky += uSunColor * glow * 1.4;

      sky *= uExposure;
      gl_FragColor = vec4(sky, 1.0);

      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }
  `,
};

/* ------------------------------------------------------------------ */
/* Cloud texture generation                                            */
/* ------------------------------------------------------------------ */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates a tileable cloud alpha texture by stamping soft radial blobs and
 * then thresholding an FBM field — produces puffy cumulus rather than fog.
 */
function makeCloudTexture(size = 1024, seed = 3, coverage = 0.42, softness = 0.28) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rnd = mulberry32(seed);

  ctx.clearRect(0, 0, size, size);

  // Stamp overlapping soft blobs, wrapping at the edges for tiling.
  const clusters = 26;
  for (let c = 0; c < clusters; c++) {
    const cx = rnd() * size;
    const cy = rnd() * size;
    const puffs = 10 + Math.floor(rnd() * 18);
    const clusterR = size * (0.05 + rnd() * 0.1);
    for (let p = 0; p < puffs; p++) {
      const ang = rnd() * Math.PI * 2;
      const dist = Math.pow(rnd(), 0.6) * clusterR;
      const px = cx + Math.cos(ang) * dist;
      const py = cy + Math.sin(ang) * dist * 0.55;
      const r = clusterR * (0.25 + rnd() * 0.5);
      const alpha = 0.16 + rnd() * 0.3;

      // Draw the blob in all 9 wrap positions so the texture tiles.
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const x = px + ox * size;
          const y = py + oy * size;
          if (x < -r * 2 || x > size + r * 2 || y < -r * 2 || y > size + r * 2) continue;
          const g = ctx.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, `rgba(255,255,255,${alpha})`);
          g.addColorStop(softness, `rgba(255,255,255,${alpha * 0.7})`);
          g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  // Contrast pass: push toward puffy shapes with defined edges.
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    let a = d[i * 4 + 3] / 255;
    a = Math.max(0, Math.min(1, (a - (1 - coverage) * 0.35) * 2.1));
    a = a * a * (3 - 2 * a);
    d[i * 4 + 3] = a * 255;
    // Slight blue-grey in the thicker parts for volume.
    const shade = 232 + a * 23;
    d[i * 4] = shade;
    d[i * 4 + 1] = shade;
    d[i * 4 + 2] = Math.min(255, shade + 6);
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Sky system                                                          */
/* ------------------------------------------------------------------ */

export class Sky {
  /**
   * @param {THREE.Scene} scene
   * @param {Renderer} renderer  used to sync the sun light direction
   */
  constructor(scene, renderer = null) {
    this.scene = scene;
    this.renderer = renderer;

    this.group = new THREE.Group();
    this.group.name = 'Sky';
    scene.add(this.group);

    // Late-afternoon sun: low in the west, warm.
    this.sunDirection = new THREE.Vector3(-0.58, 0.42, 0.4).normalize();

    this._buildDome();
    this._buildClouds();
    this._syncLight();
  }

  _buildDome() {
    const geo = new THREE.SphereGeometry(4500, 48, 24);
    const uniforms = THREE.UniformsUtils.clone(SkyShader.uniforms);
    uniforms.uSunDirection.value.copy(this.sunDirection);

    this.domeMaterial = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SkyShader.vertexShader,
      fragmentShader: SkyShader.fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });

    this.dome = new THREE.Mesh(geo, this.domeMaterial);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.name = 'SkyDome';
    this.group.add(this.dome);
  }

  _buildClouds() {
    this.cloudLayers = [];

    // Three parallax layers at different altitudes, scales and speeds.
    const layerDefs = [
      { altitude: 620, radius: 4200, seed: 11, coverage: 0.5, repeat: 3.0, speed: 0.0022, opacity: 0.85 },
      { altitude: 880, radius: 5000, seed: 23, coverage: 0.4, repeat: 2.0, speed: 0.0014, opacity: 0.72 },
      { altitude: 1250, radius: 6000, seed: 37, coverage: 0.3, repeat: 1.3, speed: 0.0008, opacity: 0.55 },
    ];

    for (const def of layerDefs) {
      const tex = makeCloudTexture(1024, def.seed, def.coverage, 0.3);
      tex.repeat.set(def.repeat, def.repeat);

      const geo = new THREE.PlaneGeometry(def.radius * 2, def.radius * 2, 1, 1);
      geo.rotateX(Math.PI / 2); // face downward toward the player

      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: def.opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });

      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = def.altitude;
      mesh.renderOrder = -900 + this.cloudLayers.length;
      mesh.frustumCulled = false;
      mesh.name = `CloudLayer${this.cloudLayers.length}`;
      this.group.add(mesh);

      this.cloudLayers.push({ mesh, tex, speed: def.speed, def });
    }
  }

  /** Point the renderer's directional light along the sky's sun direction. */
  _syncLight() {
    if (!this.renderer?.sun) return;
    const d = this.sunDirection;
    this.renderer.sun.position.set(d.x * 800, d.y * 800, d.z * 800);
    // Warm the sun and cool the sky fill to match the dome colours.
    this.renderer.sun.color.set('#FFF0D2');
    this.renderer.scene.fog?.color.set('#BFD9F0');
  }

  /**
   * Set time of day. 0 = dawn, 0.5 = noon, 1 = dusk.
   * Phase 1 ships with a fixed late afternoon, but the system supports more.
   */
  setTimeOfDay(t) {
    const angle = Math.PI * (0.12 + t * 0.76);
    this.sunDirection.set(-Math.cos(angle), Math.sin(angle), 0.4).normalize();
    this.domeMaterial.uniforms.uSunDirection.value.copy(this.sunDirection);

    // Warmer and redder near the horizon.
    const lowness = 1 - Math.min(1, this.sunDirection.y / 0.5);
    this.domeMaterial.uniforms.uHorizonColor.value.lerpColors(
      new THREE.Color('#BFE0F5'),
      new THREE.Color('#FFB477'),
      lowness * 0.8,
    );
    this.domeMaterial.uniforms.uSunColor.value.lerpColors(
      new THREE.Color('#FFF6DC'),
      new THREE.Color('#FFC98A'),
      lowness,
    );
    this._syncLight();
  }

  update(dt, cameraPos) {
    // Dome and clouds follow the camera so they are effectively at infinity.
    if (cameraPos) {
      this.dome.position.set(cameraPos.x, 0, cameraPos.z);
      for (const layer of this.cloudLayers) {
        layer.mesh.position.x = cameraPos.x;
        layer.mesh.position.z = cameraPos.z;
      }
    }
    // Drift the clouds.
    for (const layer of this.cloudLayers) {
      layer.tex.offset.x = (layer.tex.offset.x + layer.speed * dt) % 1;
      layer.tex.offset.y = (layer.tex.offset.y + layer.speed * 0.35 * dt) % 1;
    }
  }

  dispose() {
    this.dome.geometry.dispose();
    this.domeMaterial.dispose();
    for (const l of this.cloudLayers) {
      l.mesh.geometry.dispose();
      l.mesh.material.dispose();
      l.tex.dispose();
    }
    this.scene.remove(this.group);
  }
}

export default Sky;
