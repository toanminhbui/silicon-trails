import * as THREE from 'three';

const hash = (x, z) => {
  const n = Math.sin(x * 127.1 + z * 311.7) * 43758.5453123;
  return n - Math.floor(n);
};

function tile(top, side, grass = false) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = side; ctx.fillRect(0, 0, 16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const n = hash(x + 9, y + 31);
    ctx.fillStyle = n > 0.65 ? '#ffffff18' : '#00000016';
    ctx.fillRect(x, y, 1, 1);
  }
  if (grass) {
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, 16, 3);
    for (let x = 0; x < 16; x++) ctx.fillRect(x, 2, 1, 1 + Math.floor(hash(x, 3) * 3));
  }
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.magFilter = THREE.NearestFilter;
  map.minFilter = THREE.NearestFilter;
  return map;
}

/** Deterministic voxel landscape, batched into a handful of instanced meshes. */
export class VoxelTerrain {
  constructor(bounds = { x: 0, z: 0, width: 38, depth: 34 }) {
    this.group = new THREE.Group();
    this.colliders = [];
    this.clouds = [];
    this.bounds = bounds;
    this.radius = Math.max(84, Math.ceil(Math.max(bounds.width, bounds.depth) * 0.65 / 2) * 2 + 28);
    this.clearX = Math.max(22, bounds.width / 2 + 4);
    this.clearZ = Math.max(24, bounds.depth / 2 + 4);
    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.materials = [];
    this.textures = [];
    this.matrix = new THREE.Matrix4();
    this.quaternion = new THREE.Quaternion();
    this.makeLandscape();
  }

  riverX(z) { return this.clearX + 11 + Math.sin(z * 0.055) * 4; }
  waterAt(x, z) {
    return Math.abs(x - this.riverX(z)) < 4.1 || ((x + this.clearX + 10) / 10) ** 2 + ((z - 19) / 8) ** 2 < 1;
  }
  bridgeAt(x, z) { return Math.abs(z - 20) < 2 && Math.abs(x - this.riverX(20)) < 6.8; }
  surfaceAt(x, z) {
    if (this.waterAt(x, z)) return -2;
    const outside = Math.max(Math.abs(x) - this.clearX, Math.abs(z) - this.clearZ, 0);
    const blend = Math.min(1, outside / 18);
    const hills = 2.2 + Math.sin(x * 0.073) * 2.7 + Math.cos(z * 0.063 + x * 0.016) * 2.2
      + Math.sin(z * 0.13 - x * 0.04) * 1.3;
    return Math.max(0, Math.round(blend * hills));
  }
  heightAt(x, z) {
    if (this.bridgeAt(x, z)) return 0.18;
    if (this.waterAt(x, z)) return -0.6;
    return this.surfaceAt(Math.round(x / 2) * 2, Math.round(z / 2) * 2);
  }
  pathAt(x, z) {
    return Math.abs(x) < 2.1 && z > -this.clearZ && z < this.radius
      || Math.abs(z) < 1.8 && Math.abs(x) < this.clearX + 2
      || Math.abs(z - 20) < 1.6 && x > 0 && x < this.riverX(20) + 13
      || Math.abs(z + 8) < 1.5 && Math.abs(x) < 15;
  }

  material(options) {
    const material = new THREE.MeshLambertMaterial(options);
    this.materials.push(material);
    return material;
  }

  batch(items, material, { shadow = true, receive = true } = {}) {
    if (!items.length) return null;
    const mesh = new THREE.InstancedMesh(this.geometry, material, items.length);
    const position = new THREE.Vector3(), scale = new THREE.Vector3();
    items.forEach((item, index) => {
      position.set(item[0], item[1], item[2]);
      scale.set(item[3], item[4], item[5]);
      this.matrix.compose(position, this.quaternion, scale);
      mesh.setMatrixAt(index, this.matrix);
      if (item[6] !== undefined) mesh.setColorAt(index, new THREE.Color(item[6]));
    });
    mesh.castShadow = shadow;
    mesh.receiveShadow = receive;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    return mesh;
  }

  makeLandscape() {
    const grassMap = tile('#6fa444', '#8a6544', true);
    const grassTop = tile('#79ab49', '#79ab49');
    const dirtMap = tile('#96734d', '#96734d');
    const stoneMap = tile('#7c837e', '#7c837e');
    const pathMap = tile('#bda47a', '#bda47a');
    this.textures.push(grassMap, grassTop, dirtMap, stoneMap, pathMap);
    const side = this.material({ map: grassMap });
    const top = this.material({ map: grassTop });
    const dirt = this.material({ map: dirtMap });
    const stone = this.material({ map: stoneMap });
    const path = this.material({ map: pathMap });
    const sand = this.material({ color: 0xd7c79c });
    const grass = [], ground = [], paths = [], sandbanks = [], water = [];
    for (let x = -this.radius; x <= this.radius; x += 2) {
      for (let z = -this.radius; z <= this.radius; z += 2) {
        const y = this.surfaceAt(x, z);
        const tint = new THREE.Color().setHSL(0.25, 0.19, 0.89 + hash(x, z) * 0.09);
        if (this.waterAt(x, z)) {
          sandbanks.push([x, y - 0.5, z, 2, 1, 2]);
          water.push([x, -0.47, z, 2.02, 0.12, 2.02, hash(x, z) > 0.6 ? 0x7cbfd1 : 0x65b5d1]);
        } else if (this.pathAt(x, z)) paths.push([x, y - 0.5, z, 2, 1, 2, 0xf5ead1]);
        else grass.push([x, y - 0.5, z, 2, 1, 2, tint]);
        ground.push([x, (y - 1 - 8) / 2, z, 2, y + 7, 2]);
      }
    }
    this.batch(ground, dirt, { shadow: false });
    this.batch(grass, [side, side, top, dirt, side, side], { shadow: false });
    this.batch(paths, path, { shadow: false });
    this.batch(sandbanks, sand, { shadow: false });
    this.water = this.batch(water, this.material({ color: 0xffffff, transparent: true, opacity: 0.78 }), { shadow: false });

    const trunks = [], leaves = [], rocks = [], grassTufts = [], flowers = [], stems = [];
    for (let i = 0; i < 100; i++) {
      const angle = i * 2.39996;
      const r = 31 + hash(i, 8) * Math.max(25, this.radius - 42);
      const x = Math.round(Math.cos(angle) * r / 2) * 2;
      const z = Math.round(Math.sin(angle) * r / 2) * 2;
      if (Math.abs(x) < this.clearX + 1 && Math.abs(z) < this.clearZ + 2 || this.waterAt(x, z) || this.pathAt(x, z)) continue;
      const y = this.surfaceAt(x, z);
      const height = 4 + Math.floor(hash(i, 17) * 3);
      for (let level = 0; level < height; level++) trunks.push([x, y + level + 0.5, z, 0.85, 1, 0.85]);
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        if (Math.abs(dx) + Math.abs(dz) > 3) continue;
        leaves.push([x + dx * 1.25, y + height, z + dz * 1.25, 1.35, 1.5, 1.35,
          hash(dx + i, dz) > 0.5 ? 0x739e42 : 0x5f8a36]);
        if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1) leaves.push([x + dx * 1.25, y + height + 1.4, z + dz * 1.25, 1.35, 1.35, 1.35, 0x82aa4b]);
      }
      this.colliders.push({ x, z, radius: 0.65 });
    }
    this.batch(trunks, this.material({ map: dirtMap, color: 0x8c603f }));
    this.batch(leaves, this.material({ color: 0xffffff }));
    for (let i = 0; i < 430; i++) {
      const x = (hash(i, 71) * 2 - 1) * (this.radius - 4);
      const z = (hash(i, 91) * 2 - 1) * (this.radius - 4);
      if (this.waterAt(x, z) || this.pathAt(x, z) || Math.abs(x) < 17 && Math.abs(z) < 13) continue;
      const y = this.heightAt(x, z);
      if (i % 9 === 0) {
        rocks.push([x, y + 0.35, z, 0.9, 0.7, 0.85]);
      } else if (i % 3 === 0) {
        stems.push([x, y + 0.28, z, 0.09, 0.55, 0.09]);
        flowers.push([x, y + 0.58, z, 0.34, 0.15, 0.34, i % 2 ? 0xffdf72 : 0xedf0d3]);
      } else grassTufts.push([x, y + 0.2, z, 0.15, 0.4, 0.5]);
    }
    this.batch(rocks, stone);
    this.batch(stems.concat(grassTufts), this.material({ color: 0x5f923d }), { shadow: false });
    this.batch(flowers, this.material({ color: 0xffffff }), { shadow: false });

    const wood = this.material({ color: 0x9b7046 });
    const bridge = [];
    const river = this.riverX(20);
    for (let x = river - 7; x <= river + 7; x += 0.75) {
      bridge.push([x, 0.04, 20, 0.69, 0.3, 3.6]);
      if (Math.floor(x * 4) % 5 === 0) for (const z of [18.1, 21.9]) bridge.push([x, 0.65, z, 0.18, 1.2, 0.18]);
    }
    for (const z of [18.1, 21.9]) bridge.push([river, 1.1, z, 14.3, 0.14, 0.14]);
    this.batch(bridge, wood);

    const clouds = [];
    for (let i = 0; i < 20; i++) {
      const x = (hash(i, 26) - 0.5) * 260;
      const z = (hash(i, 39) - 0.5) * 260;
      const y = 31 + hash(i, 11) * 18;
      const w = 6 + hash(i, 18) * 10;
      clouds.push([x, y, z, w, 1.8, 5 + hash(i, 23) * 5]);
      clouds.push([x - w * 0.25, y + 1.3, z, w * 0.6, 1.4, 4]);
    }
    this.cloudMesh = this.batch(clouds, this.material({ color: 0xfff9ec }), { shadow: false, receive: false });
    const mountain = [], snow = [];
    for (let i = 0; i < 21; i++) {
      const angle = i / 21 * Math.PI * 2;
      const r = this.radius + 20 + hash(i, 13) * 18;
      const x = Math.cos(angle) * r, z = Math.sin(angle) * r;
      const h = 15 + hash(i, 3) * 23;
      for (let step = 0; step < 6; step++) {
        const width = 24 - step * 3.6;
        const item = [x, step * h / 6 + h / 12, z, width, h / 6, width];
        (step > 3 && h > 29 ? snow : mountain).push(item);
      }
    }
    this.batch(mountain, this.material({ color: 0x7d9290 }), { shadow: false });
    this.batch(snow, this.material({ color: 0xe6efdf }), { shadow: false });

    const posts = [], lamps = [];
    for (const z of [-18, 2, 18, 36]) for (const x of [-3.3, 3.3]) {
      posts.push([x, 1.05, z, 0.22, 2.1, 0.22]);
      lamps.push([x, 2.22, z, 0.55, 0.4, 0.55]);
    }
    this.batch(posts, wood);
    this.batch(lamps, new THREE.MeshBasicMaterial({ color: 0xffdc84 }));
    // Ensure the manually supplied emissive material is disposed with the rest.
    this.materials.push(this.group.children.at(-1).material);
  }

  dispose() {
    this.group.traverse((object) => { if (object.isInstancedMesh) object.dispose(); });
    this.geometry.dispose();
    this.materials.forEach((material) => material.dispose());
    this.textures.forEach((texture) => texture.dispose());
    this.group.clear();
  }
}
