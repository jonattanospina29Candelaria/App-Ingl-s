// Avatar 3D procedural (Three.js). Sin modelos externos: todo se construye con geometrías.
// Estados: idle | listening | thinking | speaking
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js';

const VISEMES = {
  a: [0.95, 1.0], e: [0.55, 1.2], i: [0.35, 1.3], o: [0.75, 0.7], u: [0.45, 0.55], y: [0.35, 1.25],
  m: [0.0, 0.9], b: [0.0, 0.9], p: [0.0, 0.9], f: [0.12, 1.05], v: [0.12, 1.05], w: [0.3, 0.6],
};

export class Avatar {
  constructor(container) {
    this.container = container;
    this.mode = 'idle';
    this.mouth = { open: 0, wide: 1, tOpen: 0, tWide: 1 };
    this.visemeQueue = [];
    this.speaking = false;
    this.lastBoundary = 0;
    this.blink = { next: 2, t: -1 };
    this.gaze = new THREE.Vector2(0, 0);
    this.gazeTarget = new THREE.Vector2(0, 0);
    this.nextSaccade = 1;
    this.pointer = new THREE.Vector2(0, 0);

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    container.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    this.camera.position.set(0, 0.25, 5.2);
    this.camera.lookAt(0, 0.05, 0);

    this.scene.add(new THREE.HemisphereLight(0xfff4e8, 0x3a4a66, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(2.5, 3, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8fb4ff, 1.2);
    rim.position.set(-3, 1.5, -2);
    this.scene.add(rim);

    this._build();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(container);
    window.addEventListener('pointermove', (e) => {
      this.pointer.set((e.clientX / window.innerWidth) * 2 - 1, -((e.clientY / window.innerHeight) * 2 - 1));
    });

    this.clock = new THREE.Clock();
    r.setAnimationLoop(() => this._tick());
  }

  _mat(color, rough = 0.6) {
    return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });
  }

  _build() {
    const skin = this._mat(0xf0c3a0, 0.55);
    const hairM = this._mat(0x3a2418, 0.8);
    const shirt = this._mat(0x2f6fde, 0.7);
    const dark = this._mat(0x1b1b22, 0.4);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    // Torso y cuello
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 1.0, 8, 24), shirt);
    torso.rotation.z = Math.PI / 2;
    torso.scale.set(1, 1, 0.55);
    torso.position.y = -1.2;
    this.root.add(torso);
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.05, 10, 32), this._mat(0xffffff, 0.8));
    collar.rotation.x = Math.PI / 2;
    collar.position.y = -0.72;
    this.root.add(collar);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.25, 0.55, 24), skin);
    neck.position.y = -0.5;
    this.root.add(neck);

    // Cabeza (pivote en el cuello)
    this.head = new THREE.Group();
    this.head.position.y = -0.45;
    this.root.add(this.head);
    const C = new THREE.Vector3(0, 0.75, 0); // centro de la cabeza dentro del pivote
    const add = (mesh, x, y, z) => { mesh.position.set(C.x + x, C.y + y, C.z + z); this.head.add(mesh); return mesh; };

    const skull = add(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), skin), 0, 0, 0);
    skull.scale.set(0.82, 1, 0.88);

    const hair = add(new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32, 0, Math.PI * 2, 0, Math.PI * 0.52), hairM), 0, 0.06, -0.05);
    hair.scale.set(0.87, 1.02, 0.95);
    hair.rotation.x = -0.32;
    // Mechón lateral
    const fringe = add(new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 16), hairM), 0.2, 0.66, 0.5);
    fringe.scale.set(0.9, 0.22, 0.45);
    fringe.rotation.set(0.45, 0.15, -0.3);

    for (const s of [-1, 1]) {
      const ear = add(new THREE.Mesh(new THREE.SphereGeometry(0.14, 20, 20), skin), s * 0.8, 0.0, 0.0);
      ear.scale.set(0.45, 1, 0.8);
    }

    // Ojos
    this.eyes = [];
    for (const s of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(C.x + s * 0.27, C.y + 0.08, 0.69);
      this.head.add(g);
      const white = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 24), this._mat(0xffffff, 0.25));
      g.add(white);
      const irisG = new THREE.Group();
      g.add(irisG);
      const iris = new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 20), this._mat(0x5a3a1c, 0.3));
      iris.position.z = 0.112; iris.scale.z = 0.5;
      irisG.add(iris);
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.04, 16, 16), dark);
      pupil.position.z = 0.15; pupil.scale.z = 0.4;
      irisG.add(pupil);
      const glint = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      glint.position.set(0.025, 0.03, 0.165);
      irisG.add(glint);
      // Párpado superior (piel) que baja al parpadear
      const lidMat = skin.clone(); lidMat.side = THREE.DoubleSide;
      const lid = new THREE.Mesh(new THREE.SphereGeometry(0.178, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), lidMat);
      lid.rotation.x = -1.35; // casi abierto
      g.add(lid);
      this.eyes.push({ g, irisG, lid });
    }

    // Cejas
    this.brows = [];
    for (const s of [-1, 1]) {
      const b = add(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.045, 0.05), hairM), s * 0.27, 0.3, 0.77);
      b.rotation.z = s * -0.08;
      b.userData.baseY = b.position.y;
      b.userData.side = s;
      this.brows.push(b);
    }

    // Nariz
    const nose = add(new THREE.Mesh(new THREE.SphereGeometry(0.085, 20, 20), this._mat(0xe8b08c, 0.55)), 0, -0.07, 0.86);
    nose.scale.set(0.85, 1.05, 1);

    // Mejillas
    for (const s of [-1, 1]) {
      const ch = add(new THREE.Mesh(new THREE.CircleGeometry(0.1, 24), new THREE.MeshBasicMaterial({ color: 0xff8f8f, transparent: true, opacity: 0.28 })), s * 0.43, -0.16, 0.75);
      ch.rotation.y = s * 0.55;
    }

    // Boca
    this.mouthG = new THREE.Group();
    this.mouthG.position.set(C.x, C.y - 0.3, 0.8);
    this.mouthG.rotation.x = -0.15;
    this.head.add(this.mouthG);
    this.mouthInner = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 16), this._mat(0x5a1e24, 0.8));
    this.mouthInner.scale.set(1, 0.1, 0.35);
    this.mouthG.add(this.mouthInner);
    this.teeth = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.035, 0.02), this._mat(0xfafafa, 0.3));
    this.teeth.position.set(0, 0.02, 0.04);
    this.mouthG.add(this.teeth);
    this.lips = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.03, 12, 40), this._mat(0xc4656a, 0.5));
    this.lips.scale.set(1, 0.3, 1);
    this.mouthG.add(this.lips);
  }

  _resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Encuadre: en pantallas angostas alejamos un poco la cámara
    this.camera.position.z = w / h < 0.8 ? 7 : 5.6;
    this.camera.updateProjectionMatrix();
  }

  setMode(mode) { this.mode = mode; }

  // Llamar al empezar/terminar la voz del tutor
  setSpeaking(on) {
    this.speaking = on;
    if (!on) { this.visemeQueue = []; this.mouth.tOpen = 0; this.mouth.tWide = 1; }
    this.setMode(on ? 'speaking' : 'idle');
  }

  // Llamar en cada evento "boundary" (palabra) de la síntesis de voz
  speakWord(word, rate = 1) {
    this.lastBoundary = performance.now() / 1000;
    const now = this.lastBoundary;
    const letters = (word || '').toLowerCase().replace(/[^a-z]/g, '');
    const step = 0.075 / rate;
    this.visemeQueue = [];
    [...letters].forEach((ch, i) => {
      const v = VISEMES[ch] || [0.28, 1];
      this.visemeQueue.push({ at: now + i * step, open: v[0], wide: v[1] });
    });
    this.visemeQueue.push({ at: now + letters.length * step, open: 0.08, wide: 1 });
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    const now = performance.now() / 1000;
    const lerp = (a, b, k) => a + (b - a) * Math.min(1, k * dt);

    // Respiración
    this.root.position.y = Math.sin(t * 1.6) * 0.012;

    // Boca
    if (this.speaking) {
      while (this.visemeQueue.length && this.visemeQueue[0].at <= now) {
        const v = this.visemeQueue.shift();
        this.mouth.tOpen = v.open; this.mouth.tWide = v.wide;
      }
      if (now - this.lastBoundary > 0.7) {
        // Sin eventos de palabra (común en Android): animación procedural
        const n = Math.abs(Math.sin(t * 10.5) * Math.sin(t * 4.3 + 1));
        this.mouth.tOpen = 0.12 + n * 0.7;
        this.mouth.tWide = 0.85 + Math.sin(t * 3.1) * 0.25;
      }
    }
    const m = this.mouth;
    m.open = lerp(m.open, m.tOpen, 22);
    m.wide = lerp(m.wide, m.tWide, 16);
    const smile = this.mode === 'idle' || this.mode === 'listening' ? 1 : 0.6;
    this.mouthInner.scale.set(m.wide * 0.95, 0.08 + m.open * 0.6, 0.35);
    this.lips.scale.set(m.wide * (1 + 0.05 * smile), 0.28 + m.open * 1.25, 1);
    this.teeth.visible = m.open > 0.25;
    this.teeth.scale.x = m.wide;

    // Cabeza
    const h = this.head.rotation;
    let tx = Math.sin(t * 0.7) * 0.03, ty = Math.sin(t * 0.45) * 0.1 + this.pointer.x * 0.12, tz = Math.sin(t * 0.37) * 0.03;
    if (this.mode === 'listening') { tz = 0.12; tx = -0.05; }
    if (this.mode === 'thinking') { tx = -0.12; ty = 0.18; tz = -0.05; }
    if (this.mode === 'speaking') { tx += Math.sin(t * 5.2) * 0.035 * (0.3 + m.open); }
    h.x = lerp(h.x, tx - this.pointer.y * 0.06, 4);
    h.y = lerp(h.y, ty, 3);
    h.z = lerp(h.z, tz, 3);

    // Mirada
    if (t > this.nextSaccade) {
      this.gazeTarget.set((Math.random() - 0.5) * 0.3 + this.pointer.x * 0.25, (Math.random() - 0.5) * 0.18 + this.pointer.y * 0.15);
      this.nextSaccade = t + 0.6 + Math.random() * 2.2;
    }
    const gt = this.mode === 'thinking' ? new THREE.Vector2(0.35, 0.35) : this.gazeTarget;
    this.gaze.x = lerp(this.gaze.x, gt.x, 18);
    this.gaze.y = lerp(this.gaze.y, gt.y, 18);

    // Parpadeo
    if (this.blink.t < 0 && t > this.blink.next) this.blink.t = 0;
    let lid = 0;
    if (this.blink.t >= 0) {
      this.blink.t += dt;
      const p = this.blink.t / 0.16;
      lid = p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2);
      if (p >= 1) { this.blink.t = -1; this.blink.next = t + 1.8 + Math.random() * 3.5; }
    }
    for (const e of this.eyes) {
      e.irisG.rotation.y = this.gaze.x;
      e.irisG.rotation.x = -this.gaze.y;
      // -1.35 abierto → 1.5 cerrado
      const open = this.mode === 'listening' ? -1.45 : -1.35;
      e.lid.rotation.x = open + (1.5 - open) * lid;
    }

    // Cejas
    for (const b of this.brows) {
      let up = 0;
      if (this.mode === 'listening') up = 0.05;
      if (this.mode === 'thinking') up = b.userData.side > 0 ? 0.07 : -0.01;
      if (this.mode === 'speaking') up = m.open * 0.03;
      b.position.y = lerp(b.position.y, b.userData.baseY + up, 8);
    }

    this.renderer.render(this.scene, this.camera);
  }
}
