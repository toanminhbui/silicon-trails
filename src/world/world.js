import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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

/** Spatial circuit view. World coordinates describe placement, never signal delay. */
export class CircuitWorld {
  constructor(container, { onSelect, onConnect, onPlace } = {}) {
    this.container = container;
    this.callbacks = { onSelect, onConnect, onPlace };
    this.mode = 'orbit';
    this.tool = null;
    this.nodes = new Map();
    this.edges = new Map();
    this.pickables = [];
    this.keys = new Set();
    this.disposed = false;
    this.design = { nodes: [], edges: [] };
    this.sharedGeometries = new Set();
    this.sharedMaterials = new Set();
    this.bounds = { x: 0, z: 0, width: 34, depth: 26 };
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
    this.canvas.setAttribute('aria-label', 'Interactive 3D circuit workshop. Drag to orbit, scroll to zoom. Walk mode uses W A S D and Q E.');
    container.appendChild(this.canvas);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x080f1c);
    this.scene.fog = new THREE.FogExp2(0x080f1c, 0.0065);
    this.camera = new THREE.PerspectiveCamera(43, 1, 0.1, 700);
    this.camera.position.set(28, 30, 35);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.085;
    this.controls.maxPolarAngle = Math.PI * 0.485;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 180;
    this.controls.target.set(0, 0, 0);

    this.boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.sharedGeometries.add(this.boxGeometry);
    this.cableMaterial = new THREE.MeshStandardMaterial({ color: 0x07131c, metalness: 0.5, roughness: 0.65 });
    this.sharedMaterials.add(this.cableMaterial);
    this.nodeGroup = new THREE.Group();
    this.edgeGroup = new THREE.Group();
    this.boardGroup = new THREE.Group();
    this.scene.add(this.boardGroup, this.edgeGroup, this.nodeGroup);

    const ambient = new THREE.HemisphereLight(0xc6e2ff, 0x172825, 2.2);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffe3ba, 3.2);
    sun.position.set(-18, 35, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = sun.shadow.camera.bottom = -65;
    sun.shadow.camera.right = sun.shadow.camera.top = 65;
    sun.shadow.camera.far = 130;
    sun.shadow.normalBias = 0.045;
    this.scene.add(sun);
    const rim = new THREE.DirectionalLight(0x739fff, 2.1);
    rim.position.set(12, 16, -26);
    this.scene.add(rim);

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

    this.handlers = {
      down: (e) => this.pointerDown(e), move: (e) => this.pointerMove(e), up: (e) => this.pointerUp(e),
      leave: () => { this.ghost.visible = false; this.press = null; },
      keydown: (e) => this.keyDown(e), keyup: (e) => this.keys.delete(e.code),
      blur: () => { this.keys.clear(); this.press = null; },
      context: (e) => e.preventDefault(),
    };
    this.canvas.addEventListener('pointerdown', this.handlers.down);
    this.canvas.addEventListener('pointermove', this.handlers.move);
    this.canvas.addEventListener('pointerup', this.handlers.up);
    this.canvas.addEventListener('pointerleave', this.handlers.leave);
    this.canvas.addEventListener('contextmenu', this.handlers.context);
    this.canvas.addEventListener('keydown', this.handlers.keydown);
    window.addEventListener('keyup', this.handlers.keyup);
    window.addEventListener('blur', this.handlers.blur);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.createBoard();
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
    this.clearGroup(this.boardGroup);
    const { x, z, width, depth } = this.bounds;
    const surface = new THREE.MeshStandardMaterial({ color: 0x16262c, roughness: 0.88, metalness: 0.18 });
    const base = new THREE.MeshStandardMaterial({ color: 0x0d1721, roughness: 0.87, metalness: 0.1 });
    const edge = new THREE.MeshStandardMaterial({ color: 0x293b3d, roughness: 0.82 });
    const moss = new THREE.MeshStandardMaterial({ color: 0x42634d, roughness: 1 });
    this.boardGroup.add(this.box(width, 0.65, depth, x, -0.48, z, surface));
    this.boardGroup.add(this.box(width - 1.0, 1.5, depth - 1.0, x, -1.4, z, base));
    this.boardGroup.add(this.box(width + 0.15, 0.2, depth + 0.15, x, -0.82, z, edge));

    const vertices = [];
    const left = x - width / 2;
    const right = x + width / 2;
    const back = z - depth / 2;
    const front = z + depth / 2;
    for (let gx = Math.ceil(left); gx <= right; gx++) vertices.push(gx, -0.145, back, gx, -0.145, front);
    for (let gz = Math.ceil(back); gz <= front; gz++) vertices.push(left, -0.145, gz, right, -0.145, gz);
    const gridGeometry = new THREE.BufferGeometry();
    gridGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    this.boardGroup.add(new THREE.LineSegments(gridGeometry,
      new THREE.LineBasicMaterial({ color: 0x4b7476, transparent: true, opacity: 0.18 })));

    const light = new THREE.MeshBasicMaterial({ color: 0x71b2bd });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cx = x + sx * (width / 2 - 1.1);
        const cz = z + sz * (depth / 2 - 1.1);
        this.boardGroup.add(this.box(0.4, 0.45, 0.4, cx, 0.05, cz, light));
        for (let i = 0; i < 5; i++) {
          const size = 0.55 + ((i * 7 + (sx + sz + 2) * 3) % 5) * 0.16;
          this.boardGroup.add(this.box(size, 0.22, size, cx + sx * (0.1 + i * 0.4), -0.08, cz + sz * (i % 3) * 0.35, moss));
        }
      }
    }

    // A quiet surrounding floor keeps the island legible while walking.
    this.boardGroup.add(this.box(500, 0.3, 500, x, -2.55, z,
      new THREE.MeshStandardMaterial({ color: 0x0a1420, roughness: 1 })));
    const stamp = this.label('SILICON TRAILS', { scale: Math.min(width * 0.25, 6), color: '#83a1a9' });
    stamp.position.set(x, 0.05, front - 1.0);
    stamp.material.opacity = 0.65;
    this.boardGroup.add(stamp);
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
    const preserveCamera = this.mode === 'build' && nodes.some((node) => this.nodes.has(node.id));
    this.design = { nodes, edges };
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
    const box = new THREE.Box3();
    nodes.forEach((node) => {
      const position = node.position || positions.get(node.id);
      const group = this.createNode(node);
      group.position.fromArray(position);
      this.nodeGroup.add(group);
      this.nodes.set(node.id, { node, group, ...group.userData.visual });
      box.expandByPoint(group.position);
    });
    if (nodes.length) {
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      this.bounds = { x: center.x, z: center.z, width: Math.max(28, size.x + 14), depth: Math.max(23, size.z + 14) };
    } else this.bounds = { x: 0, z: 0, width: 34, depth: 26 };
    this.createBoard();
    edges.forEach((edge, index) => this.createEdge(edge, index));
    if (!preserveCamera) this.resetCamera();
  }

  createNode(node) {
    const group = new THREE.Group();
    const kind = category(node);
    const color = new THREE.Color(PALETTE[kind]);
    const shell = new THREE.MeshStandardMaterial({ color: 0x263946, roughness: 0.6, metalness: 0.5 });
    const inset = new THREE.MeshStandardMaterial({ color: 0x101e2b, roughness: 0.75, metalness: 0.35 });
    const accent = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22, metalness: 0.4, roughness: 0.45 });
    const led = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9 });
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
        tag.visible = this.mode === 'build';
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
    group.userData.visual = { accent, led, sockets, portLabels, valueLabel: value, lastValue: undefined, kind };
    return group;
  }

  portPosition(item, name, direction) {
    let port = item.sockets.get(name);
    if (!port) {
      const p = (item.node.ports || []).find((p) => p.direction === direction);
      port = p ? item.sockets.get(p.name) : null;
    }
    return item.group.position.clone().add(port || new THREE.Vector3(direction === 'output' ? 2 : -2, 0.38, 0));
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
    this.selectedId = id;
    if (!this.renderer) return;
    const item = this.nodes.get(id);
    this.halo.visible = !!item;
    if (item) this.halo.position.copy(item.group.position);
  }

  focus(id) {
    const item = this.nodes.get(id);
    if (!item || !this.renderer) return;
    this.select(id);
    const center = item.group.position.clone().add(new THREE.Vector3(0, 0.7, 0));
    this.flight = { target: center, position: center.clone().add(new THREE.Vector3(8, 8, 10)) };
  }

  resetCamera() {
    if (!this.renderer) return;
    const { x, z, width, depth } = this.bounds;
    const distance = Math.max(width * 0.78, depth * 0.95, 24);
    const aspectFactor = Math.max(1, 1 / Math.max(0.45, this.camera.aspect));
    this.camera.position.set(x + distance * 0.78 * aspectFactor, distance * 0.94 * aspectFactor, z + distance * aspectFactor);
    this.controls.target.set(x, 0.3, z);
    this.camera.lookAt(this.controls.target);
    this.flight = null;
    this.controls.update();
  }

  setMode(mode) {
    if (!['orbit', 'walk', 'build'].includes(mode)) return;
    this.mode = mode;
    this.keys.clear();
    if (!this.renderer) return;
    this.controls.enabled = mode !== 'walk';
    for (const item of this.nodes.values()) item.portLabels.forEach((label) => { label.visible = mode === 'build'; });
    this.canvas.style.cursor = mode === 'build' ? 'crosshair' : mode === 'walk' ? 'grab' : 'default';
    this.ghost.visible = false;
    this.connectionStart = null;
    this.connectionPreview.visible = false;
    if (mode === 'walk') {
      this.flight = null;
      const direction = new THREE.Vector3();
      this.camera.getWorldDirection(direction);
      this.camera.position.y = Math.max(3, Math.min(this.camera.position.y, 7));
      direction.y = Math.max(-0.35, direction.y);
      this.camera.lookAt(this.camera.position.clone().add(direction));
      this.canvas.focus({ preventScroll: true });
    } else {
      const direction = new THREE.Vector3();
      this.camera.getWorldDirection(direction);
      const distance = Math.max(8, this.camera.position.y / Math.max(0.15, -direction.y));
      this.controls.target.copy(this.camera.position).addScaledVector(direction, Math.min(distance, 80));
      this.controls.target.y = Math.max(0, this.controls.target.y);
      this.controls.update();
    }
  }

  setTool(typeOrNull) {
    this.tool = typeOrNull;
    this.connectionStart = null;
    if (this.ghost) this.ghost.visible = false;
    if (this.connectionPreview) this.connectionPreview.visible = false;
  }

  updatePointer(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
      -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  pointerDown(event) {
    this.canvas.focus({ preventScroll: true });
    this.press = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, button: event.button };
    if (this.mode === 'walk') this.canvas.style.cursor = 'grabbing';
    this.flight = null;
  }

  pointerMove(event) {
    this.updatePointer(event);
    if (this.press) {
      const dx = event.clientX - this.press.lastX;
      const dy = event.clientY - this.press.lastY;
      if (Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) > 5) this.press.moved = true;
      if (this.mode === 'walk' && this.press.moved) {
        const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
        euler.y -= dx * 0.004;
        euler.x = Math.max(-1.35, Math.min(1.35, euler.x - dy * 0.004));
        this.camera.quaternion.setFromEuler(euler);
      }
      this.press.lastX = event.clientX;
      this.press.lastY = event.clientY;
    }
    if (this.mode === 'build' && this.tool && !['wire', 'connect'].includes(this.tool)) {
      const hit = this.raycaster.ray.intersectPlane(this.floor, this.pointerWorld);
      if (hit) {
        this.ghost.visible = true;
        this.ghost.position.set(Math.round(hit.x * 2) / 2, 0.2, Math.round(hit.z * 2) / 2);
      }
    }
    if (this.connectionStart && this.mode === 'build') {
      const hit = this.raycaster.ray.intersectPlane(this.floor, this.pointerWorld);
      const source = this.nodes.get(this.connectionStart.from);
      if (hit && source) {
        const start = this.portPosition(source, this.connectionStart.fromPort, 'output');
        const positions = this.connectionPreview.geometry.attributes.position;
        positions.setXYZ(0, start.x, start.y + 0.12, start.z);
        positions.setXYZ(1, hit.x, 0.35, hit.z);
        positions.needsUpdate = true;
        this.connectionPreview.computeLineDistances();
        this.connectionPreview.visible = true;
      }
    }
  }

  pointerUp(event) {
    const press = this.press;
    this.press = null;
    if (this.mode === 'walk') this.canvas.style.cursor = 'grab';
    if (!press || press.moved || press.button !== 0) return;
    this.updatePointer(event);
    const hits = this.raycaster.intersectObjects(this.pickables.filter((object) => object.visible), false);
    if (this.mode === 'build' && this.tool && !['wire', 'connect'].includes(this.tool)) {
      const position = this.raycaster.ray.intersectPlane(this.floor, this.pointerWorld);
      if (position && !hits.length) this.callbacks.onPlace?.({ type: this.tool, position: [Math.round(position.x * 2) / 2, 0, Math.round(position.z * 2) / 2] });
      return;
    }
    if (!hits.length) { this.select(null); this.callbacks.onSelect?.(null); return; }
    const hit = hits[0].object.userData;
    if (this.mode === 'build' && ['wire', 'connect'].includes(this.tool)) {
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

  keyDown(event) {
    if (event.code === 'Escape') { this.connectionStart = null; this.connectionPreview.visible = false; this.select(null); return; }
    if (this.mode !== 'walk') return;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight'].includes(event.code)) {
      event.preventDefault();
      this.keys.add(event.code);
      this.flight = null;
    }
  }

  animate() {
    if (this.disposed) return;
    const delta = Math.min(this.clock.getDelta(), 0.05);
    const time = this.clock.elapsedTime;
    if (this.mode === 'walk' && this.keys.size) {
      const forward = new THREE.Vector3();
      this.camera.getWorldDirection(forward);
      forward.y = 0;
      forward.normalize();
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0));
      const speed = delta * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 19 : 8);
      const has = (...keys) => keys.some((key) => this.keys.has(key));
      if (has('KeyW', 'ArrowUp')) this.camera.position.addScaledVector(forward, speed);
      if (has('KeyS', 'ArrowDown')) this.camera.position.addScaledVector(forward, -speed);
      if (has('KeyD', 'ArrowRight')) this.camera.position.addScaledVector(right, speed);
      if (has('KeyA', 'ArrowLeft')) this.camera.position.addScaledVector(right, -speed);
      if (has('KeyE')) this.camera.position.y += speed;
      if (has('KeyQ')) this.camera.position.y -= speed;
      this.camera.position.y = Math.max(0.8, Math.min(80, this.camera.position.y));
    }
    if (this.flight) {
      const factor = 1 - Math.exp(-delta * 7);
      this.camera.position.lerp(this.flight.position, factor);
      this.controls.target.lerp(this.flight.target, factor);
      if (this.mode === 'walk') this.camera.lookAt(this.flight.target);
      if (this.camera.position.distanceTo(this.flight.position) < 0.03) this.flight = null;
    }
    if (this.mode !== 'walk') this.controls.update();
    for (const item of this.edges.values()) {
      if (item.active) item.pulse.position.copy(item.curve.getPoint((time * 0.24 + item.phase) % 1));
    }
    if (this.halo.visible) this.halo.children.forEach((mesh) => { mesh.material.opacity = 0.75 + Math.sin(time * 3) * 0.15; });
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.animate);
  }

  resize() {
    if (this.disposed) return;
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
    this.disposed = true;
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.frame);
    if (this.fallback) { this.fallback.remove(); return; }
    this.canvas.removeEventListener('pointerdown', this.handlers.down);
    this.canvas.removeEventListener('pointermove', this.handlers.move);
    this.canvas.removeEventListener('pointerup', this.handlers.up);
    this.canvas.removeEventListener('pointerleave', this.handlers.leave);
    this.canvas.removeEventListener('keydown', this.handlers.keydown);
    this.canvas.removeEventListener('contextmenu', this.handlers.context);
    window.removeEventListener('keyup', this.handlers.keyup);
    window.removeEventListener('blur', this.handlers.blur);
    this.controls.dispose();
    this.clearGroup(this.scene);
    this.sharedGeometries.forEach((g) => g.dispose());
    this.sharedMaterials.forEach((m) => m.dispose());
    this.renderer.dispose();
    this.canvas.remove();
    this.nodes.clear();
    this.edges.clear();
  }
}
