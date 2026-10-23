// js/environments3d.js — shared registry for the 360° game environments.
// The backgrounds are Poly Haven HDRIs (CC0), shipped as 1K/2K equirectangular
// JPEGs under /vendor/environments. Nothing is fetched live.
import * as THREE from 'three';

const V = './vendor/environments';
const files = (id) => ({
  thumb: `${V}/thumbs/${id}.jpg`,
  bg: `${V}/${id}/${id}_bg.jpg`,   // central room band, CSS backdrop
  url1k: `${V}/${id}/${id}_1k.jpg`,
  url2k: `${V}/${id}/${id}_2k.jpg`,
});

export const ENVIRONMENTS = [
  {
    id: 'comfy_cafe', name: 'كافيه مريح',
    desc: 'كافيه دافئ بطاولات وأرائك وإضاءة مريحة.',
    credit: 'Sergej Majboroda · Poly Haven · CC0',
    ...files('comfy_cafe'),
  },
  {
    id: 'warm_bar', name: 'بار دافئ',
    desc: 'بار خشبي دافئ بسقف عالي وإضاءة كهرمانية.',
    credit: 'Greg Zaal, Jarod Guest · Poly Haven · CC0',
    ...files('warm_bar'),
  },
  {
    id: 'billiard_hall', name: 'قاعة بلياردو',
    desc: 'قاعة بلياردو بطاولات وأضواء معلقة — جو ألعاب حقيقي.',
    credit: 'Greg Zaal, Jarod Guest · Poly Haven · CC0',
    ...files('billiard_hall'),
  },
  {
    id: 'wooden_lounge', name: 'صالة خشبية',
    desc: 'صالة خشبية بأرائك وطاولة بلياردو في الخلف.',
    credit: 'Greg Zaal · Poly Haven · CC0',
    ...files('wooden_lounge'),
  },
  {
    id: 'warm_restaurant_night', name: 'مطعم ليلي دافئ',
    desc: 'مطعم ليلي بعوارض خشب وإضاءة خافتة.',
    credit: 'Greg Zaal, Jarod Guest · Poly Haven · CC0',
    ...files('warm_restaurant_night'),
  },
  {
    id: 'fireplace', name: 'صالة المدفأة',
    desc: 'صالة دافئة بإضاءة المدفأة وأريكة خشبية.',
    credit: 'Greg Zaal · Poly Haven · CC0',
    ...files('fireplace'),
  },
  {
    id: 'cayley_interior', name: 'إطلالة بحرية',
    desc: 'صالة عصرية بنوافذ واسعة وإطلالة على البحر.',
    credit: 'Greg Zaal · Poly Haven · CC0',
    ...files('cayley_interior'),
  },
  {
    id: 'brown_photostudio_02', name: 'استوديو دافئ',
    desc: 'مساحة عصرية بخشب فاتح وإضاءة طبيعية.',
    credit: 'Sergej Majboroda · Poly Haven · CC0',
    ...files('brown_photostudio_02'),
  },
  {
    id: 'photo_studio_loft_hall', name: 'لوفت فني',
    desc: 'لوفت بخشب دافئ وجدران خضراء وإضاءة شمس.',
    credit: 'Sergej Majboroda · Poly Haven · CC0',
    ...files('photo_studio_loft_hall'),
  },
  {
    id: 'blue_photo_studio', name: 'استوديو أزرق',
    desc: 'غرفة داكنة أنيقة بخشب وأريكة بيضاء.',
    credit: 'Sergej Majboroda · Poly Haven · CC0',
    ...files('blue_photo_studio'),
  },
  {
    id: 'studio_country_hall', name: 'بيت ريفي',
    desc: 'صالة ريفية بسقف مزخرف وأرضية خشب دافئة.',
    credit: 'Sergej Majboroda · Poly Haven · CC0',
    ...files('studio_country_hall'),
  },
  {
    id: 'venice_sunset', name: 'غروب البندقية',
    desc: 'ممشى بحري أوروبي وقت الغروب.',
    credit: 'Greg Zaal · Poly Haven · CC0',
    ...files('venice_sunset'),
  },
  {
    id: 'satara_night', name: 'ليلة النجوم',
    desc: 'سافانا هادئة تحت سماء مليانة نجوم.',
    credit: 'Greg Zaal · Poly Haven · CC0',
    ...files('satara_night'),
  },
];

const IDS = new Set(ENVIRONMENTS.map(e => e.id));
export const DEFAULT_ENVIRONMENT = 'comfy_cafe';

export function getEnvironment(id) {
  return ENVIRONMENTS.find(e => e.id === id) || ENVIRONMENTS[0];
}

export function loadEnvironmentSelection() {
  try {
    const v = localStorage.getItem('domino_environment');
    return IDS.has(v) ? v : DEFAULT_ENVIRONMENT;
  } catch { return DEFAULT_ENVIRONMENT; }
}

export function saveEnvironmentSelection(id) {
  if (!IDS.has(id)) return false;
  try { localStorage.setItem('domino_environment', id); } catch { /* private mode */ }
  return true;
}

const loader = new THREE.TextureLoader();

/** Load the equirectangular JPEG for the active tier (1K low / 2K high). */
export function loadEnvironmentTexture(design, tier) {
  const url = tier === 'low' ? design.url1k : design.url2k;
  return loader.loadAsync(url).then((tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    return tex;
  });
}

export function disposeEnvironmentTexture(tex) {
  tex?.dispose?.();
}
