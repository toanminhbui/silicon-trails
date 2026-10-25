import * as THREE from 'three';

/** Grounded capsule approximation with sliding, jumping, and a single clock. */
export class MeadowPlayer {
  constructor(terrain, nodeColliders) {
    this.terrain = terrain;
    this.nodeColliders = nodeColliders;
    this.position = new THREE.Vector3(0, 0, 23);
    this.eyeHeight = 1.72;
    this.radius = 0.32;
    this.velocityY = 0;
    this.distanceWalked = 0;
    this.grounded = true;
    this.jumping = false;
  }

  spawn(x = 0, z = 23) {
    this.position.set(x, this.terrain.heightAt(x, z), z);
    this.velocityY = 0;
    this.grounded = true;
    this.jumping = false;
  }

  blocked(x, z) {
    if (Math.abs(x) > this.terrain.radius - 2 || Math.abs(z) > this.terrain.radius - 2) return true;
    for (const collider of this.terrain.colliders) {
      if (Math.hypot(x - collider.x, z - collider.z) < this.radius + collider.radius) return true;
    }
    for (const collider of this.nodeColliders()) {
      if (Math.abs(x - collider.x) < 2.0 + this.radius && Math.abs(z - collider.z) < 1.65 + this.radius) return true;
    }
    return this.terrain.heightAt(x, z) > this.position.y + 1.05;
  }

  update(delta, keys, camera) {
    const old = this.position.clone();
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0; forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const movement = new THREE.Vector3();
    const has = (...codes) => codes.some((code) => keys.has(code));
    if (has('KeyW', 'ArrowUp')) movement.add(forward);
    if (has('KeyS', 'ArrowDown')) movement.sub(forward);
    if (has('KeyD', 'ArrowRight')) movement.add(right);
    if (has('KeyA', 'ArrowLeft')) movement.sub(right);
    if (movement.lengthSq()) movement.normalize().multiplyScalar(delta * (has('ShiftLeft', 'ShiftRight') ? 8.6 : 5.0));
    const slices = Math.max(1, Math.ceil(movement.length() / 0.2));
    for (let i = 0; i < slices; i++) {
      const dx = movement.x / slices, dz = movement.z / slices;
      if (!this.blocked(this.position.x + dx, this.position.z)) this.position.x += dx;
      if (!this.blocked(this.position.x, this.position.z + dz)) this.position.z += dz;
    }
    const jump = keys.has('Space');
    if (jump && !this.jumping && this.grounded) { this.velocityY = 6.7; this.grounded = false; }
    this.jumping = jump;
    this.velocityY -= 18 * delta;
    this.position.y += this.velocityY * delta;
    const floor = this.terrain.heightAt(this.position.x, this.position.z);
    if (this.position.y <= floor) { this.position.y = floor; this.velocityY = 0; this.grounded = true; }
    else this.grounded = false;
    const distance = Math.hypot(this.position.x - old.x, this.position.z - old.z);
    this.distanceWalked += distance;
    camera.position.copy(this.position);
    camera.position.y += this.eyeHeight + (this.grounded && distance > 0.001 ? Math.sin(this.distanceWalked * 8) * 0.025 : 0);
    return distance > 0.0001 || Math.abs(this.position.y - old.y) > 0.0001;
  }

  state() {
    return { position: this.position.toArray(), distanceWalked: this.distanceWalked, grounded: this.grounded };
  }
}
