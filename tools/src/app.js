// Click2Website — 3D scroll world (Three.js WebGL + CSS 3D sections).
// Vanilla port of the design-tool component: no React, no template runtime,
// three.js is bundled by esbuild so only the classes below ship.
import {
  ACESFilmicToneMapping, AdditiveBlending, BackSide, BoxGeometry, BufferAttribute, BufferGeometry,
  CanvasTexture, Color, DirectionalLight, ExtrudeGeometry, FogExp2, Group, HemisphereLight,
  InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  Object3D, PCFShadowMap, PerspectiveCamera, PlaneGeometry, PMREMGenerator, PointLight, Points,
  RepeatWrapping, Scene, ShaderMaterial, Shape, SpotLight, SRGBColorSpace, Vector3, WebGLRenderer
} from 'three';

const CONFIG = Object.assign({ accent: '#D4AF37', inboxEmail: 'Ashfan354@gmail.com', quality: 'auto', drift: true }, window.C2W_CONFIG || {});
const IDS = ['home', 'about', 'services', 'portfolio', 'ecommerce', 'why', 'testimonials', 'contact'];
// per station: [spot color, spot intensity, core light intensity, fog/background color]
const PRESET = [[0xfff7ea, 700, 130, 0x070605], [0xfffaf2, 900, 90, 0x070605], [0xfff7ea, 700, 170, 0x080705], [0xf6efe2, 620, 110, 0x060605], [0xf6efe2, 620, 110, 0x060605], [0xfff7ea, 800, 130, 0x070605], [0xffd7ae, 950, 60, 0x0b0805], [0xfff7ea, 720, 190, 0x080705]];
// The canvas sits behind the page with a 2.5px CSS blur, so rendering above 1x device pixels
// buys nothing visible. Quality steps the frame-time monitor can fall back through.
const QUALITY = [{ pr: 1 }, { pr: 0.85 }, { pr: 0.7, noGlass: true }, { pr: 0.6, noGlass: true, noShadow: true }];
const LOADER_MIN_MS = 900;

const get = (o, path) => path.split('.').reduce((v, k) => (v == null ? v : v[k]), o);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), lerp = (a, b, u) => a + (b - a) * u;

class App {
  constructor(root) {
    this.root = root; this.props = CONFIG;
    this.state = { active: 0, menuOpen: false, filter: 'all', sent: false, sending: false, err: '', isMobile: false, compact: false };
    const ref = n => root.querySelector('[data-ref="' + n + '"]');
    this.canvas = ref('canvas'); this.world = ref('world'); this.camEl = ref('cam'); this.spacer = ref('spacer'); this.loader = ref('loader'); this.formEl = ref('form'); this.typeEl = ref('type');
    this.mx = 0; this.my = 0; this.mxT = 0; this.myT = 0; this.s = 0; this.sTarget = 0; this.hoverNode = null;
    // template bindings: data-bind="prop:value {path}" / data-if="path" / data-text="path"
    this.binds = Array.from(root.querySelectorAll('[data-bind]')).map(el => ({
      el, cache: {},
      decls: el.dataset.bind.split(';').filter(Boolean).map(d => { const i = d.indexOf(':'); return { prop: d.slice(0, i), tpl: d.slice(i + 1) }; })
    }));
    this.ifs = Array.from(root.querySelectorAll('[data-if]')); this.texts = Array.from(root.querySelectorAll('[data-text]'));
    root.querySelectorAll('[data-on]').forEach(el => el.addEventListener('click', e => this[el.dataset.on](e)));
    root.querySelectorAll('[data-submit]').forEach(el => el.addEventListener('submit', e => this[el.dataset.submit](e)));
    this.render();
  }

  renderVals() {
    const { active: a, isMobile: m, filter: f, menuOpen, sent, err, compact } = this.state;
    const navc = {}, navbg = {}, rail = {}, railw = {};
    for (let i = 0; i < 8; i++) { navc[i] = a === i ? '#ffffff' : '#bdbab3'; navbg[i] = a === i ? 'rgba(255,255,255,0.08)' : 'transparent'; rail[i] = a === i ? 'var(--ac,#D4AF37)' : 'rgba(255,255,255,0.3)'; railw[i] = a === i ? '26px' : '8px'; }
    const fb = k => f === k ? { bg: 'var(--ac,#D4AF37)', fg: '#0b0a08', bd: 'transparent' } : { bg: 'rgba(12,12,16,0.5)', fg: '#d9d6cf', bd: 'rgba(255,255,255,0.14)' };
    return {
      navc, navbg, rail, railw, f: { all: fb('all'), int: fb('international'), loc: fb('local') },
      showLinks: !m, isMobile: m, showRail: !m, showWordmark: !compact, menuOpen, sent, notSent: !sent, err, hasErr: !!err, sendLabel: this.state.sending ? 'Sending…' : 'Book Consultation'
    };
  }
  render() {
    const V = this.renderVals();
    for (const b of this.binds) for (const d of b.decls) {
      const v = d.tpl.replace(/\{([\w.]+)\}/g, (_, k) => get(V, k));
      if (b.cache[d.prop] !== v) { b.cache[d.prop] = v; b.el.style.setProperty(d.prop, v); }
    }
    for (const el of this.ifs) { const on = !!get(V, el.dataset.if); if (el.hidden === on) el.hidden = !on; }
    for (const el of this.texts) { const v = String(get(V, el.dataset.text) ?? ''); if (el.textContent !== v) el.textContent = v; }
  }
  setState(patch) {
    Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
    this.render();
    const S = this.state, m = this.memo || (this.memo = { filter: 'all', sent: false });
    if (m.filter !== S.filter) { m.filter = S.filter; this.applyFilter(); }
    if (m.sent !== S.sent) { m.sent = S.sent; if (this.renderer) this.layout(); }
  }

  go = e => { e.preventDefault(); const i = +e.currentTarget.dataset.go; this.setState({ menuOpen: false }); this.scrollToStation(i); };
  toggleMenu = () => this.setState(s => ({ menuOpen: !s.menuOpen }));
  setFilter = e => this.setState({ filter: e.currentTarget.dataset.f });
  pickService = e => { const svc = e.currentTarget.dataset.svc; if (this.typeEl) this.typeEl.value = svc; this.scrollToStation(7); };
  submit = async e => {
    e.preventDefault();
    if (this.state.sending) return;
    const fd = new FormData(e.currentTarget), g = k => String(fd.get(k) || '').trim();
    const data = { name: g('name'), email: g('email'), phone: g('phone'), company: g('company'), type: g('type'), budget: g('budget'), details: g('details') };
    if (!data.name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email) || data.details.length < 10) { this.setState({ err: 'Please add your name, a valid email and a few words about your project.' }); return; }
    const inbox = (this.props.inboxEmail || 'Ashfan354@gmail.com').trim();
    this.setState({ sending: true, err: '' });
    try {
      // FormSubmit relays the submission to the inbox address (first send triggers a one-time activation email there).
      const res = await fetch('https://formsubmit.co/ajax/' + encodeURIComponent(inbox), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...data, _subject: 'New consultation request — ' + data.name + (data.type ? ' (' + data.type + ')' : ''), _template: 'table', _replyto: data.email, _captcha: 'false' }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || String(j.success) === 'false') throw new Error(j.message || ('HTTP ' + res.status));
      this.setState({ sent: true, sending: false });
    } catch (err) {
      console.warn('Form relay failed, falling back to mail client:', err);
      const body = Object.entries(data).map(([k, v]) => k[0].toUpperCase() + k.slice(1) + ': ' + v).join('\n');
      window.location.href = 'mailto:' + inbox + '?subject=' + encodeURIComponent('Consultation request — ' + data.name) + '&body=' + encodeURIComponent(body);
      this.setState({ sent: true, sending: false });
    }
  };

  scrollToStation(i) {
    if (this.seg) { window.scrollTo({ top: this.seg[i].d0 + 2, behavior: 'smooth' }); return; }
    const el = document.getElementById(IDS[i]);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 90, behavior: 'smooth' });
  }

  applyAccent() {
    const a = this.props.accent || '#D4AF37';
    this.root.style.setProperty('--ac', a);
    if (this.accent) { this.accent.set(a); this.coreLight.color.copy(this.accent); this.hoverLight.color.copy(this.accent); this.mats.red.color.copy(this.accent); this.mats.core.emissive.copy(this.accent); }
  }
  isLite() { const q = this.props.quality || 'auto'; return q === 'lite' || (q === 'auto' && this.mobile); }
  detectMobile() { return matchMedia('(max-width: 780px)').matches || (matchMedia('(pointer: coarse)').matches && innerWidth < 1100); }

  async boot() {
    this.applyAccent();
    this.mobile = this.detectMobile();
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (this.mobile) this.setState({ isMobile: true });
    const L = this.loader; if (L) L.style.display = 'flex';
    const t0 = performance.now();
    try {
      const probe = document.createElement('canvas');
      if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('WebGL unavailable');
      if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, new Promise(r => setTimeout(r, 1500))]);
      this.init3D(); this.layout(); this.bind();
      this.s = this.sTarget = clamp(window.scrollY, 0, this.L);
      // compile every shader while the loader is still up instead of stalling the first visible frame
      if (this.renderer.compileAsync) await this.renderer.compileAsync(this.scene, this.camera).catch(() => {});
      this.last = performance.now(); this.frame(this.last);
      this.world.style.visibility = '';
      this.raf = requestAnimationFrame(this.tick);
      // background tabs never fire rAF: keep the world composed at 1 fps so it is never caught half-built
      this.slow = setInterval(() => { if (document.hidden) this.tick(performance.now()); }, 1000);
      setTimeout(() => { this.hideLoader(); this.canvas.style.opacity = '1'; this.introStart = performance.now(); this.qWatch = performance.now() + 2500; }, Math.max(0, LOADER_MIN_MS - (performance.now() - t0)));
    } catch (e) { console.warn('3D disabled:', e); this.world.style.visibility = ''; this.hideLoader(); }
  }
  hideLoader() { const L = this.loader; if (!L) return; L.style.opacity = '0'; setTimeout(() => { L.style.display = 'none'; }, 950); }

  init3D() {
    const lite = this.lite = this.isLite();
    const renderer = this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: !lite, powerPreference: 'high-performance' });
    this.qLevel = 0; renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, QUALITY[0].pr));
    renderer.toneMapping = ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = !lite; renderer.shadowMap.type = PCFShadowMap;
    const scene = this.scene = new Scene();
    this.fogColor = new Color(0x070605); scene.background = this.fogColor;
    scene.fog = new FogExp2(0x070605, this.mobile ? 0.03 : 0.024); scene.fog.color = this.fogColor;
    this.camera = new PerspectiveCamera(42, 1, 0.1, 400);
    scene.environment = this.makeEnv();
    this.accent = new Color(this.props.accent || '#D4AF37');
    scene.add(new HemisphereLight(0x2a2620, 0x050505, 1.0));
    const spot = this.spot = new SpotLight(0xffffff, 700, 70, Math.PI / 4.5, 0.65, 2);
    spot.castShadow = !lite; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -0.0004; spot.shadow.normalBias = 0.02; spot.shadow.camera.near = 2; spot.shadow.camera.far = 70;
    scene.add(spot, spot.target);
    this.coreLight = new PointLight(this.accent, 130, 45, 2); scene.add(this.coreLight);
    this.hoverLight = new PointLight(this.accent, 0, 14, 2); scene.add(this.hoverLight);
    const fill = new DirectionalLight(0xffe3b0, 0.45); fill.position.set(-6, 9, 10); scene.add(fill);
    const M = this.mats = {};
    M.glass = new MeshPhysicalMaterial({ color: 0x4a4640, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.5, envMapIntensity: 1.3, clearcoat: 1, clearcoatRoughness: 0.06, depthWrite: false });
    M.black = new MeshPhysicalMaterial({ color: 0x0d0c0a, roughness: 0.3, metalness: 0.4, clearcoat: 0.7, clearcoatRoughness: 0.15, envMapIntensity: 1.0 });
    M.red = new MeshPhysicalMaterial({ color: this.accent.getHex(), roughness: 0.26, metalness: 0.85, clearcoat: 0.6, clearcoatRoughness: 0.15, envMapIntensity: 1.8 });
    M.chrome = new MeshStandardMaterial({ color: 0xd8dbe2, roughness: 0.14, metalness: 1, envMapIntensity: 2.2 });
    M.tower = new MeshPhysicalMaterial({ color: 0x4d4840, roughness: 0.05, metalness: 0, transparent: true, opacity: 0.24, envMapIntensity: 1.8, clearcoat: 1, clearcoatRoughness: 0.03, depthWrite: false });
    M.towerR = M.tower.clone(); M.towerR.opacity = 0.1;
    M.core = new MeshStandardMaterial({ color: 0x100407, emissive: this.accent.getHex(), emissiveIntensity: 1.3, roughness: 0.4 });
    const gc = document.createElement('canvas'); gc.width = gc.height = 256; const g = gc.getContext('2d');
    g.fillStyle = '#0b0a09'; g.fillRect(0, 0, 256, 256); g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 2; g.strokeRect(1, 1, 254, 254);
    const gt = new CanvasTexture(gc); gt.wrapS = gt.wrapT = RepeatWrapping; gt.repeat.set(250, 250); gt.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy()); gt.colorSpace = SRGBColorSpace;
    M.floor = new MeshStandardMaterial({ color: 0x1c1a16, map: gt, roughness: 0.32, metalness: 0.6, envMapIntensity: 0.9 });
  }

  makeEnv() {
    const pm = new PMREMGenerator(this.renderer), s = new Scene();
    const add = (w, h, d, x, y, z, c, i) => { const m = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial({ color: new Color(c).multiplyScalar(i) })); m.position.set(x, y, z); s.add(m); return m; };
    add(24, 24, 24, 0, 0, 0, 0x171512, 1).material.side = BackSide;
    add(8, 0.2, 8, 0, 11.8, 0, 0xffffff, 6);
    add(0.2, 6, 10, -11.8, 3, 0, 0xf3e8d2, 4);
    add(0.2, 4, 8, 11.8, 1, -3, 0xd4af37, 2.5);
    add(6, 4, 0.2, 4, 2, -11.8, 0xffffff, 3);
    add(10, 0.2, 10, 0, -11.8, 0, 0x2a2d36, 1);
    const tex = pm.fromScene(s, 0.04).texture; pm.dispose();
    s.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    return tex;
  }

  rrGeo(w, h, d, r) {
    const s = new Shape(), x = -w / 2, y = -h / 2; r = Math.max(0.01, Math.min(r, w / 2, h / 2));
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
    s.lineTo(x + w, y + h - r); s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false);
    s.lineTo(x + r, y + h); s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false);
    s.lineTo(x, y + r); s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
    const g = new ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 6 }); g.translate(0, 0, -d); return g;
  }

  buildWorld() {
    const S = this.scene, yTop = 6, yFloor = this.yFloor;
    if (this.worldGroup) { S.remove(this.worldGroup); this.worldGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    const G = this.worldGroup = new Group(); S.add(G);
    const pitch = this.pitch = 0.5, N = this.towerN = Math.ceil((yTop - yFloor) / pitch) + 1; this.towerTop = yTop;
    const pg = new BoxGeometry(4.6, 0.14, 4.6);
    const tower = this.tower = new InstancedMesh(pg, this.mats.tower, N); tower.frustumCulled = false;
    const refl = new InstancedMesh(pg, this.mats.towerR, N); refl.frustumCulled = false; refl.scale.y = -1; refl.position.y = 2 * yFloor;
    const m = new Matrix4();
    for (let k = 0; k < N; k++) { m.makeTranslation(0, yTop - k * pitch + (k < 12 ? 8 + k * 0.6 : 0), 0); tower.setMatrixAt(k, m); m.makeTranslation(0, yTop - k * pitch, 0); refl.setMatrixAt(k, m); }
    tower.instanceMatrix.needsUpdate = true; refl.instanceMatrix.needsUpdate = true; G.add(tower, refl);
    const H = yTop - yFloor + 1.5, ym = (yTop + yFloor) / 2 - 0.75;
    const core = new Mesh(new BoxGeometry(0.14, H, 0.14), this.mats.core); core.position.y = ym; G.add(core);
    const rg = new BoxGeometry(0.1, H, 0.1);
    [[-2.35, -2.35], [2.35, -2.35], [-2.35, 2.35], [2.35, 2.35]].forEach(([x, z]) => { const r = new Mesh(rg, this.mats.chrome); r.position.set(x, ym, z); G.add(r); });
    const floor = new Mesh(new PlaneGeometry(500, 500), this.mats.floor); floor.rotation.x = -Math.PI / 2; floor.position.y = yFloor; floor.receiveShadow = !this.lite; G.add(floor);
    const n = this.lite ? 260 : 900, pos = new Float32Array(n * 3), seed = new Float32Array(n), size = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 16; pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = yFloor + Math.random() * (yTop - yFloor + 8); pos[i * 3 + 2] = Math.sin(a) * r; seed[i] = Math.random(); size[i] = 0.6 + Math.random() * 1.6; }
    const geo = new BufferGeometry(); geo.setAttribute('position', new BufferAttribute(pos, 3)); geo.setAttribute('aSeed', new BufferAttribute(seed, 1)); geo.setAttribute('aSize', new BufferAttribute(size, 1));
    this.pMat = new ShaderMaterial({
      transparent: true, depthWrite: false, blending: AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uPR: { value: this.renderer.getPixelRatio() }, uColor: { value: new Color(0xffe2b0) }, uYMin: { value: yFloor }, uRange: { value: yTop - yFloor + 8 } },
      vertexShader: 'attribute float aSeed; attribute float aSize; uniform float uTime, uPR, uYMin, uRange; varying float vA;\nvoid main(){ vec3 p = position; p.y = uYMin + mod(p.y - uYMin + uTime * (0.08 + aSeed * 0.12), uRange); p.x += sin(uTime * 0.3 + aSeed * 20.0) * 0.4;\n vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mv; float d = -mv.z; gl_PointSize = clamp(aSize * uPR * 90.0 / d, 1.0, 40.0 * uPR); vA = smoothstep(60.0, 8.0, d) * (0.35 + 0.65 * fract(aSeed * 7.0)); }',
      fragmentShader: 'uniform vec3 uColor; varying float vA;\nvoid main(){ float r = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.05, r) * vA * 0.55; gl_FragColor = vec4(uColor, a); }'
    });
    const pts = new Points(geo, this.pMat); pts.frustumCulled = false; G.add(pts);
  }

  buildShards() {
    const g = this.groups[0];
    if (this.shards) this.shards.forEach(s => { g.remove(s.mesh); s.mesh.geometry.dispose(); });
    const defs = this.mobile
      ? [[-150, 300, -500, 120, 70, 'chrome'], [160, -330, -600, 90, 90, 'red'], [170, 330, -700, 140, 40, 'glass']]
      : [[-580, 300, -520, 170, 104, 'chrome'], [540, -300, -680, 96, 96, 'red'], [-470, -340, -600, 240, 40, 'glass'], [620, 320, -460, 130, 84, 'glass'], [-60, 470, -820, 160, 54, 'glass'], [280, -470, -560, 70, 120, 'chrome']];
    this.shards = defs.map(([x, y, z, w, h, mt], i) => {
      const mesh = new Mesh(this.rrGeo(w, h, 14, 14), this.mats[mt]); mesh.castShadow = mesh.receiveShadow = !this.lite; g.add(mesh);
      return { mesh, x, y, z, rx: Math.random() * 0.6 - 0.3, ry: Math.random() * 0.8 - 0.4, sx: 0.1 + Math.random() * 0.1, sy: 0.08 + Math.random() * 0.1, seed: Math.random() * 6, par: 0.4 + (i % 3) * 0.3 };
    });
  }

  mobileTweaks() {
    const root = this.root;
    root.querySelectorAll('[data-chips],[data-chip]').forEach(el => { if (el.dataset.orig == null) el.dataset.orig = el.getAttribute('style') || ''; });
    if (this.compact) {
      root.querySelectorAll('[data-chips]').forEach(w => Object.assign(w.style, { position: 'static', inset: 'auto', display: 'flex', flexWrap: 'wrap', gap: '10px', justifyContent: 'center', padding: '0 24px', marginTop: '34px', pointerEvents: 'auto' }));
      root.querySelectorAll('[data-chip]').forEach(c => Object.assign(c.style, { position: 'static', inset: 'auto' }));
    } else root.querySelectorAll('[data-chips],[data-chip]').forEach(el => { el.style.cssText = el.dataset.orig; });
    if (this.lite || this.noGlass) this.setGlass(false);
  }
  setGlass(on) {
    this.root.querySelectorAll('[data-glass]').forEach(el => {
      if (el.dataset.if === 'menuOpen') return; // the mobile menu overlay keeps its own blur (it only exists while open)
      if (on) { el.style.backdropFilter = ''; el.style.webkitBackdropFilter = ''; el.style.background = ''; }
      else { el.style.backdropFilter = 'none'; el.style.webkitBackdropFilter = 'none'; el.style.background = 'rgba(13,13,17,0.88)'; }
    });
  }

  // The CSS3D camera transform is `translate(vw/2, vh/2)` inside an element whose transform-origin
  // is the centre of the fixed, full-viewport world box. Both must describe the same box, and any
  // mismatch is multiplied by the scale3d(100) that turns scene units into pixels — half a
  // classic 15-17px scrollbar (which innerWidth counts but the fixed world does not cover) throws
  // every section ~800px sideways. So measure the world box itself, never innerWidth/innerHeight.
  viewBox() {
    const w = this.world.clientWidth || document.documentElement.clientWidth || innerWidth;
    const h = this.world.clientHeight || document.documentElement.clientHeight || innerHeight;
    return [w, h];
  }
  // Cheap part of a resize: camera, renderer, perspective. Safe to run every time the box changes.
  setViewport(vw, vh) {
    this.vw = vw; this.vh = vh;
    this.camera.aspect = vw / vh; this.camera.updateProjectionMatrix(); this.renderer.setSize(vw, vh, false);
    this.focal = this.camera.projectionMatrix.elements[5] * vh / 2; this.D0 = this.focal / 100;
    this.world.style.perspective = this.focal + 'px';
  }

  layout() {
    const world = this.world, camEl = this.camEl;
    Object.assign(world.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', overflow: 'hidden', pointerEvents: 'none', zIndex: '1', margin: '0' });
    Object.assign(camEl.style, { position: 'absolute', inset: '0', width: 'auto', transformStyle: 'preserve-3d', pointerEvents: 'none' });
    const [vw, vh] = this.viewBox(); this.setViewport(vw, vh); this.lw = vw; this.lh = vh; // box this layout was computed for
    // a window that opens small and is maximised later must not stay in phone mode
    const mobile = this.detectMobile();
    if (mobile !== this.mobile) { this.mobile = mobile; if (this.scene.fog) this.scene.fog.density = mobile ? 0.03 : 0.024; }
    if (mobile !== this.state.isMobile) this.setState({ isMobile: mobile, menuOpen: false });
    const secs = this.secs = Array.from(world.querySelectorAll('section[data-st]'));
    const W = Math.min(1280, vw - (this.mobile ? 32 : 72));
    this.compact = this.mobile || vw < 1100; if (this.compact !== this.state.compact) this.setState({ compact: this.compact });
    let keep = null;
    if (this.seg) { let i = this.seg.findIndex(g => this.s < g.d1); if (i < 0) i = this.seg.length - 1; keep = { i, rel: this.s - this.seg[i].t0 }; }
    this.mobileTweaks();
    secs.forEach(sec => Object.assign(sec.style, { display: '', position: 'absolute', left: '0', top: '0', margin: '0', width: W + 'px', maxWidth: 'none', transformStyle: 'preserve-3d', pointerEvents: 'auto', willChange: 'transform' }));
    secs[0].style.minHeight = vh + 'px';
    const H = secs.map(s => s.offsetHeight);
    const n = secs.length, R = this.R = this.mobile ? 5 : 7, dphi = (this.mobile ? 44 : 52) * Math.PI / 180;
    const st = this.st = []; let y = 0;
    for (let i = 0; i < n; i++) { if (i > 0) y -= Math.max(7, (H[i - 1] / 2 + H[i] / 2) / 100 + 3.5); st.push({ phi: i * dphi, y, H: H[i], pan: Math.max(0, H[i] - vh + 48) / 100 }); }
    if (!this.groups) this.groups = st.map(() => { const g = new Group(); g.scale.setScalar(0.01); this.scene.add(g); return g; });
    st.forEach((s, i) => { const g = this.groups[i]; g.position.set(R * Math.sin(s.phi), s.y, R * Math.cos(s.phi)); g.rotation.set(0, s.phi, 0); g.updateMatrixWorld(true); });
    // section transforms only change here, so build the strings once instead of every frame
    this.secTf = this.groups.map(g => 'translate(-50%,-50%)' + this.cssObj(g.matrixWorld)); this.secLast = secs.map(() => '');
    const travel = vh * 1.15, hold = vh * 0.4; let acc = 0; const seg = this.seg = [];
    st.forEach((s, i) => { const tr = i ? travel : 0, dw = s.pan * 100 + hold; seg.push({ t0: acc, t1: acc + tr, d0: acc + tr, d1: acc + tr + dw }); acc += tr + dw; });
    this.L = acc; this.spacer.style.height = Math.round(acc + vh) + 'px';
    const yF = st[n - 1].y - st[n - 1].pan / 2 - (this.mobile ? 7 : 9);
    if (this.yFloor === undefined || Math.abs(yF - this.yFloor) > 0.5) { this.yFloor = yF; this.buildWorld(); }
    this.buildShards(); this.collectNodes();
    if (keep) { const g = seg[keep.i], top = Math.min(g.t0 + keep.rel, g.d1 - 1); window.scrollTo(0, top); this.s = this.sTarget = top; }
  }

  rectIn(el, root) { let x = 0, y = 0, e = el; while (e && e !== root) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; } return { x, y, w: el.offsetWidth, h: el.offsetHeight }; }

  collectNodes() {
    (this.nodes || []).forEach(n => { if (n.pivot) { n.pivot.parent.remove(n.pivot); n.mesh.geometry.dispose(); } });
    const nodes = this.nodes = []; this.kMax = [];
    this.secs.forEach((sec, si) => {
      const W = sec.offsetWidth, Hs = sec.offsetHeight, arcs = new Map();
      sec.querySelectorAll('[data-arc]').forEach(g => { const rho = +g.dataset.arc || 1800; Array.from(g.children).forEach(ch => arcs.set(ch, rho)); });
      sec.querySelectorAll('[data-rv],[data-slab],[data-float]').forEach(el => {
        const r = this.rectIn(el, sec), cx = r.x + r.w / 2 - W / 2, cy = r.y + r.h / 2 - Hs / 2;
        let z0 = +(el.dataset.z || 0), ry0 = 0;
        if (this.compact && 'chip' in el.dataset) z0 = Math.min(z0, 40); // row-mode chips stay near the plane so the projected row fits the viewport
        const rho = arcs.get(el);
        if (rho) { const x = Math.max(-rho * 0.9, Math.min(rho * 0.9, cx)); ry0 = -Math.asin(x / rho); z0 -= rho - Math.sqrt(rho * rho - x * x); }
        const n = { el, si, k: +(el.dataset.rv || 0), cx, cy, w: r.w, h: r.h, z0, ry0, fl: +(el.dataset.float || 0), seed: Math.random() * 7, lift: 0, liftT: 0, dim: 0, dimT: 0, tx: 0, ty: 0, ttx: 0, tty: 0, last: '', lastOp: '', cat: el.dataset.cat };
        if (el.dataset.slab && r.w > 0 && r.h > 0) {
          const d = +(el.dataset.d || 16), rad = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
          const pivot = new Object3D(); pivot.position.set(cx, -cy, z0); pivot.rotation.y = ry0;
          const mesh = new Mesh(this.rrGeo(r.w, r.h, d, rad), this.mats[el.dataset.slab] || this.mats.glass);
          mesh.castShadow = mesh.receiveShadow = !this.lite; pivot.add(mesh); this.groups[si].add(pivot); n.pivot = pivot; n.mesh = mesh;
        }
        el.style.willChange = 'transform, opacity';
        nodes.push(n);
      });
      this.kMax[si] = Math.max(1, ...nodes.filter(n => n.si === si).map(n => n.k));
    });
    this.applyFilter();
  }

  applyFilter() {
    if (!this.nodes) return; const f = this.state.filter;
    this.nodes.forEach(n => { if (!n.cat) return; n.dimT = (f === 'all' || n.cat === f) ? 0 : 1; n.el.style.pointerEvents = n.dimT ? 'none' : ''; });
  }

  // Frame-time monitor: if the page can't hold ~45 fps while things move, step down through QUALITY.
  // Steps only go down (no flicker between levels); the worst case is a softer, shadow-less scene.
  applyQuality(level) {
    const q = QUALITY[this.qLevel = level], r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pr)); r.setSize(this.vw, this.vh, false);
    if (this.pMat) this.pMat.uniforms.uPR.value = r.getPixelRatio();
    if (q.noShadow && r.shadowMap.enabled) { r.shadowMap.enabled = false; this.spot.castShadow = false; this.scene.traverse(o => { if (o.material) o.material.needsUpdate = true; }); }
    if (q.noGlass && !this.noGlass) { this.noGlass = true; this.setGlass(false); }
  }
  watchFrame(raw) {
    // raw = ms since the previous animation frame. First learn the display's frame interval
    // (the fastest interval seen), then count frames that missed at least one vsync while the
    // scene is actually moving. A steady 30 Hz display never trips this; a GPU that can't keep
    // up on a 60/120 Hz display does.
    if (raw > 250 || this.qLevel >= QUALITY.length - 1) return;
    this.refresh = Math.max(6, Math.min(this.refresh || 40, raw));
    if (!this.qWatch || performance.now() < this.qWatch) return;
    if (!(Math.abs(this.sTarget - this.s) > 1 || this.hoverNode)) return;
    this.ftN = (this.ftN || 0) + 1; if (raw > this.refresh * 1.6) this.ftBad = (this.ftBad || 0) + 1;
    if (this.ftN < 60) return;
    const bad = this.ftBad / this.ftN; this.ftN = this.ftBad = 0;
    if (bad > 0.4) { this.applyQuality(this.qLevel + 1); this.qWatch = performance.now() + 2500; }
  }

  bind() {
    const root = this.root;
    const leave = nd => { nd.liftT = 0; nd.ttx = nd.tty = 0; if (this.hoverNode === nd) this.hoverNode = null; };
    const onMove = e => {
      this.mxT = (e.clientX / this.vw) * 2 - 1; this.myT = (e.clientY / this.vh) * 2 - 1;
      const hn = this.hoverNode; if (hn) { const r = hn.el.getBoundingClientRect(); if (r.width && r.height) { hn.ttx = ((e.clientY - r.top) / r.height - 0.5) * 7; hn.tty = -((e.clientX - r.left) / r.width - 0.5) * 7; } }
    };
    const onOver = e => { const el = e.target.closest && e.target.closest('[data-lift]'); if (!el) return; const nd = this.nodes.find(n => n.el === el); if (nd && nd !== this.hoverNode) { if (this.hoverNode) leave(this.hoverNode); this.hoverNode = nd; nd.liftT = 70; } };
    const onOut = e => { const el = e.target.closest && e.target.closest('[data-lift]'); if (el && this.hoverNode && this.hoverNode.el === el && !(e.relatedTarget && el.contains(e.relatedTarget))) leave(this.hoverNode); };
    // Watch the world box itself (not the window): it also changes when a scrollbar appears or
    // a phone's URL bar collapses. The camera is corrected straight away so nothing ever jumps;
    // the full relayout (section positions, scroll length, slabs) is debounced and only needed
    // when the width changes or the height moves a lot.
    const onResize = () => {
      const [w, h] = this.viewBox(); if (w === this.vw && h === this.vh) return;
      this.setViewport(w, h);
      clearTimeout(this.rz); this.rz = setTimeout(() => { const [w2, h2] = this.viewBox(); if (Math.abs(w2 - this.lw) > 2 || Math.abs(h2 - this.lh) > 120) this.layout(); }, 160);
    };
    const onVis = () => { if (document.hidden) cancelAnimationFrame(this.raf); else { this.last = performance.now(); this.raf = requestAnimationFrame(this.tick); } };
    window.addEventListener('pointermove', onMove, { passive: true }); root.addEventListener('pointerover', onOver); root.addEventListener('pointerout', onOut);
    if (typeof ResizeObserver === 'function') { this.ro = new ResizeObserver(onResize); this.ro.observe(this.world); }
    window.addEventListener('resize', onResize); document.addEventListener('visibilitychange', onVis);
  }

  pose(sPx) {
    const seg = this.seg, st = this.st; let i = seg.findIndex(g => sPx < g.d1); if (i < 0) i = seg.length - 1;
    const g = seg[i], s = st[i];
    if (i > 0 && sPx < g.t1) {
      let u = clamp((sPx - g.t0) / (g.t1 - g.t0), 0, 1); u = u * u * (3 - 2 * u); const a = st[i - 1];
      return { phi: lerp(a.phi, s.phi, u), y: lerp(a.y - a.pan / 2, s.y + s.pan / 2, u), pull: Math.sin(u * Math.PI) * (this.mobile ? 1.2 : 2.8) + (1 - u) * 0.8, frac: i - 1 + u };
    }
    const panPx = s.pan * 100, dwell = sPx - g.d0, v = panPx > 0 ? clamp(dwell / panPx, 0, 1) : 1, holdPx = (g.d1 - g.d0) - panPx, hh = holdPx > 0 ? clamp((dwell - panPx) / holdPx, 0, 1) : 0;
    return { phi: s.phi, y: s.y + s.pan / 2 - v * s.pan, pull: hh * 0.8, frac: i };
  }

  eps(v) { return Math.abs(v) < 1e-10 ? 0 : v; }
  cssCam(m) { const e = m.elements, p = this.eps; return 'matrix3d(' + [p(e[0]), p(-e[1]), p(e[2]), p(e[3]), p(e[4]), p(-e[5]), p(e[6]), p(e[7]), p(e[8]), p(-e[9]), p(e[10]), p(e[11]), p(e[12]), p(-e[13]), p(e[14]), p(e[15])].join(',') + ')'; }
  cssObj(m) { const e = m.elements, p = this.eps; return 'matrix3d(' + [p(e[0]), p(e[1]), p(e[2]), p(e[3]), p(-e[4]), p(-e[5]), p(-e[6]), p(-e[7]), p(e[8]), p(e[9]), p(e[10]), p(e[11]), p(e[12]), p(e[13]), p(e[14]), p(e[15])].join(',') + ')'; }

  tick = now => {
    cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(this.tick);
    this.frames = (this.frames || 0) + 1; this.watchFrame(now - this.last);
    try { this.frame(now); } catch (e) { this.lastErr = e; if (!this.errLogged) { this.errLogged = true; console.error('frame error', e); } }
  };
  frame(now) {
    const cam = this.camera, dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; const t = now / 1000;
    if (!this.tmp) { this.tmp = { n: new Vector3(), r: new Vector3(), tg: new Vector3(), cp: new Vector3(), c: new Color(), v: new Vector3(), d: new Vector3(), m: new Matrix4() }; }
    const { n, r, tg, cp, c, v, d, m } = this.tmp;
    this.sTarget = clamp(this.debugS != null ? this.debugS : window.scrollY, 0, this.L);
    this.s += (this.sTarget - this.s) * (1 - Math.exp(-dt * 6.5)); if (Math.abs(this.sTarget - this.s) < 0.3) this.s = this.sTarget;
    const k = 1 - Math.exp(-dt * 5); this.mx += (this.mxT - this.mx) * k; this.my += (this.myT - this.my) * k;
    const P = this.pose(this.s);
    n.set(Math.sin(P.phi), 0, Math.cos(P.phi)); r.set(Math.cos(P.phi), 0, -Math.sin(P.phi));
    tg.set(this.R * Math.sin(P.phi), P.y, this.R * Math.cos(P.phi));
    const drift = (this.props.drift !== false && !this.reduced) ? 1 : 0;
    const ox = this.mx * 0.5 + drift * Math.sin(t * 0.21) * 0.22, oy = -this.my * 0.32 + drift * Math.cos(t * 0.17) * 0.14;
    cp.copy(tg).addScaledVector(n, this.D0 + P.pull).addScaledVector(r, ox); cp.y += oy;
    cam.position.copy(cp); cam.lookAt(tg); cam.updateMatrixWorld();
    // lights follow the current station
    this.spot.position.copy(tg).addScaledVector(n, 8).addScaledVector(r, -5); this.spot.position.y += 7;
    this.spot.target.position.copy(tg); this.spot.target.position.y -= 1; this.spot.target.updateMatrixWorld();
    this.coreLight.position.set(0, P.y + 1, 0);
    const fi = Math.min(7, Math.floor(P.frac)), fu = P.frac - fi, A = PRESET[fi], B = PRESET[Math.min(fi + 1, 7)];
    this.spot.color.setHex(A[0]).lerp(c.setHex(B[0]), fu); this.spot.intensity = lerp(A[1], B[1], fu); this.coreLight.intensity = lerp(A[2], B[2], fu);
    this.fogColor.setHex(A[3]).lerp(c.setHex(B[3]), fu);
    this.groups.forEach((g, i) => { g.visible = Math.abs(P.frac - i) < 1.6; });
    if (this.pMat) this.pMat.uniforms.uTime.value = t;
    const introP = this.introStart ? clamp((now - this.introStart) / 1800, 0, 1) : 0;
    if (this.introStart && this.tower) {
      const ti = (now - this.introStart) / 1000;
      if (ti < 3) { for (let q = 0; q < 12; q++) { let e = clamp((ti - q * 0.1) / 1.4, 0, 1); e = 1 - Math.pow(1 - e, 3); m.makeTranslation(0, this.towerTop - q * this.pitch + (1 - e) * (8 + q * 0.6), 0); this.tower.setMatrixAt(q, m); } this.tower.instanceMatrix.needsUpdate = true; }
    }
    if (this.shards && this.groups[0].visible) this.shards.forEach(sh => { sh.mesh.rotation.set(sh.rx + Math.sin(t * sh.sx + sh.seed) * 0.35, sh.ry + t * sh.sy * 0.5, 0); sh.mesh.position.set(sh.x + this.mx * sh.par * 90, sh.y + Math.sin(t * 0.5 + sh.seed) * 18 - this.my * sh.par * 60, sh.z); });
    // CSS3D layer
    this.camEl.style.transform = 'translateZ(' + this.focal + 'px) scale3d(100,100,100) ' + this.cssCam(cam.matrixWorldInverse) + ' translate(' + this.vw / 2 + 'px,' + this.vh / 2 + 'px)';
    this.secs.forEach((el, i) => {
      const vis = Math.abs(P.frac - i) < 1.25;
      if (vis && this.secLast[i] !== this.secTf[i]) { el.style.transform = this.secLast[i] = this.secTf[i]; }
      const shown = el.style.display !== 'none'; if (vis !== shown) el.style.display = vis ? '' : 'none';
    });
    for (const nd of this.nodes) {
      const dist = Math.abs(P.frac - nd.si); if (dist >= 1.25) continue;
      let approach = clamp(1.45 - dist * 1.45, 0, 1); if (nd.si === 0) approach = Math.min(approach, introP);
      let p = clamp((approach - 0.3 * (nd.k / this.kMax[nd.si])) / 0.7, 0, 1); p = 1 - Math.pow(1 - p, 3);
      const kk = 1 - Math.exp(-dt * 8); nd.lift += (nd.liftT - nd.lift) * kk; nd.dim += (nd.dimT - nd.dim) * (1 - Math.exp(-dt * 6)); nd.tx += (nd.ttx - nd.tx) * kk; nd.ty += (nd.tty - nd.ty) * kk;
      const fx = nd.fl ? Math.sin(t * 0.7 + nd.seed) * nd.fl : 0, fy = nd.fl ? Math.cos(t * 0.52 + nd.seed) * nd.fl * 0.7 : 0;
      const rise = (1 - p) * 90, z = nd.z0 + nd.lift - nd.dim * 260;
      const tf = 'translate3d(' + fx.toFixed(2) + 'px,' + (fy + rise).toFixed(2) + 'px,' + z.toFixed(2) + 'px) rotateY(' + (nd.ry0 * 57.29578 + nd.ty).toFixed(2) + 'deg) rotateX(' + nd.tx.toFixed(2) + 'deg)';
      if (tf !== nd.last) { nd.el.style.transform = tf; nd.last = tf; }
      const op = (p * (1 - 0.88 * nd.dim)).toFixed(3); if (op !== nd.lastOp) { nd.el.style.opacity = op; nd.lastOp = op; }
      if (nd.pivot) { nd.pivot.position.set(nd.cx + fx, -(nd.cy + fy + rise), z); nd.pivot.rotation.set(-nd.tx * 0.0174533, nd.ry0 + nd.ty * 0.0174533, 0); nd.pivot.scale.set(1, 1, Math.max(0.001, p)); nd.pivot.visible = p > 0.01; }
    }
    const hn = this.hoverNode; this.hoverLight.intensity += ((hn ? 110 : 0) - this.hoverLight.intensity) * (1 - Math.exp(-dt * 8));
    if (hn && hn.pivot) { hn.pivot.getWorldPosition(v); hn.pivot.getWorldDirection(d); v.addScaledVector(d, 0.9); this.hoverLight.position.copy(v); }
    const ai = Math.min(7, Math.round(P.frac)); if (ai !== this.state.active) this.setState({ active: ai });
    this.renderer.render(this.scene, cam);
  }
}

const start = () => { const app = new App(document.querySelector('[data-ref="root"]')); window.__c2w = app; app.boot(); };
document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', start) : start();
