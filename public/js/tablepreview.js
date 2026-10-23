// js/tablepreview.js — lobby preview: one reusable WebGL stage that shows the
// selected table and lets the player orbit it. The game board and this preview
// intentionally load their own model instances; both are released by their owner.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { feltCanvas, getTheme } from './tiles.js?v=15';
import {
  loadTableModel, placeTableModel, applyTableMaterials, disposeTableModel,
} from './tables3d.js?v=1';

const PREVIEW_SPAN = 4.6;   // world units the previewed table spans

export class TablePreview {
  constructor(canvas, { onState } = {}) {
    this.canvas = canvas;
    this.onState = onState || (() => {});
    this._disposed = false;
    this._running = false;
    this._token = 0;
    this._root = null;
    this._designId = null;
    this._raf = 0;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070b16);

    // One PMREM room environment — gives the wood/marble PBR maps the soft
    // reflections that make them read as real materials.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this._envRT = pmrem.fromScene(room, 0.04);
    this.scene.environment = this._envRT.texture;
    room.dispose?.();
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    this.camera.position.set(4.6, 4.1, 4.6);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0.35, 0);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 11;
    this.controls.minPolarAngle = Math.PI * 0.15;
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.9;
    this.controls.addEventListener('start', () => { this.controls.autoRotate = false; });
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2438, 1.2));
    const key = new THREE.DirectionalLight(0xfff1dd, 2.2);
    key.position.set(5, 9, 7);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xa9c4ff, 0.8);
    fill.position.set(-6, 4, -5);
    this.scene.add(fill);

    this._onWinResize = () => this.resize();
    window.addEventListener('resize', this._onWinResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this.resize());
      this._ro.observe(canvas.parentElement || canvas);
    }
  }

  setDesign(design) {
    if (this._disposed) return;
    if (this._designId === design.id && this._root) {
      this.controls.autoRotate = true;
      this._resetCamera();
      this.onState('ready', design);
      return;
    }
    const token = ++this._token;
    this._clearRoot();
    this._designId = design.id;
    this.controls.autoRotate = true;
    this._resetCamera();

    if (design.kind === 'felt') {
      this._root = this._buildFeltTable();
      this.scene.add(this._root);
      this.onState('ready', design);
      return;
    }

    this.onState('loading', design);
    loadTableModel(design).then((gltf) => {
      if (this._disposed || token !== this._token) {
        disposeTableModel(gltf.scene);
        return;
      }
      const root = gltf.scene;
      placeTableModel(root, { targetSpan: PREVIEW_SPAN, minSpan: 0, playY: 0 });
      applyTableMaterials(root, { receiveShadow: false, anisotropy: 4, tone: design.tone || 1 });
      this._root = root;
      this.scene.add(root);
      this.onState('ready', design);
    }).catch((err) => {
      if (token === this._token) this.onState('error', design, err);
    });
  }

  _resetCamera() {
    this.camera.position.set(4.6, 4.1, 4.6);
    this.controls.target.set(0, 0.35, 0);
    this.controls.update();
  }

  /** The classic option previewed with the same felt + rim as the game board. */
  _buildFeltTable() {
    const group = new THREE.Group();
    const tex = new THREE.CanvasTexture(feltCanvas(getTheme()));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const topMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, envMapIntensity: 0.25 });
    const top = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.18, 48), topMat);
    top.position.y = -0.09;
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x4a2f1d, roughness: 0.32, metalness: 0.45, envMapIntensity: 0.9 });
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(2.38, 2.38, 0.24, 48), rimMat);
    rim.position.y = -0.14;
    const baseMat = new THREE.MeshStandardMaterial({ color: 0x26180e, roughness: 0.6, metalness: 0.2 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.35, 0.55, 32), baseMat);
    base.position.y = -0.53;
    group.add(top, rim, base);
    return group;
  }

  _clearRoot() {
    if (!this._root) return;
    this.scene.remove(this._root);
    disposeTableModel(this._root);
    this._root = null;
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
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  destroy() {
    if (this._disposed) return;
    this._disposed = true;
    this.pause();
    this._token++;
    window.removeEventListener('resize', this._onWinResize);
    this._ro?.disconnect();
    this._clearRoot();
    this.controls.dispose();
    if (this._envRT) {
      if (this.scene.environment === this._envRT.texture) this.scene.environment = null;
      this._envRT.dispose();
      this._envRT = null;
    }
    this.renderer.dispose();
    // Give the next preview a clean canvas/context instead of re-initialising
    // a disposed context. app.js looks the canvas up by id on every open.
    const fresh = this.canvas.cloneNode(false);
    this.canvas.replaceWith(fresh);
  }
}
