/**
 * terrain.js — Chunked heightmap terrain with a 6-layer splatting shader.
 *
 * The 4km island is split into a 16x16 grid of 250m chunks. Each chunk is a
 * PlaneGeometry displaced by heightfield.getHeight(), with per-vertex layer
 * weights baked into attributes so the fragment shader can blend six tiling
 * materials (ocean floor, sand, grass, forest, highland, rock) without any
 * texture-array support requirements.
 *
 * Chunks carry their own bounding spheres so Three.js frustum-culls them, and
 * a distance-based LOD swaps in lower vertex densities for far chunks.
 */

import * as THREE from 'three';
import mapConfig from '../config/map.json' with { type: 'json' };
import { getHeight, getSlope, getLayerIndex, islandMask } from './heightfield.js';
import { getMaterialMaps } from '../engine/textures.js';

const LAYER_TEXTURES = ['oceanfloor', 'sand', 'grass', 'grass_forest', 'grass_highland', 'rock'];

/* ------------------------------------------------------------------ */
/* Splatting shader                                                    */
/* ------------------------------------------------------------------ */

/**
 * Injects 6-layer blending into MeshStandardMaterial via onBeforeCompile so we
 * keep Three.js lighting, shadows, fog and tone mapping for free.
 */
function makeTerrainMaterial(layerMaps) {
  const mat = new THREE.MeshStandardMaterial({
    roughness: 0.94,
    metalness: 0.0,
    color: 0xffffff,
  });

  mat.onBeforeCompile = (shader) => {
    for (let i = 0; i < 6; i++) {
      shader.uniforms[`tLayer${i}`] = { value: layerMaps[i].map };
      shader.uniforms[`tLayerN${i}`] = { value: layerMaps[i].normalMap };
      shader.uniforms[`uTiling${i}`] = { value: mapConfig.terrainLayers[i].tiling };
    }

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute vec3 layerWeightA;   // layers 0,1,2
         attribute vec3 layerWeightB;   // layers 3,4,5
         varying vec3 vLayerA;
         varying vec3 vLayerB;
         varying vec2 vWorldXZ;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vLayerA = layerWeightA;
         vLayerB = layerWeightB;
         vec4 wp = modelMatrix * vec4(position, 1.0);
         vWorldXZ = wp.xz;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform sampler2D tLayer0; uniform sampler2D tLayer1; uniform sampler2D tLayer2;
         uniform sampler2D tLayer3; uniform sampler2D tLayer4; uniform sampler2D tLayer5;
         uniform sampler2D tLayerN0; uniform sampler2D tLayerN1; uniform sampler2D tLayerN2;
         uniform sampler2D tLayerN3; uniform sampler2D tLayerN4; uniform sampler2D tLayerN5;
         uniform float uTiling0; uniform float uTiling1; uniform float uTiling2;
         uniform float uTiling3; uniform float uTiling4; uniform float uTiling5;
         varying vec3 vLayerA;
         varying vec3 vLayerB;
         varying vec2 vWorldXZ;`,
      )
      .replace(
        '#include <map_fragment>',
        `
         // World-space UVs keep tiling continuous across chunk seams.
         vec3 wA = vLayerA;
         vec3 wB = vLayerB;
         float wsum = wA.x + wA.y + wA.z + wB.x + wB.y + wB.z;
         wA /= max(wsum, 0.0001);
         wB /= max(wsum, 0.0001);

         vec4 terrainCol = vec4(0.0);
         if (wA.x > 0.001) terrainCol += texture2D(tLayer0, vWorldXZ / uTiling0) * wA.x;
         if (wA.y > 0.001) terrainCol += texture2D(tLayer1, vWorldXZ / uTiling1) * wA.y;
         if (wA.z > 0.001) terrainCol += texture2D(tLayer2, vWorldXZ / uTiling2) * wA.z;
         if (wB.x > 0.001) terrainCol += texture2D(tLayer3, vWorldXZ / uTiling3) * wB.x;
         if (wB.y > 0.001) terrainCol += texture2D(tLayer4, vWorldXZ / uTiling4) * wB.y;
         if (wB.z > 0.001) terrainCol += texture2D(tLayer5, vWorldXZ / uTiling5) * wB.z;

         diffuseColor *= terrainCol;
        `,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `
         vec3 blendedNormal = vec3(0.0);
         if (vLayerA.x > 0.001) blendedNormal += (texture2D(tLayerN0, vWorldXZ / uTiling0).xyz * 2.0 - 1.0) * vLayerA.x;
         if (vLayerA.y > 0.001) blendedNormal += (texture2D(tLayerN1, vWorldXZ / uTiling1).xyz * 2.0 - 1.0) * vLayerA.y;
         if (vLayerA.z > 0.001) blendedNormal += (texture2D(tLayerN2, vWorldXZ / uTiling2).xyz * 2.0 - 1.0) * vLayerA.z;
         if (vLayerB.x > 0.001) blendedNormal += (texture2D(tLayerN3, vWorldXZ / uTiling3).xyz * 2.0 - 1.0) * vLayerB.x;
         if (vLayerB.y > 0.001) blendedNormal += (texture2D(tLayerN4, vWorldXZ / uTiling4).xyz * 2.0 - 1.0) * vLayerB.y;
         if (vLayerB.z > 0.001) blendedNormal += (texture2D(tLayerN5, vWorldXZ / uTiling5).xyz * 2.0 - 1.0) * vLayerB.z;

         float wsum2 = vLayerA.x + vLayerA.y + vLayerA.z + vLayerB.x + vLayerB.y + vLayerB.z;
         blendedNormal /= max(wsum2, 0.0001);
         blendedNormal.xy *= 0.75; // moderate normal intensity — cartoon PBR
         normal = normalize(normal + vec3(blendedNormal.x, blendedNormal.y, 0.0) * 0.6);
        `,
      );

    mat.userData.shader = shader;
  };

  return mat;
}

/* ------------------------------------------------------------------ */
/* Chunk construction                                                  */
/* ------------------------------------------------------------------ */

/**
 * Compute six blend weights for a world position. Weights are smooth so the
 * transition between grass and rock is a gradient, not a hard seam.
 */
function computeLayerWeights(x, z, out) {
  const h = getHeight(x, z);
  const slope = getSlope(x, z, 2.0);

  let w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0;

  // Ocean floor below -2m, fading out by +1m.
  w0 = THREE.MathUtils.smoothstep(-h, 1.0, 6.0);
  // Beach band around sea level.
  w1 = THREE.MathUtils.smoothstep(h, -1.5, 1.0) * (1.0 - THREE.MathUtils.smoothstep(h, 3.0, 7.0));
  // Lowland grass.
  w2 = THREE.MathUtils.smoothstep(h, 2.0, 6.0) * (1.0 - THREE.MathUtils.smoothstep(h, 62.0, 88.0));
  // Forest floor — driven by the same noise the foliage placer uses.
  const forestNoise = getLayerIndex(x, z) === 3 ? 1 : 0;
  w3 = forestNoise * THREE.MathUtils.smoothstep(h, 3.0, 8.0) * (1.0 - THREE.MathUtils.smoothstep(h, 95.0, 120.0));
  // Highland grass above ~70m.
  w4 = THREE.MathUtils.smoothstep(h, 66.0, 96.0);
  // Rock on steep slopes — dominates everything else.
  w5 = THREE.MathUtils.smoothstep(slope, 26.0, 40.0) * 2.2;

  // Guarantee a minimum so nothing renders black in gaps.
  const total = w0 + w1 + w2 + w3 + w4 + w5;
  if (total < 0.05) w2 = 1.0;

  out[0] = w0; out[1] = w1; out[2] = w2;
  out[3] = w3; out[4] = w4; out[5] = w5;
}

class TerrainChunk {
  constructor(cx, cz, chunkSize, resolution, material) {
    this.cx = cx;
    this.cz = cz;
    this.chunkSize = chunkSize;
    this.resolution = resolution;

    const half = mapConfig.halfSize;
    this.originX = -half + cx * chunkSize;
    this.originZ = -half + cz * chunkSize;
    this.centerX = this.originX + chunkSize / 2;
    this.centerZ = this.originZ + chunkSize / 2;

    this.mesh = this._build(material);
  }

  _build(material) {
    const res = this.resolution;
    const size = this.chunkSize;
    const geo = new THREE.PlaneGeometry(size, size, res - 1, res - 1);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const weightsA = new Float32Array(pos.count * 3);
    const weightsB = new Float32Array(pos.count * 3);
    const w = new Float32Array(6);

    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = pos.getZ(i);
      const wx = this.centerX + lx;
      const wz = this.centerZ + lz;
      const h = getHeight(wx, wz);
      pos.setY(i, h);
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;

      computeLayerWeights(wx, wz, w);
      weightsA[i * 3] = w[0];
      weightsA[i * 3 + 1] = w[1];
      weightsA[i * 3 + 2] = w[2];
      weightsB[i * 3] = w[3];
      weightsB[i * 3 + 1] = w[4];
      weightsB[i * 3 + 2] = w[5];
    }

    geo.setAttribute('layerWeightA', new THREE.BufferAttribute(weightsA, 3));
    geo.setAttribute('layerWeightB', new THREE.BufferAttribute(weightsB, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    geo.computeBoundingBox();

    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(this.centerX, 0, this.centerZ);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.name = `terrain_${this.cx}_${this.cz}`;
    mesh.userData.chunk = this;

    this.minY = minY;
    this.maxY = maxY;
    return mesh;
  }

  dispose() {
    this.mesh.geometry.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* Water                                                               */
/* ------------------------------------------------------------------ */

function makeWaterMaterial() {
  const maps = getMaterialMaps('water', { size: 256, repeat: 60, normalStrength: 1.2 });
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2f7fbf,
    roughness: 0.14,
    metalness: 0.15,
    transparent: true,
    opacity: 0.82,
    normalMap: maps.normalMap,
  });
  mat.normalScale = new THREE.Vector2(0.5, 0.5);
  mat.userData.scrollA = maps.normalMap;
  return mat;
}

/* ------------------------------------------------------------------ */
/* Terrain manager                                                     */
/* ------------------------------------------------------------------ */

export class Terrain {
  /**
   * @param {THREE.Scene} scene
   * @param {object} opts { chunks, highRes, lowRes, lodDistance }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.chunkCount = opts.chunks ?? mapConfig.terrainChunks;
    this.chunkSize = mapConfig.worldSize / this.chunkCount;
    this.highRes = opts.highRes ?? mapConfig.chunkVerts;
    this.lowRes = opts.lowRes ?? Math.max(9, Math.floor(mapConfig.chunkVerts / 4) + 1);
    this.lodDistance = opts.lodDistance ?? 900;

    this.chunks = [];
    this.group = new THREE.Group();
    this.group.name = 'Terrain';
    scene.add(this.group);

    this._layerMaps = LAYER_TEXTURES.map((id, i) =>
      getMaterialMaps(id, {
        size: 512,
        repeat: 1,
        normalStrength: i === 5 ? 2.6 : 1.8,
        roughness: 0.92,
      }),
    );

    this.material = makeTerrainMaterial(this._layerMaps);
    this._buildChunks();
    this._buildWater();
  }

  _buildChunks() {
    for (let cz = 0; cz < this.chunkCount; cz++) {
      for (let cx = 0; cx < this.chunkCount; cx++) {
        // Skip chunks entirely out at sea — nothing but flat ocean floor there.
        const centerX = -mapConfig.halfSize + cx * this.chunkSize + this.chunkSize / 2;
        const centerZ = -mapConfig.halfSize + cz * this.chunkSize + this.chunkSize / 2;
        const nearIsland =
          islandMask(centerX, centerZ) > 0.001 ||
          islandMask(centerX - this.chunkSize / 2, centerZ) > 0.001 ||
          islandMask(centerX + this.chunkSize / 2, centerZ) > 0.001 ||
          islandMask(centerX, centerZ - this.chunkSize / 2) > 0.001 ||
          islandMask(centerX, centerZ + this.chunkSize / 2) > 0.001;
        if (!nearIsland) continue;

        const chunk = new TerrainChunk(cx, cz, this.chunkSize, this.highRes, this.material);
        this.chunks.push(chunk);
        this.group.add(chunk.mesh);
      }
    }
  }

  _buildWater() {
    // Ocean: one big plane at sea level extending past the island.
    const oceanGeo = new THREE.PlaneGeometry(12000, 12000, 1, 1);
    oceanGeo.rotateX(-Math.PI / 2);
    this.waterMaterial = makeWaterMaterial();
    this.ocean = new THREE.Mesh(oceanGeo, this.waterMaterial);
    this.ocean.position.y = 0;
    this.ocean.renderOrder = 1;
    this.ocean.name = 'Ocean';
    this.group.add(this.ocean);

    // Lake surface sits slightly above sea level.
    const lake = mapConfig.terrainFeatures.lake;
    const lakeGeo = new THREE.CircleGeometry(lake.radius * 1.12, 64);
    lakeGeo.rotateX(-Math.PI / 2);
    this.lake = new THREE.Mesh(lakeGeo, this.waterMaterial);
    this.lake.position.set(lake.x, lake.waterLevel, lake.z);
    this.lake.renderOrder = 1;
    this.lake.name = 'MirrorLake';
    this.group.add(this.lake);
  }

  /** Animate water normals for a subtle living surface. */
  update(dt, cameraPos) {
    const n = this.waterMaterial.normalMap;
    if (n) {
      n.offset.x = (n.offset.x + dt * 0.014) % 1;
      n.offset.y = (n.offset.y + dt * 0.009) % 1;
    }
    if (cameraPos) {
      // Keep the infinite ocean centred so it never runs out.
      this.ocean.position.x = cameraPos.x;
      this.ocean.position.z = cameraPos.z;
    }
  }

  /** All chunk meshes, for raycasting against the ground. */
  get meshes() {
    return this.chunks.map((c) => c.mesh);
  }

  dispose() {
    for (const c of this.chunks) c.dispose();
    this.material.dispose();
    this.waterMaterial.dispose();
    this.scene.remove(this.group);
  }
}

export default Terrain;
