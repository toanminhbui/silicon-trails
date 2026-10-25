import * as THREE from 'three';

/** Unconstrained camera flight. Movement uses the camera's current orientation. */
export class FreeFlightPlayer {
  constructor() {
    this.position = new THREE.Vector3(0, 6, 23);
    this.eyeHeight = 0;
    this.distanceWalked = 0;
    this.grounded = false;
  }

  spawn(x = 0, z = 23, y = 6) { this.position.set(x, y, z); }
  blocked() { return false; }

  update(delta, keys, camera) {
    camera.updateMatrixWorld(true);
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const movement = new THREE.Vector3();
    const has = (...codes) => codes.some((code) => keys.has(code));
    if (has('KeyW', 'ArrowUp')) movement.add(forward);
    if (has('KeyS', 'ArrowDown')) movement.sub(forward);
    if (has('KeyD', 'ArrowRight')) movement.add(right);
    if (has('KeyA', 'ArrowLeft')) movement.sub(right);
    if (has('Space')) movement.y += 1;
    if (has('KeyQ', 'KeyC')) movement.y -= 1;
    if (movement.lengthSq()) movement.normalize().multiplyScalar(delta * (has('ShiftLeft', 'ShiftRight') ? 15 : 6));
    this.position.add(movement);
    this.distanceWalked += movement.length();
    camera.position.copy(this.position);
    return movement.lengthSq() > 0;
  }

  state() {
    return { position: this.position.toArray(), distanceWalked: this.distanceWalked, grounded: false, flying: true };
  }
}

// Preserve imports and project integrations from the original exploration view.
export { FreeFlightPlayer as MeadowPlayer };
