// js/envpreview.js — lobby 360° panorama viewer for the environment picker.
// One reusable WebGL stage; drag to look around, no external viewer library.
import * as THREE from 'three';
import { getQuality } from './quality.js?v=3';
import { loadEnvironmentTexture, disposeEnvironmentTexture } from './environments3d.js?v=1';

export class EnvironmentPreview {
  constructor(canvas, { onState } = {}) {
    this.canvas = canvas;
    this.onState = onState || (() => {});
    this._disposed = false;
    this._running = false;
    this._token = 0;
    this._designId = null;
    this._tex = null;
    this._mesh = null;
    this._raf = 0;
    this._drag = null;
    this._lon = 0;
    this._lat = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05080f);
    this.camera = new THREE.PerspectiveCamera(72, 1, 0.1, 100);
    this.camera.rotation.order = 'YXZ';

    this._geo = new THREE.SphereGeometry(10, 64, 32);
    this._mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
    this._mesh = new THREE.Mesh(this._geo, this._mat);
    this.scene.add(this._mesh);

    this._bind();
    this._onWinResize = () => this.resize();
    window.addEventListener('resize', this._onWinResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas.parentElement || canvas);
    }
  }

  _bind() {
    this._onDown = (e) => {
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture?.(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
    };
    this._onMove = (e) => {
      if (!this._drag || this._drag.id !== e.pointerId) return;
      const dx = e.clientX - this._drag.x;
      const dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX;
      this._drag.y = e.clientY;
      this._lon -= dx * 0.16;
      this._lat = Math.max(-80, Math.min(80, this._lat - dy * 0.16));
      this._applyLook();
    };
    this._onUp = (e) => {
      if (!this._drag || this._drag.id !== e.pointerId) return;
      this._drag = null;
      this.canvas.style.cursor = 'grab';
    };
    this.canvas.addEventListener('pointerdown', this._onDown);
    this.canvas.addEventListener('pointermove', this._onMove);
    this.canvas.addEventListener('pointerup', this._onUp);
    this.canvas.addEventListener('pointercancel', this._onUp);
    this.canvas.style.cursor = 'grab';
  }

  _applyLook() {
    this.camera.rotation.y = THREE.MathUtils.degToRad(this._lon);
    this.camera.rotation.x = THREE.MathUtils.degToRad(this._lat);
  }

  setDesign(design) {
    if (this._disposed) return;
    if (this._designId === design.id && this._tex) {
      this._lon = 0; this._lat = 0; this._applyLook();
      this.onState('ready', design);
      return;
    }
    const token = ++this._token;
    this._designId = design.id;
    this._clearTexture();
    this._lon = 0; this._lat = 0; this._applyLook();
    this.onState('loading', design);
    const tier = getQuality().tier === 'low' ? 'low' : 'high';
    loadEnvironmentTexture(design, tier).then((tex) => {
      if (this._disposed || token !== this._token) {
        disposeEnvironmentTexture(tex);
        return;
      }
      // A sphere map is sampled by the mesh UVs, not as a reflection cube.
      tex.mapping = THREE.UVMapping;
      this._tex = tex;
      this._mat.map = tex;
      this._mat.needsUpdate = true;
      this.onState('ready', design);
    }).catch((err) => {
      if (token === this._token) this.onState('error', design, err);
    });
  }

  _clearTexture() {
    if (this._tex) {
      this._mat.map = null;
      this._mat.needsUpdate = true;
      disposeEnvironmentTexture(this._tex);
      this._tex = null;
    }
  }

  resize() {
    if (this._disposed) return;
    const host = this.canvas.parentElement || this.canvas;
    const w = host.clientWidth;
    const h = host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  resume() {
    if (this._disposed || this._running) return;
    this._running = true;
    this.resize();
    this._raf = requestAnimationFrame(this._tick);
  }

  pause() {
    this._running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  _tick = () => {
    if (!this._running || this._disposed) return;
    this._raf = requestAnimationFrame(this._tick);
    this.renderer.render(this.scene, this.camera);
  };

  destroy() {
    if (this._disposed) return;
    this._disposed = true;
    this.pause();
    this._token++;
    window.removeEventListener('resize', this._onWinResize);
    this._ro?.disconnect();
    this.canvas.removeEventListener('pointerdown', this._onDown);
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerup', this._onUp);
    this.canvas.removeEventListener('pointercancel', this._onUp);
    this._clearTexture();
    this._mat.dispose();
    this._geo.dispose();
    this.renderer.dispose();
    const fresh = this.canvas.cloneNode(false);
    this.canvas.replaceWith(fresh);
  }
}
