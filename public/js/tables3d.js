// js/tables3d.js — shared 3D table designs (classic felt + Poly Haven models).
// Assets live under /vendor/tables (CC0, 1K textures) and stay fully offline.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const V = './vendor/tables';

export const TABLE_DESIGNS = [
  {
    id: 'classic', name: 'الكلاسيكية الخضراء', kind: 'felt',
    desc: 'جوخ أخضر كلاسيكي بإطار خشبي — الشكل الأصلي للعبة.',
  },
  {
    id: 'mahogany', name: 'ماهوجني', kind: 'model',
    url: `${V}/round_wooden_table_01/round_wooden_table_01_1k.gltf`,
    thumb: `${V}/thumbs/round_wooden_table_01.png`,
    credit: 'Ulan Cabanilla · Poly Haven · CC0',
    desc: 'طاولة خشب ماهوجني دافئة بقاعدة كلاسيكية.',
  },
  {
    id: 'royal', name: 'ملكي داكن', kind: 'model',
    url: `${V}/round_wooden_table_02/round_wooden_table_02_1k.gltf`,
    thumb: `${V}/thumbs/round_wooden_table_02.png`,
    credit: 'Ulan Cabanilla · Poly Haven · CC0',
    desc: 'خشب داكن فاخر بتصميم أنتيك.',
  },
  {
    id: 'marble', name: 'رخام أبيض', kind: 'model',
    url: `${V}/coffee_table_round_01/coffee_table_round_01_1k.gltf`,
    thumb: `${V}/thumbs/coffee_table_round_01.png`,
    credit: 'Ulan Cabanilla · Poly Haven · CC0',
    desc: 'سطح رخامي فاتح بقاعدة معدنية سوداء عصرية.',
    tone: 0.8,   // the white marble clips under ACES + the key light otherwise
  },
  {
    id: 'oriental', name: 'شرقي', kind: 'model',
    url: `${V}/chinese_tea_table/chinese_tea_table_1k.gltf`,
    thumb: `${V}/thumbs/chinese_tea_table.png`,
    credit: 'Kirill Sannikov · Poly Haven · CC0',
    desc: 'طاولة مربعة من الخشب الداكن بنقوش شرقية.',
  },
  {
    id: 'painted', name: 'أزرق ريفي', kind: 'model',
    url: `${V}/painted_wooden_table/painted_wooden_table_1k.gltf`,
    thumb: `${V}/thumbs/painted_wooden_table.png`,
    credit: 'Kirill Sannikov · Poly Haven · CC0',
    desc: 'خشب مطلي بأزرق هادئ بمظهر ريفي.',
  },
];

const DESIGN_IDS = new Set(TABLE_DESIGNS.map(d => d.id));

export function getTableDesign(id) {
  return TABLE_DESIGNS.find(d => d.id === id) || TABLE_DESIGNS[0];
}

export function loadTableDesign() {
  try {
    const v = localStorage.getItem('domino_table');
    return DESIGN_IDS.has(v) ? v : 'classic';
  } catch { return 'classic'; }
}

export function saveTableDesign(id) {
  if (!DESIGN_IDS.has(id)) return false;
  try { localStorage.setItem('domino_table', id); } catch { /* private mode */ }
  return true;
}

const loader = new GLTFLoader();

export function loadTableModel(design) {
  if (!design || design.kind !== 'model') return Promise.reject(new Error('not a table model'));
  return loader.loadAsync(design.url);
}

/**
 * Scale/centre a table and put its top face exactly on `playY`, which is where
 * the dominoes rest. The minimum horizontal span keeps the boneyard (at the
 * far corner of the play area) on the table even for narrow rectangular tops.
 *
 * `floorY` (optional) keeps the model's BASE on the room floor: a real table
 * stretched to a 34-unit play span is far taller than the 4.6 units between
 * the felt and the floor, so its legs would end up buried under the floor and
 * the model would read as a flat recoloured slab. Squashing the vertical axis
 * is the only way to have both the exact play height and a visible base.
 */
export function placeTableModel(root, { targetSpan = 34, minSpan = 24, playY = 0, floorY = null } = {}) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxExt = Math.max(size.x, size.z) || 1;
  const minExt = Math.min(size.x, size.z) || 1;
  let scale = targetSpan / maxExt;
  if (minSpan > 0 && minExt * scale < minSpan) scale *= minSpan / (minExt * scale);
  root.scale.multiplyScalar(scale);
  root.updateMatrixWorld(true);

  let scaled = new THREE.Box3().setFromObject(root);
  if (floorY != null) {
    const available = playY - floorY;
    const height = scaled.max.y - scaled.min.y;
    if (height > available && available > 0) {
      root.scale.y *= Math.max(0.1, available / height);
      root.updateMatrixWorld(true);
      scaled = new THREE.Box3().setFromObject(root);
    }
  }
  const center = scaled.getCenter(new THREE.Vector3());
  root.position.x -= center.x;
  root.position.z -= center.z;
  root.position.y += playY - scaled.max.y;
  root.updateMatrixWorld(true);
  return {
    scale,
    span: scaled.max.x - scaled.min.x,
    depth: scaled.max.z - scaled.min.z,
  };
}

export function applyTableMaterials(root, { receiveShadow = true, anisotropy = 0, tone = 1 } = {}) {
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = !!receiveShadow;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m || seen.has(m)) continue;
      seen.add(m);
      if ('envMapIntensity' in m) m.envMapIntensity = 0.6;
      if (tone !== 1 && m.color) m.color.multiplyScalar(tone);
      if (anisotropy) {
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
          const tex = m[key];
          if (tex && tex.anisotropy !== anisotropy) {
            tex.anisotropy = anisotropy;
            tex.needsUpdate = true;
          }
        }
      }
    }
  });
}

/** Release a table instance loaded by loadTableModel (never shared/cached). */
export function disposeTableModel(root) {
  if (!root) return;
  const textures = new Set();
  const materials = new Set();
  const geometries = new Set();
  root.traverse((o) => {
    if (o.geometry) geometries.add(o.geometry);
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      materials.add(m);
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap']) {
        if (m?.[key]) textures.add(m[key]);
      }
    }
  });
  for (const t of textures) t.dispose?.();
  for (const m of materials) m.dispose?.();
  for (const g of geometries) g.dispose?.();
}
