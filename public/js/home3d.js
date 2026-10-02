// js/home3d.js — WebGL backdrop for the home screen: real 3D dominoes
// tumbling down a foggy void with casino lighting + pointer parallax.
// The caller keeps its 2D CSS tiles as a fallback if WebGL is unavailable.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { tileFaceCanvas, tileBackCanvas } from './tiles.js?v=14';
import { getQuality, onQualityChange, startProbe, feedFrame } from './quality.js?v=1';

const rand = (a, b) => a + Math.random() * (b - a);
const DEEP = 0x121a3c; // mid-twilight sky tone so fog blends into the gradient

function makeTex(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class Home3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.active = false;
    this.raf = 0;
    this.last = 0;
    this.px = 0; this.py = 0;
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    // B4: filmic output — matches the game board's grade
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(DEEP, 11, 24);

    // B4: one-time PMREM room environment — subtle reflections on the tumbling tiles
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 60);
    this.camera.position.set(0, 0, 13);
    this.spanY = Math.tan(THREE.MathUtils.degToRad(27.5)) * 13 + 2.5;
    this.spanX = this.spanY;

    // moonlight fill + dusk key, with gold/teal accent pools echoing the brand
    this.scene.add(new THREE.HemisphereLight(0x93a7ff, 0x241a3e, 1.05));
    const key = new THREE.DirectionalLight(0xe9eeff, 1.9);
    key.position.set(5, 9, 7);
    this.scene.add(key);
    const gold = new THREE.PointLight(0xf7b32b, 85, 0, 2);
    gold.position.set(-7, -5, 5);
    this.scene.add(gold);
    const teal = new THREE.PointLight(0x2ee6a8, 40, 0, 2);
    teal.position.set(8, 6, 2);
    this.scene.add(teal);

    // one shared beveled tile shape; faces use the canvas art from tiles.js
    this.geo = new RoundedBoxGeometry(1, 2, 0.28, 3, 0.06);
    this.sideMat = new THREE.MeshStandardMaterial({ color: 0xe9e1c8, roughness: 0.55, metalness: 0.05, envMapIntensity: 0.5 });
    this.backMat = new THREE.MeshStandardMaterial({ map: makeTex(tileBackCanvas()), roughness: 0.6, metalness: 0.1, envMapIntensity: 0.3 });

    const count = Math.min(window.innerWidth, window.innerHeight) < 640 ? 10 : 18;
    this.tiles = [];
    this.buildLanes(count);
    for (let i = 0; i < count; i++) this.tiles.push(this.makeTile());

    window.addEventListener('resize', this.onResize);
    window.addEventListener('pointermove', this.onPointer);
    document.addEventListener('visibilitychange', this.onVis);

    // B2/B4: adaptive quality — bloom composer on high tier, plain path on low
    this._quality = getQuality();
    this._unsubQuality = onQualityChange(q => this._applyQuality(q));
    startProbe();
    this._applyQuality(this._quality);
  }

  // ── B4: adaptive quality wiring ──
  _applyQuality(q = getQuality()) {
    this._quality = q;
    if (q.tier === 'high') this._ensureComposer();
    else this._teardownComposer();
  }

  /** High tier: RenderPass (transparent) → subtle bloom → OutputPass, MSAA+HDR. */
  _ensureComposer() {
    if (this._composer) return;
    const size = this.renderer.getSize(new THREE.Vector2());
    const dpr = this.renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(
      Math.max(1, Math.floor(size.x * dpr)), Math.max(1, Math.floor(size.y * dpr)),
      { samples: 4, type: THREE.HalfFloatType },
    );
    const composer = new EffectComposer(this.renderer, rt);
    const rp = new RenderPass(this.scene, this.camera);
    rp.clearAlpha = 0;   // keep the CSS twilight gradient visible behind the tiles
    composer.addPass(rp);
    composer.addPass(new UnrealBloomPass(size.clone(), 0.25, 0.5, 0.85));
    composer.addPass(new OutputPass());
    this._composer = composer;
  }

  _teardownComposer() {
    this._composer?.dispose?.();
    this._composer = null;
  }

  // Even horizontal coverage: pure-random x clumps at low tile counts (one
  // side of the screen often looks empty), so spawns draw from evenly spaced
  // lanes with jitter, reshuffled each full cycle.
  buildLanes(n) {
    const half = this.spanX * 0.92;
    const gap = (half * 2) / Math.max(n, 1);
    this.laneGap = gap;
    this.lanes = Array.from({ length: Math.max(n, 1) }, (_, i) => -half + gap * (i + 0.5));
    this.shuffle(this.lanes);
    this.laneIdx = 0;
  }

  nextX() {
    if (this.laneIdx >= this.lanes.length) {
      this.shuffle(this.lanes);
      this.laneIdx = 0;
    }
    return this.lanes[this.laneIdx++] + rand(-this.laneGap * 0.3, this.laneGap * 0.3);
  }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  makeTile() {
    const a = Math.floor(Math.random() * 7), b = Math.floor(Math.random() * 7);
    const faceMat = new THREE.MeshStandardMaterial({
      map: makeTex(tileFaceCanvas(a, b)), roughness: 0.5, metalness: 0.04, envMapIntensity: 0.35,
    });
    const backFacing = Math.random() < 0.15;
    const mesh = new THREE.Mesh(this.geo, [
      this.sideMat, this.sideMat, this.sideMat, this.sideMat,
      backFacing ? this.backMat : faceMat,
      backFacing ? faceMat : this.backMat,
    ]);
    this.scene.add(mesh);
    const t = {
      mesh, faceMat,
      baseX: 0, y: 0, z: 0, vy: 0,
      wx: 0, wy: 0, wz: 0,
      swayAmp: 0, swayFreq: 0, phase: 0,
    };
    this.randomize(t, true);
    return t;
  }

  // new drop parameters; `mid` places the tile somewhere inside the view so
  // the screen starts populated instead of raining in from empty
  randomize(t, mid = false) {
    t.baseX = this.nextX();
    t.z = rand(-5, 2.5);
    t.vy = rand(0.9, 1.9) * (1 - ((t.z + 5) / 8) * 0.3);
    t.y = mid ? rand(-this.spanY, this.spanY) : this.spanY + 1 + rand(0, 3);
    t.wx = rand(0.25, 1.0) * (Math.random() < 0.5 ? -1 : 1);
    t.wy = rand(0.1, 0.6) * (Math.random() < 0.5 ? -1 : 1);
    t.wz = rand(0.05, 0.4) * (Math.random() < 0.5 ? -1 : 1);
    t.swayAmp = rand(0.3, 1.1);
    t.swayFreq = rand(0.25, 0.6);
    t.phase = rand(0, Math.PI * 2);
    t.mesh.rotation.set(rand(0, Math.PI * 2), rand(0, Math.PI * 2), rand(0, Math.PI * 2));
  }

  onResize = () => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this._composer?.setSize(w, h);
    this.spanX = this.spanY * this.camera.aspect + 1.5;
    this.buildLanes(this.tiles.length);
    if (this.reducedMotion) this.renderStatic();
  };

  onPointer = (e) => {
    this.px = (e.clientX / window.innerWidth) * 2 - 1;
    this.py = (e.clientY / window.innerHeight) * 2 - 1;
  };

  onVis = () => {
    if (document.hidden) this.pause();
    else if (this.active) this.resume();
  };

  pause() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  resume() {
    if (this.raf) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  setActive(active) {
    if (active === this.active) return;
    this.active = active;
    if (active) {
      this.onResize();
      if (this.reducedMotion) { this.renderStatic(); return; }
      this.resume();
    } else {
      this.pause();
    }
  }

  // one frozen frame for prefers-reduced-motion users
  renderStatic() {
    this.renderer.render(this.scene, this.camera);
  }

  tick = (now) => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    const t = now / 1000;

    for (const tl of this.tiles) {
      tl.y -= tl.vy * dt;
      if (tl.y < -this.spanY - 1.5) this.randomize(tl);
      tl.mesh.position.set(
        tl.baseX + Math.sin(t * tl.swayFreq + tl.phase) * tl.swayAmp,
        tl.y, tl.z,
      );
      tl.mesh.rotation.x += tl.wx * dt;
      tl.mesh.rotation.y += tl.wy * dt;
      tl.mesh.rotation.z += tl.wz * dt;
    }

    // gentle autonomous drift + pointer parallax
    const cx = Math.sin(t * 0.07) * 0.5 + this.px * 0.9;
    const cy = Math.cos(t * 0.05) * 0.3 - this.py * 0.55;
    this.camera.position.x += (cx - this.camera.position.x) * 0.04;
    this.camera.position.y += (cy - this.camera.position.y) * 0.04;
    this.camera.lookAt(0, 0, 0);

    feedFrame(now);
    if (this._composer) this._composer.render();
    else this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.pause();
    this.setActive(false);
    this._unsubQuality?.();
    this._teardownComposer();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('pointermove', this.onPointer);
    document.removeEventListener('visibilitychange', this.onVis);
    for (const tl of this.tiles) tl.faceMat.map?.dispose();
    this.backMat.map?.dispose();
    this.backMat.dispose();
    this.sideMat.dispose();
    this.geo.dispose();
    this.renderer.dispose();
  }
}
