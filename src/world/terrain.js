import * as THREE from 'three';

/** A spacious, unobstructed reference grid. It imposes no flight boundaries. */
export class ProcessorLab {
  constructor() {
    this.group = new THREE.Group();
    this.radius = Infinity;
    this.clearX = this.clearZ = Infinity;
    this.colliders = [];
    this.materials = [];
    const floorMaterial = new THREE.MeshBasicMaterial({
      color: 0x101c2d, transparent: true, opacity: 0.32,
      side: THREE.DoubleSide, depthWrite: false,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.2;
    this.group.add(floor);
    const largeGrid = new THREE.GridHelper(1200, 120, 0x36516a, 0x1c3045);
    largeGrid.position.y = -0.15;
    largeGrid.material.transparent = true;
    largeGrid.material.opacity = 0.48;
    this.group.add(largeGrid);
    const fineGrid = new THREE.GridHelper(160, 160, 0x3c5870, 0x25374d);
    fineGrid.position.y = -0.145;
    fineGrid.material.transparent = true;
    fineGrid.material.opacity = 0.24;
    this.group.add(fineGrid);
  }
  heightAt() { return 0; }
  dispose() {
    this.group.traverse((object) => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose();
    });
    this.group.clear();
  }
}

export { ProcessorLab as VoxelTerrain };
