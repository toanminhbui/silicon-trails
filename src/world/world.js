import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VoxelTerrain } from './terrain.js';
import { MeadowPlayer } from './player.js';

const PALETTE = {
  register: 0x58b9ff, alu: 0xffb84c, control: 0xbd8aff,
  memory: 0x7ee5a2, input: 0x69ded5, output: 0xff8d77, logic: 0x91b3ce,
};

function category(node) {
  const text = `${node.kind || ''} ${node.type || ''} ${node.label || ''}`.toLowerCase();
  if (/memory|\bram\b|\brom\b|cache/.test(text)) return 'memory';
  if (/control|decode|sequenc|fsm/.test(text)) return 'control';
  if (/register|\bdff\b|\bsdff|\badff|counter|\bpc\b|\bir\b/.test(text)) return 'register';
  if (/\balu\b|\$add|\$sub|adder|arithmetic|multiply/.test(text)) return 'alu';
  if (/input|constant|switch|clock/.test(text)) return 'input';
  if (/output|display|lamp/.test(text)) return 'output';
  return 'logic';
}

function signal(value) {
  if (value && typeof value === 'object') return { value: value.value, active: !!value.active };
  return { value, active: value !== null && value !== undefined && Number(value) !== 0 };
}

function formatValue(value, width = 8) {
  if (value === undefined) return '—';
  if (value === null || !Number.isFinite(Number(value))) return 'UNKNOWN';
  const n = Number(value) >>> 0;
  if (width === 1) return `${n & 1}  ·  ${n & 1 ? 'HIGH' : 'LOW'}`;
  return `0x${n.toString(16).toUpperCase().padStart(Math.min(8, Math.ceil(width / 4)), '0')}  ·  ${n}`;
}

function roundedRect(context, x, y, w, h, radius) {
  context.beginPath();
  context.roundRect(x, y, w, h, radius);
}

function viewScale(value, min, max, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be a finite number`);
  return THREE.MathUtils.clamp(number, min, max);
}

/** Spatial circuit view. World coordinates describe placement, never signal delay. */
export class CircuitWorld {
  constructor(container, { onSelect, onConnect, onPlace, onPause, onMove, onTarget } = {}) {
    this.container = container;
    this.callbacks = { onSelect, onConnect, onPlace, onPause, onMove, onTarget };
    this.mode = 'walk';
    this.paused = true;
    this.panorama = false;
    this.lastTarget = null;
    this.targetTimer = 0;
    this.moveTimer = 0;
    this.visualTime = 0;
    this.renderDirty = true;
    this.tool = null;
    this.layoutScale = 1;
    this.componentScale = 1;
    this.partScales = new Map();
    this.nodes = new Map();
    this.edges = new Map();
    this.pickables = [];
    this.keys = new Set();
    this.disposed = false;
    this.design = { nodes: [], edges: [] };
    this.sharedGeometries = new Set();
    this.sharedMaterials = new Set();
    this.bounds = { x: 0, z: 0, width: 44, depth: 42 };
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.pointerWorld = new THREE.Vector3();
    this.clock = new THREE.Clock();

    try {
      this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch (error) {
      this.fallback = document.createElement('canvas');
      this.fallback.setAttribute('aria-label', 'WebGL is unavailable. Use the circuit inspector and signal trace.');
      this.fallback.style.cssText = 'width:100%;height:100%;display:block;';
      container.appendChild(this.fallback);
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
      this.resize();
      return;
    }

    this.canvas = this.renderer.domElement;
    this.canvas.style.cssText = 'width:100%;height:100%;display:block;outline:none;touch-action:none;';
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('aria-label', 'Processor lab. W A S D or arrows to fly, Space up, Q or C down, Shift boost. Mouse to look, E to inspect. Escape pauses.');
    container.appendChild(this.canvas);
    const gl = this.renderer.getContext();
    const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const gpuName = rendererInfo ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL) : '';
    this.softwareRenderer = /swiftshader|llvmpipe|software|lavapipe/i.test(gpuName);
    this.renderer.setPixelRatio(this.softwareRenderer ? 0.55 : Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.shadowMap.enabled = !this.softwareRenderer;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070f1c);
    this.scene.fog = new THREE.Fog(0x070f1c, 100, 400);
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.08, 380);
    this.camera.position.set(28, 30, 35);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.enabled = false;
    this.controls.dampingFactor = 0.085;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 180;
    this.controls.target.set(0, 0, 0);
    this.controlChange = () => { this.renderDirty = true; };
    this.controls.addEventListener('change', this.controlChange);

    this.boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.sharedGeometries.add(this.boxGeometry);
    this.cableMaterial = new THREE.MeshStandardMaterial({ color: 0x07131c, metalness: 0.5, roughness: 0.65 });
    this.sharedMaterials.add(this.cableMaterial);
    this.nodeGroup = new THREE.Group();
    this.edgeGroup = new THREE.Group();
    this.boardGroup = new THREE.Group();
    this.scene.add(this.boardGroup, this.edgeGroup, this.nodeGroup);

    const ambient = new THREE.HemisphereLight(0xc6e4ff, 0x1a2b40, 1.9);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffefdc, 2.6);
    sun.position.set(-32, 58, 24);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -65;
    sun.shadow.camera.right = sun.shadow.camera.top = 65;
    sun.shadow.camera.far = 170;
    sun.shadow.normalBias = 0.045;
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x81b7ff, 1.1);
    rim.position.set(12, 16, -26);
    this.scene.add(rim);
    this.scene.add(this.camera);

    this.halo = new THREE.Group();
    const haloMaterial = new THREE.MeshBasicMaterial({ color: 0xf7dd86, transparent: true, opacity: 0.9 });
    for (const z of [-1.8, 1.8]) this.halo.add(this.box(4.2, 0.06, 0.055, 0, 0.17, z, haloMaterial));
    for (const x of [-2.07, 2.07]) this.halo.add(this.box(0.055, 0.06, 3.65, x, 0.17, 0, haloMaterial));
    this.halo.visible = false;
    this.scene.add(this.halo);
    this.ghost = this.box(3.8, 0.3, 3.2, 0, 0.18, 0,
      new THREE.MeshBasicMaterial({ color: 0x7de6c3, transparent: true, opacity: 0.25, depthWrite: false }));
    this.ghost.visible = false;
    this.scene.add(this.ghost);
    this.connectionPreview = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineDashedMaterial({ color: 0xf7dd86, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.85 }),
    );
    this.connectionPreview.visible = false;
    this.scene.add(this.connectionPreview);
    this.beacon = new THREE.Group();
    const beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xffdd58, transparent: true, opacity: 0.85 });
    this.beacon.add(this.box(0.13, 6, 0.13, -2.7, 3, 0, beaconMaterial));
    this.beacon.add(this.box(1.5, 0.9, 0.1, -2.0, 5.35, 0, beaconMaterial));
    this.beacon.add(this.box(0.65, 0.65, 0.65, 0, 4.9, 0, beaconMaterial));
    this.beacon.visible = false;
    this.scene.add(this.beacon);

    this.handlers = {
      down: (e) => this.pointerDown(e), move: (e) => this.pointerMove(e), up: (e) => this.pointerUp(e),
      lockedMove: (e) => { if (document.pointerLockElement === this.canvas && !this.paused) this.look(e.movementX, e.movementY); },
      lock: () => this.pointerLockChanged(),
      leave: () => { this.ghost.visible = false; this.press = null; },
      keydown: (e) => this.keyDown(e), keyup: (e) => this.keys.delete(e.code),
      blur: () => { this.keys.clear(); this.press = null; if (!this.paused && !this.panorama) this.requestPause(); },
      context: (e) => e.preventDefault(),
    };
    this.canvas.addEventListener('pointerdown', this.handlers.down);
    this.canvas.addEventListener('pointermove', this.handlers.move);
    this.canvas.addEventListener('pointerup', this.handlers.up);
    this.canvas.addEventListener('pointerleave', this.handlers.leave);
    this.canvas.addEventListener('contextmenu', this.handlers.context);
    window.addEventListener('keydown', this.handlers.keydown);
    window.addEventListener('keyup', this.handlers.keyup);
    window.addEventListener('blur', this.handlers.blur);
    document.addEventListener('mousemove', this.handlers.lockedMove);
    document.addEventListener('pointerlockchange', this.handlers.lock);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.createBoard();
    this.player = new MeadowPlayer(this.terrain, () => [...this.nodes.values()].map((item) => ({ x: item.group.position.x, z: item.group.position.z })));
    this.player.spawn();
    this.resize();
    this.animate = this.animate.bind(this);
    this.frame = requestAnimationFrame(this.animate);
  }

  box(w, h, d, x, y, z, material) {
    const mesh = new THREE.Mesh(this.boxGeometry, material);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  label(text, { color = '#dcecf7', value = false, compact = false, scale = 3.5 } = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = compact ? 256 : 512;
    canvas.height = compact ? 80 : value ? 92 : 112;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(scale, scale * canvas.height / canvas.width, 1);
    sprite.renderOrder = 2;
    sprite.userData.drawLabel = (next) => {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      roundedRect(ctx, 2, 2, canvas.width - 4, canvas.height - 4, 13);
      ctx.fillStyle = value ? 'rgba(7, 18, 28, .95)' : 'rgba(9, 20, 32, .92)';
      ctx.fill();
      ctx.strokeStyle = value ? 'rgba(119, 161, 187, .3)' : 'rgba(137, 173, 194, .22)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.font = `${compact ? '600 50px' : value ? '500 44px' : '600 48px'} ${value ? 'ui-monospace, monospace' : 'system-ui, sans-serif'}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      const s = String(next);
      ctx.fillText(s.length > 25 ? `${s.slice(0, 23)}…` : s, canvas.width / 2, canvas.height / 2, canvas.width - 30);
      texture.needsUpdate = true;
    };
    sprite.userData.drawLabel(text);
    return sprite;
  }

  createBoard() {
    if (this.terrain) return;
    this.terrain = new VoxelTerrain();
    this.scene.add(this.terrain.group);
  }

  autoPositions(nodes) {
    const count = nodes.length;
    const columns = Math.max(3, Math.ceil(Math.sqrt(count * 1.25)));
    const rows = Math.ceil(count / columns);
    const sorted = [...nodes].sort((a, b) => {
      const rank = { input: 0, register: 1, logic: 2, alu: 3, control: 4, memory: 5, output: 6 };
      return rank[category(a)] - rank[category(b)];
    });
    const positions = new Map();
    sorted.forEach((n, i) => positions.set(n.id, [(i % columns - (columns - 1) / 2) * 6.8, 0,
      (Math.floor(i / columns) - (rows - 1) / 2) * 6.7]));
    return positions;
  }

  setDesign({ nodes = [], edges = [] } = {}) {
    if (this.disposed) return;
    const preserveCamera = this.mode !== 'orbit' || nodes.some((node) => this.nodes.has(node.id));
    this.design = { nodes, edges };
    this.renderDirty = true;
    if (!this.renderer) { this.resize(); return; }
    this.clearGroup(this.nodeGroup);
    this.clearGroup(this.edgeGroup);
    this.nodes.clear();
    this.edges.clear();
    this.pickables = [];
    this.connectionStart = null;
    this.connectionPreview.visible = false;
    this.halo.visible = false;
    this.selectedId = null;
    const positions = this.autoPositions(nodes);
    nodes.forEach((node) => {
      const position = node.position || positions.get(node.id);
      const group = this.createNode(node);
      group.position.fromArray(position);
      this.nodeGroup.add(group);
      this.nodes.set(node.id, { node, group, basePosition: [...position], ...group.userData.visual });
    });
    this.applySceneScale(false);
    this.createBoard();
    edges.forEach((edge, index) => this.createEdge(edge, index));
    if (!preserveCamera) this.resetCamera();
    this.setTutorialTarget(this.tutorialTargetId);
    this.setLabelVisibility(!this.panorama);
  }

  getViewSettings() {
    return { layoutScale: this.layoutScale, componentScale: this.componentScale, partScales: Object.fromEntries(this.partScales) };
  }

  setLayoutScale(value) {
    this.layoutScale = viewScale(value, 0.35, 3, 'Layout scale');
    this.applySceneScale();
    return this.layoutScale;
  }

  setComponentScale(value) {
    this.componentScale = viewScale(value, 0.4, 3, 'Component scale');
    this.applySceneScale();
    return this.componentScale;
  }

  setPartScale(id, value) {
    if (typeof id !== 'string' || !id) throw new Error('Select a component to scale');
    const scale = viewScale(value, 0.4, 3, 'Part scale');
    if (scale === 1) this.partScales.delete(id);
    else this.partScales.set(id, scale);
    this.applySceneScale();
    return scale;
  }

  applyViewSettings(settings = {}) {
    const layout = viewScale(settings.layoutScale ?? 1, 0.35, 3, 'Layout scale');
    const components = viewScale(settings.componentScale ?? 1, 0.4, 3, 'Component scale');
    const parts = new Map();
    for (const [id, value] of Object.entries(settings.partScales || {})) {
      parts.set(id, viewScale(value, 0.4, 3, 'Part scale'));
    }
    this.layoutScale = layout;
    this.componentScale = components;
    this.partScales = parts;
    this.applySceneScale();
    return this.getViewSettings();
  }

  applySceneScale(rebuildEdges = true) {
    if (!this.renderer) return;
    const bounds = new THREE.Box3();
    for (const [id, item] of this.nodes) {
      const scale = this.componentScale * (this.partScales.get(id) || 1);
      item.group.position.fromArray(item.basePosition).multiplyScalar(this.layoutScale);
      item.group.scale.setScalar(scale);
      bounds.expandByPoint(item.group.position.clone().add(new THREE.Vector3(3 * scale, 3 * scale, 2.5 * scale)));
      bounds.expandByPoint(item.group.position.clone().sub(new THREE.Vector3(3 * scale, 0, 2.5 * scale)));
    }
    if (this.nodes.size) {
      const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
      this.bounds = { x: center.x, z: center.z, width: Math.max(28, size.x + 8), depth: Math.max(23, size.z + 8) };
    }
    this.nodeGroup.updateMatrixWorld(true);
    if (rebuildEdges) {
      this.clearGroup(this.edgeGroup);
      this.edges.clear();
      this.design.edges.forEach((edge, index) => this.createEdge(edge, index));
      if (this.signalSnapshot) this.updateSignals(this.signalSnapshot);
      this.setLabelVisibility(!this.panorama);
    }
    this.ghost?.scale.setScalar(this.componentScale);
    this.select(this.selectedId);
    this.setTutorialTarget(this.tutorialTargetId);
    this.renderDirty = true;
    this.refreshTarget();
  }

  createNode(node) {
    const group = new THREE.Group();
    const kind = category(node);
    const color = new THREE.Color(PALETTE[kind]);
    const shell = new THREE.MeshStandardMaterial({ color: 0x263946, roughness: 0.6, metalness: 0.5 });
    const inset = new THREE.MeshStandardMaterial({ color: 0x101e2b, roughness: 0.75, metalness: 0.35 });
    const accent = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22, metalness: 0.4, roughness: 0.45 });
    const led = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9 });
    // Inspection targets the whole monument, including gaps between pillars.
    // Fine-grained construction tools exclude this volume and hit real ports.
    const inspectionProxy = this.box(3.9, 2.4, 3.25, 0, 1.16, 0,
      new THREE.MeshBasicMaterial({ visible: false }));
    inspectionProxy.castShadow = false;
    inspectionProxy.receiveShadow = false;
    inspectionProxy.userData = { nodeId: node.id, inspectionProxy: true };
    group.add(inspectionProxy);
    group.add(this.box(3.9, 0.24, 3.25, 0, 0.08, 0, shell));
    group.add(this.box(3.55, 0.12, 2.9, 0, 0.25, 0, inset));
    group.add(this.box(3.4, 0.045, 0.09, 0, 0.34, 1.38, accent));
    let height = 1.5;

    if (kind === 'memory') {
      for (let i = 0; i < 4; i++) {
        group.add(this.box(2.6, 0.25, 1.85, 0, 0.55 + i * 0.33, 0, shell));
        group.add(this.box(2.25, 0.12, 0.08, 0, 0.55 + i * 0.33, 0.96, i % 2 ? led : accent));
        for (let j = 0; j < 3; j++) group.add(this.box(0.38, 0.12, 0.5, (j - 1) * 0.7, 0.73 + i * 0.33, -0.05, inset));
      }
      height = 2.15;
    } else if (kind === 'register') {
      for (let i = 0; i < 4; i++) {
        group.add(this.box(0.53, 1.05 + (i % 2) * 0.18, 1.45, (i - 1.5) * 0.72, 0.94, 0, accent));
        group.add(this.box(0.39, 0.11, 0.08, (i - 1.5) * 0.72, 0.75, 0.78, led));
        group.add(this.box(0.4, 0.18, 1.06, (i - 1.5) * 0.72, 1.55 + (i % 2) * 0.08, 0, inset));
      }
      height = 2.0;
    } else if (kind === 'alu') {
      group.add(this.box(2.45, 0.6, 1.85, 0, 0.7, 0, accent));
      const chip = this.box(1.6, 0.35, 1.6, 0, 1.16, 0, inset);
      chip.rotation.y = Math.PI / 4;
      group.add(chip);
      group.add(this.box(0.7, 0.12, 0.7, 0, 1.43, 0, led));
      for (let i = -1; i <= 1; i++) {
        group.add(this.box(0.16, 0.15, 2.6, i * 0.7, 0.5, 0, shell));
        group.add(this.box(3.0, 0.15, 0.16, 0, 0.5, i * 0.6, shell));
      }
      height = 1.9;
    } else if (kind === 'control') {
      group.add(this.box(2.45, 0.6, 1.8, 0, 0.7, 0, shell));
      for (let i = -1; i <= 1; i++) {
        group.add(this.box(0.48, 0.55 + (i === 0 ? 0.4 : 0), 1.2, i * 0.72, 1.05, 0, accent));
        group.add(this.box(0.25, 0.09, 0.25, i * 0.72, 1.55 + (i === 0 ? 0.2 : 0), 0, led));
      }
      height = 2.15;
    } else {
      group.add(this.box(2.5, 0.7, 1.7, 0, 0.75, 0, accent));
      group.add(this.box(1.9, 0.18, 1.2, 0, 1.2, 0, inset));
      const bits = Math.min(8, Math.max(1, node.width || 4));
      for (let i = 0; i < bits; i++) group.add(this.box(0.13, 0.09, 0.14,
        (i - (bits - 1) / 2) * 0.25, 1.35, 0.18, led));
      height = 1.8;
    }

    const ports = Array.isArray(node.ports) && node.ports.length ? node.ports : [
      { name: 'in', direction: 'input', width: node.width || 8 },
      { name: 'out', direction: 'output', width: node.width || 8 },
    ];
    const sockets = new Map();
    const portLabels = [];
    for (const direction of ['input', 'output']) {
      const list = ports.filter((p) => p.direction === direction || p.direction === (direction === 'input' ? 'in' : 'out'));
      list.forEach((port, index) => {
        const portZ = list.length === 1 ? 0 : ((index / (list.length - 1)) - 0.5) * 2.15;
        const portX = direction === 'input' ? -1.99 : 1.99;
        const socket = this.box(0.26, 0.26, Math.min(0.38, 1.9 / list.length), portX, 0.42, portZ, led);
        socket.userData = { nodeId: node.id, port: port.name, direction };
        group.add(socket);
        this.pickables.push(socket);
        sockets.set(port.name, new THREE.Vector3(portX, 0.38, portZ));
        const tag = this.label(`${port.name} ${port.width}`, { compact: true, scale: 1.65, color: '#d9ede7' });
        tag.position.set(portX + (direction === 'input' ? -0.6 : 0.6), 0.9, portZ);
        tag.userData.nodeId = node.id;
        tag.userData.port = port.name;
        tag.userData.direction = direction;
        tag.visible = !!this.tool;
        tag.material.depthTest = false;
        tag.renderOrder = 5;
        portLabels.push(tag);
        group.add(tag);
        this.pickables.push(tag);
      });
    }
    const title = this.label(node.label || node.id, { color: `#${color.getHexString()}`, scale: 4.15 });
    title.position.set(0, height + 0.7, 0);
    group.add(title);
    const value = this.label('—', { value: true, scale: 3.05 });
    value.position.set(0, height + 0.1, 0.65);
    group.add(value);
    group.traverse((child) => {
      if (child.isMesh && !child.userData.nodeId) child.userData = { nodeId: node.id };
      if (child.isMesh && !this.pickables.includes(child)) this.pickables.push(child);
    });
    group.userData.visual = { accent, led, sockets, portLabels, titleLabel: title, valueLabel: value, lastValue: undefined, kind };
    return group;
  }

  portPosition(item, name, direction) {
    let port = item.sockets.get(name);
    if (!port) {
      const p = (item.node.ports || []).find((p) => p.direction === direction);
      port = p ? item.sockets.get(p.name) : null;
    }
    item.group.updateWorldMatrix(true, false);
    return item.group.localToWorld((port || new THREE.Vector3(direction === 'output' ? 2 : -2, 0.38, 0)).clone());
  }

  createEdge(edge, index) {
    const from = this.nodes.get(edge.from);
    const to = this.nodes.get(edge.to);
    if (!from || !to) return;
    const start = this.portPosition(from, edge.fromPort, 'output');
    const end = this.portPosition(to, edge.toPort, 'input');
    const lift = 0.03 + (index % 7) * 0.025;
    const lane = (start.x + end.x) / 2 + ((index % 5) - 2) * 0.22;
    const points = [start, new THREE.Vector3(start.x + 0.5, lift, start.z),
      new THREE.Vector3(lane, lift, start.z), new THREE.Vector3(lane, lift, end.z),
      new THREE.Vector3(end.x - 0.5, lift, end.z), end];
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal', 0.1);
    const geometry = new THREE.TubeGeometry(curve, 24, 0.055 + Math.min(16, edge.width || 1) * 0.0018, 5, false);
    const material = new THREE.MeshBasicMaterial({ color: PALETTE[from.kind], transparent: true, opacity: 0.45 });
    const cable = new THREE.Mesh(geometry, material);
    this.edgeGroup.add(cable);
    const jacket = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.095, 5, false), this.cableMaterial);
    jacket.position.y = -0.035;
    this.edgeGroup.add(jacket);
    const pulse = this.box(0.14, 0.14, 0.14, 0, 0, 0,
      new THREE.MeshBasicMaterial({ color: PALETTE[from.kind] }));
    pulse.visible = false;
    this.edgeGroup.add(pulse);
    let label = null;
    if (this.design.edges.length < 45) {
      label = this.label(edge.label || (edge.width > 1 ? `${edge.width}-bit` : ''), { value: true, scale: 1.9 });
      label.position.copy(curve.getPoint(0.5));
      label.position.y += 0.55;
      label.material.opacity = 0.75;
      this.edgeGroup.add(label);
    }
    this.edges.set(edge.id, { edge, material, pulse, curve, active: false, label, lastText: null, phase: (index * 0.137) % 1 });
  }

  updateSignals({ nodeValues = {}, edgeValues = {} } = {}) {
    if (!this.renderer || this.disposed) return;
    this.signalSnapshot = { nodeValues, edgeValues };
    this.renderDirty = true;
    const entries = (values) => values instanceof Map ? values.entries() : Object.entries(values);
    for (const [id, raw] of entries(nodeValues)) {
      const item = this.nodes.get(id);
      if (!item) continue;
      const { value, active } = signal(raw);
      const text = formatValue(value, item.node.width || 8);
      if (item.lastValue !== text) { item.valueLabel.userData.drawLabel(text); item.lastValue = text; }
      item.accent.emissiveIntensity = value === null ? 0.06 : active ? 0.55 : 0.15;
      item.led.emissiveIntensity = active ? 1.8 : 0.35;
    }
    for (const [id, raw] of entries(edgeValues)) {
      const item = this.edges.get(id);
      if (!item) continue;
      const { value, active } = signal(raw);
      item.active = active;
      item.material.opacity = value === null ? 0.12 : active ? 0.95 : 0.27;
      item.pulse.visible = active;
      if (item.label) {
        const text = `${item.edge.label ? `${item.edge.label}  ` : ''}${formatValue(value, item.edge.width || 8)}`;
        if (text !== item.lastText) { item.label.userData.drawLabel(text); item.lastText = text; }
      }
    }
  }

  select(id) {
    this.renderDirty = true;
    this.selectedId = id;
    if (!this.renderer) return;
    const item = this.nodes.get(id);
    this.halo.visible = !!item;
    if (item) { this.halo.position.copy(item.group.position); this.halo.scale.copy(item.group.scale); }
  }

  firstPerson() { return this.mode === 'walk' || this.mode === 'build'; }

  focus(id) {
    const item = this.nodes.get(id);
    if (!item || !this.renderer) return;
    this.select(id);
    if (this.firstPerson()) { this.teleportToNode(id); return; }
    const center = item.group.position.clone().add(new THREE.Vector3(0, 0.7, 0));
    this.flight = { target: center, position: center.clone().add(new THREE.Vector3(8, 8, 10)) };
  }

  teleportToNode(id) {
    const item = this.nodes.get(id);
    if (!item || !this.player) return false;
    this.panorama = false;
    this.renderDirty = true;
    const scale = item.group.scale.x;
    const center = item.group.position;
    this.player.spawn(center.x, center.z + 5.5 * scale, center.y + 1.8 * scale);
    this.camera.position.copy(this.player.position).add(new THREE.Vector3(0, this.player.eyeHeight, 0));
    this.camera.lookAt(center.clone().add(new THREE.Vector3(0, 1.2 * scale, 0)));
    this.camera.updateMatrixWorld(true);
    this.flight = null;
    this.callbacks.onMove?.(this.getPlayerState());
    this.lastTarget = null;
    this.refreshTarget();
    return true;
  }

  getPlayerState() {
    return this.player?.state() || { position: [0, 6, 23], distanceWalked: 0, grounded: false, flying: true };
  }

  setTutorialTarget(id) {
    this.tutorialTargetId = id || null;
    if (!this.beacon) return;
    const item = this.nodes.get(id);
    this.beacon.visible = !!item && !this.panorama;
    if (item) { this.beacon.position.copy(item.group.position); this.beacon.scale.copy(item.group.scale); }
    this.renderDirty = true;
  }

  resetCamera() {
    if (!this.renderer) return;
    if (this.firstPerson()) { this.startWalk({ reset: true }); return; }
    const { x, z, width, depth } = this.bounds;
    const distance = Math.max(width * 0.65, depth * 0.8, 24);
    const aspectFactor = Math.max(1, 1 / Math.max(0.45, this.camera.aspect));
    this.camera.position.set(x + distance * 0.55 * aspectFactor, distance * 0.8 * aspectFactor, z + distance * aspectFactor);
    this.controls.target.set(x, 0.3, z);
    this.camera.lookAt(this.controls.target);
    this.flight = null;
    this.controls.update();
  }

  setPaused(paused) {
    this.paused = !!paused;
    this.renderDirty = true;
    this.keys.clear();
    this.press = null;
    if (!this.renderer) return;
    this.controls.enabled = !this.paused && this.mode === 'orbit';
    if (this.paused) {
      this.ghost.visible = false;
      if (document.pointerLockElement === this.canvas) {
        this.ignoreUnlock = true;
        document.exitPointerLock?.();
      }
    }
  }

  startWalk({ reset = true, lock = false } = {}) {
    if (!this.renderer) return;
    this.panorama = false;
    this.mode = 'walk';
    this.controls.enabled = false;
    this.keys.clear();
    this.flight = null;
    this.camera.fov = 72;
    this.camera.updateProjectionMatrix();
    if (reset) {
      this.player.spawn(this.bounds.x, Math.max(23, this.bounds.z + this.bounds.depth / 2 + 6), Math.max(6, this.componentScale * 4));
      this.player.distanceWalked = 0;
    }
    this.camera.position.copy(this.player.position).add(new THREE.Vector3(0, this.player.eyeHeight, 0));
    if (reset) this.camera.lookAt(this.bounds.x, this.componentScale * 1.2, this.bounds.z);
    else if (this.walkQuaternion) this.camera.quaternion.copy(this.walkQuaternion);
    this.camera.updateMatrixWorld(true);
    this.canvas.style.cursor = 'crosshair';
    this.refreshPortLabels();
    this.setLabelVisibility(true);
    this.setTutorialTarget(this.tutorialTargetId);
    if (lock && (!navigator.userActivation || navigator.userActivation.isActive)) this.capturePointer();
    this.callbacks.onMove?.(this.getPlayerState());
    this.lastTarget = null;
    this.refreshTarget();
  }

  startPanorama() {
    this.panorama = true;
    this.setPaused(true);
    if (!this.renderer) return;
    this.setLabelVisibility(false);
    this.beacon.visible = false;
    this.controls.enabled = false;
    this.camera.fov = 62;
    this.camera.updateProjectionMatrix();
    const distance = Math.max(27, this.bounds.width * 0.75, this.bounds.depth * 0.9);
    this.camera.position.set(this.bounds.x + Math.sin(0.28) * distance, distance * 0.39, this.bounds.z + Math.cos(0.28) * distance);
    this.camera.lookAt(this.bounds.x, this.componentScale * 1.5, this.bounds.z);
    this.camera.updateMatrixWorld(true);
  }

  setMode(mode) {
    if (!['orbit', 'walk', 'build'].includes(mode)) return;
    if (mode === 'orbit' && this.firstPerson()) this.walkQuaternion = this.camera.quaternion.clone();
    this.mode = mode;
    this.panorama = false;
    this.setLabelVisibility(true);
    this.keys.clear();
    if (!this.renderer) return;
    this.controls.enabled = mode === 'orbit' && !this.paused;
    this.refreshPortLabels();
    this.canvas.style.cursor = mode === 'orbit' ? 'grab' : 'crosshair';
    this.ghost.visible = false;
    this.connectionStart = null;
    this.connectionPreview.visible = false;
    this.flight = null;
    if (mode === 'orbit') {
      if (document.pointerLockElement === this.canvas) { this.ignoreUnlock = true; document.exitPointerLock?.(); }
      this.camera.fov = 50;
      this.camera.updateProjectionMatrix();
      this.resetCamera();
    } else {
      this.camera.fov = 72;
      this.camera.updateProjectionMatrix();
      this.camera.position.copy(this.player.position).add(new THREE.Vector3(0, this.player.eyeHeight, 0));
      this.camera.lookAt(this.bounds.x, 1.3, this.bounds.z);
    }
  }

  refreshPortLabels() {
    for (const item of this.nodes.values()) item.portLabels.forEach((label) => { label.visible = !!this.tool && !this.panorama; });
  }

  setLabelVisibility(visible) {
    for (const item of this.nodes.values()) {
      if (item.titleLabel) item.titleLabel.visible = visible;
      item.valueLabel.visible = visible;
      item.portLabels.forEach((label) => { label.visible = visible && !!this.tool; });
    }
    for (const item of this.edges.values()) if (item.label) item.label.visible = visible;
    this.boardGroup?.traverse((object) => { if (object.isSprite) object.visible = visible; });
    this.renderDirty = true;
  }

  setTool(typeOrNull) {
    this.tool = typeOrNull;
    this.renderDirty = true;
    this.connectionStart = null;
    if (this.ghost) this.ghost.visible = false;
    if (this.connectionPreview) this.connectionPreview.visible = false;
    this.refreshPortLabels();

  }

  capturePointer() {
    if (this.paused || !this.firstPerson() || document.pointerLockElement === this.canvas) return;
    try { this.canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* Drag-to-look remains available. */ }
  }

  pointerLockChanged() {
    const locked = document.pointerLockElement === this.canvas;
    if (this.wasLocked && !locked && !this.paused && !this.ignoreUnlock) this.requestPause();
    this.wasLocked = locked;
    this.ignoreUnlock = false;
    this.keys.clear();
  }

  requestPause() {
    if (this.paused || this.panorama) return;
    this.setPaused(true);
    this.callbacks.onPause?.();
  }

  look(dx, dy) {
    if (this.paused || !this.firstPerson()) return;
    if (dx || dy) this.renderDirty = true;
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    euler.y -= dx * 0.0024;
    euler.x = Math.max(-1.46, Math.min(1.46, euler.x - dy * 0.0024));
    this.camera.quaternion.setFromEuler(euler);
  }

  updatePointer(event) {
    if (document.pointerLockElement === this.canvas) this.pointer.set(0, 0);
    else {
      const rect = this.canvas.getBoundingClientRect();
      this.pointer.set(((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
        -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1);
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  groundHit() {
    const point = this.raycaster.ray.intersectPlane(this.floor, this.pointerWorld);
    if (!point || point.distanceTo(this.camera.position) > 60) return null;
    const layout = this.layoutScale || 1;
    return new THREE.Vector3(Math.round(point.x / layout * 2) / 2 * layout, 0, Math.round(point.z / layout * 2) / 2 * layout);
  }

  pointerDown(event) {
    if (this.paused) return;
    this.canvas.focus({ preventScroll: true });
    this.press = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, button: event.button };
    this.flight = null;
    if (this.firstPerson() && event.button === 0) this.capturePointer();
  }

  pointerMove(event) {
    if (this.paused) return;
    this.updatePointer(event);
    if (this.press && document.pointerLockElement !== this.canvas) {
      const dx = event.clientX - this.press.lastX;
      const dy = event.clientY - this.press.lastY;
      if (Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) > 5) this.press.moved = true;
      if (this.firstPerson() && this.press.moved) this.look(dx * 1.5, dy * 1.5);
      this.press.lastX = event.clientX;
      this.press.lastY = event.clientY;
    }
    this.updateBuildingPreview();
  }

  updateBuildingPreview() {
    if (!this.tool || this.paused) { this.ghost.visible = false; return; }
    if (!['wire', 'connect'].includes(this.tool)) {
      const point = this.groundHit();
      const wasVisible = this.ghost.visible;
      this.ghost.visible = !!point;
      if (point) {
        point.y += 0.2;
        if (this.ghost.position.distanceToSquared(point) > 0.0001) this.renderDirty = true;
        this.ghost.position.copy(point);
      }
      if (wasVisible !== this.ghost.visible) this.renderDirty = true;
    }
    if (this.connectionStart) {
      const point = this.groundHit() || this.raycaster.ray.at(8, new THREE.Vector3());
      const source = this.nodes.get(this.connectionStart.from);
      if (source) {
        const start = this.portPosition(source, this.connectionStart.fromPort, 'output');
        const positions = this.connectionPreview.geometry.attributes.position;
        if (!this.connectionPreview.visible || Math.abs(positions.getX(1) - point.x) > 0.01 || Math.abs(positions.getY(1) - point.y - 0.35) > 0.01 || Math.abs(positions.getZ(1) - point.z) > 0.01) this.renderDirty = true;
        positions.setXYZ(0, start.x, start.y + 0.12, start.z);
        positions.setXYZ(1, point.x, point.y + 0.35, point.z);
        positions.needsUpdate = true;
        this.connectionPreview.computeLineDistances();
        this.connectionPreview.visible = true;
      }
    }
  }

  visibleHits() {
    return this.raycaster.intersectObjects(this.pickables.filter((object) => object.visible && !(this.tool && object.userData.inspectionProxy)), false)
      .filter((hit) => !this.firstPerson() || hit.distance <= 60);
  }

  pointerUp(event) {
    const press = this.press;
    this.press = null;
    if (this.paused || !press || press.moved || press.button !== 0) return;
    this.updatePointer(event);
    this.interact(this.visibleHits());
  }

  interact(hits) {
    if (this.paused) return;
    if (this.tool && !['wire', 'connect'].includes(this.tool)) {
      const position = this.groundHit();
      if (position && !hits.length) this.callbacks.onPlace?.({ type: this.tool, position: position.toArray().map((value) => value / this.layoutScale) });
      return;
    }
    if (!hits.length) {
      if (!this.firstPerson()) { this.select(null); this.callbacks.onSelect?.(null); }
      return;
    }
    const hit = hits[0].object.userData;
    if (['wire', 'connect'].includes(this.tool)) {
      const item = this.nodes.get(hit.nodeId);
      if (!this.connectionStart) {
        const port = (hit.direction === 'output' && hit.port) || item.node.ports?.find((p) => p.direction === 'output')?.name || 'out';
        this.connectionStart = { from: hit.nodeId, fromPort: port };
        this.select(hit.nodeId);
        this.callbacks.onSelect?.(hit.nodeId);
      } else if (this.connectionStart.from !== hit.nodeId || hit.direction === 'input') {
        const port = (hit.direction === 'input' && hit.port) || item.node.ports?.find((p) => p.direction === 'input')?.name || 'in';
        this.callbacks.onConnect?.({ ...this.connectionStart, to: hit.nodeId, toPort: port });
        this.connectionStart = null;
        this.connectionPreview.visible = false;
        this.select(hit.nodeId);
        this.callbacks.onSelect?.(hit.nodeId);
      }
      return;
    }
    this.select(hit.nodeId);
    this.callbacks.onSelect?.(hit.nodeId);
  }

  interactAtCenter() {
    if (this.paused) return false;
    this.camera.updateMatrixWorld(true);
    this.nodeGroup.updateMatrixWorld(true);
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hits = this.visibleHits();
    this.interact(hits);
    return hits.length > 0;
  }

  refreshTarget() {
    if (!this.renderer) return null;
    this.camera.updateMatrixWorld(true);
    this.nodeGroup.updateMatrixWorld(true);
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hits = this.visibleHits();
    const id = hits[0]?.object.userData.nodeId || null;
    const target = id ? { id, label: this.nodes.get(id)?.node.label || id, distance: hits[0].distance } : { id: null, label: '', distance: null };
    if (target.id !== this.lastTarget?.id || Math.abs((target.distance || 0) - (this.lastTarget?.distance || 0)) > 0.2) {
      this.lastTarget = target;
      this.callbacks.onTarget?.(target);
    }
    return target;
  }

  keyDown(event) {
    if (this.paused || event.target?.closest?.('input, textarea, select, [contenteditable=true], .cm-editor')) return;
    if (event.code === 'Escape') { this.requestPause(); return; }
    if (!this.firstPerson()) return;
    if (event.code === 'KeyE') {
      event.preventDefault();
      if (!event.repeat) this.interactAtCenter();
      return;
    }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyQ', 'KeyC', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
      event.preventDefault();
      this.keys.add(event.code);
      this.flight = null;
    }
  }

  animate() {
    if (this.disposed) return;
    const delta = Math.min(this.clock.getDelta(), 0.04);
    const renderTime = this.clock.elapsedTime;
    if (!this.paused || this.panorama) this.visualTime += delta;
    const time = this.visualTime;
    if (this.panorama && !this.softwareRenderer) {
      const angle = time * 0.018 + 0.28;
      const distance = Math.max(27, this.bounds.width * 0.75, this.bounds.depth * 0.9);
      this.camera.position.set(this.bounds.x + Math.sin(angle) * distance, distance * 0.39, this.bounds.z + Math.cos(angle) * distance);
      this.camera.lookAt(this.bounds.x, this.componentScale * 1.5, this.bounds.z);
    } else if (this.firstPerson() && !this.paused) {
      const moved = this.player.update(delta, this.keys, this.camera);
      if (moved) this.renderDirty = true;
      this.moveTimer += delta;
      if (moved && this.moveTimer > 0.08) { this.moveTimer = 0; this.callbacks.onMove?.(this.getPlayerState()); }
      this.targetTimer += delta;
      if (this.targetTimer > 0.1) {
        this.targetTimer = 0;
        this.refreshTarget();
        if (document.pointerLockElement === this.canvas) this.updateBuildingPreview();
      }
    }
    if (this.flight && !this.firstPerson() && !this.paused) {
      const factor = 1 - Math.exp(-delta * 7);
      this.camera.position.lerp(this.flight.position, factor);
      this.controls.target.lerp(this.flight.target, factor);
      if (this.camera.position.distanceTo(this.flight.position) < 0.03) this.flight = null;
    }
    if (this.mode === 'orbit' && !this.paused) this.controls.update();
    for (const item of this.edges.values()) if (item.active) item.pulse.position.copy(item.curve.getPoint((time * 0.24 + item.phase) % 1));
    if (this.halo.visible) this.halo.children.forEach((mesh) => { mesh.material.opacity = 0.75 + Math.sin(time * 3) * 0.15; });
    if (this.beacon.visible) {
      this.beacon.children[2].rotation.y = time * 0.6;
      this.beacon.children[2].position.y = 4.9 + Math.sin(time * 2.3) * 0.2;
    }
    if (this.terrain.cloudMesh) this.terrain.cloudMesh.position.x = Math.sin(time * 0.012) * 3;
    const shouldRender = this.softwareRenderer
      ? this.renderDirty && performance.now() >= (this.nextSoftwareRenderAt || 0)
      : (!this.paused || this.panorama || this.renderDirty) && renderTime - (this.lastRenderTime || -1) > 1 / 45;
    if (shouldRender) {
      this.renderer.render(this.scene, this.camera);
      this.lastRenderTime = renderTime;
      this.renderDirty = false;
      // A software WebGL draw can itself be slow. Start the idle interval only
      // after it returns so pointer/keyboard events always get a turn to run.
      if (this.softwareRenderer) this.nextSoftwareRenderAt = performance.now() + 250;
    }
    this.frame = requestAnimationFrame(this.animate);
  }

  resize() {
    if (this.disposed) return;
    this.renderDirty = true;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    if (this.fallback) {
      this.fallback.width = width;
      this.fallback.height = height;
      const ctx = this.fallback.getContext('2d');
      ctx.fillStyle = '#0b1420'; ctx.fillRect(0, 0, width, height);
      ctx.textAlign = 'center'; ctx.fillStyle = '#d8e7f1'; ctx.font = '600 20px system-ui';
      ctx.fillText('3D workshop needs WebGL', width / 2, height / 2 - 15);
      ctx.fillStyle = '#8aabbc'; ctx.font = '14px system-ui';
      ctx.fillText('The simulator, editor, and signal inspector remain available.', width / 2, height / 2 + 18, width - 30);
      return;
    }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  clearGroup(group) {
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    group.traverse((object) => {
      if (object.geometry && !this.sharedGeometries.has(object.geometry)) geometries.add(object.geometry);
      const mats = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      mats.forEach((material) => {
        if (this.sharedMaterials.has(material)) return;
        materials.add(material);
        if (material.map) textures.add(material.map);
      });
    });
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    textures.forEach((t) => t.dispose());
    group.clear();
  }

  dispose() {
    if (this.disposed) return;
    if (this.canvas && document.pointerLockElement === this.canvas) { this.ignoreUnlock = true; document.exitPointerLock?.(); }
    this.disposed = true;
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.frame);
    if (this.fallback) { this.fallback.remove(); return; }
    this.canvas.removeEventListener('pointerdown', this.handlers.down);
    this.canvas.removeEventListener('pointermove', this.handlers.move);
    this.canvas.removeEventListener('pointerup', this.handlers.up);
    this.canvas.removeEventListener('pointerleave', this.handlers.leave);
    window.removeEventListener('keydown', this.handlers.keydown);
    this.canvas.removeEventListener('contextmenu', this.handlers.context);
    window.removeEventListener('keyup', this.handlers.keyup);
    window.removeEventListener('blur', this.handlers.blur);
    document.removeEventListener('mousemove', this.handlers.lockedMove);
    document.removeEventListener('pointerlockchange', this.handlers.lock);
    this.controls.removeEventListener('change', this.controlChange);
    this.controls.dispose();
    if (this.terrain) { this.scene.remove(this.terrain.group); this.terrain.dispose(); }
    this.clearGroup(this.scene);
    this.sharedGeometries.forEach((g) => g.dispose());
    this.sharedMaterials.forEach((m) => m.dispose());
    this.renderer.dispose();
    this.canvas.remove();
    this.nodes.clear();
    this.edges.clear();
  }
}
