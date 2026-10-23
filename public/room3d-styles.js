// أنماط غرفة دومينو أرينا — بيانات التصميم فقط، بدون أي كود ثلاثي الأبعاد.
//
// افتراضات التنسيق (لأن room3d.js بيقرأ الملف ده):
// - الغرفة مربعة تقريبًا: كل جدار عرضه 9 م وارتفاعه 3.2 م.
// - wallArt[].x = إزاحة أفقية من منتصف الجدار بالمتر (سالب = شمال/يسار الجدار).
// - wallArt[].y = ارتفاع منتصف اللوحة من الأرض بالمتر.
// - wallArt[].w / h = العرض والارتفاع بالمتر.
// - الألوان كلها HEX، وimage لازم يكون اسم مجلد موجود في
//   public/vendor/environments/ (بدون امتداد الملف).

export const ROOM_STYLES = [
  {
    id: 'modern',
    label: 'مودرن نضيف',
    palette: {
      floor: '#c9c2b6',       // باركيه فاتح رمادي دافي
      wall: '#e9e6e0',        // أوف وايت
      ceiling: '#f7f5f1',
      rug: '#7f8794',         // رمادي أزرق هادي
      wood: '#8a6a4a',        // جوز
      fabric: '#3e5a6e',      // أزرق بترولي
      metal: '#c3c7cc',       // ستانلس مطفي
      light: '#fff3df',
      lightIntensity: 1.05,
      ambient: 0.85,
    },
    wallArt: [
      // لوحة كبيرة على الجدار الخلفي — 3.6 م عشان تاخد الجدار
      { wall: 'back', image: 'photo_studio_loft_hall', w: 3.6, h: 2.0, x: 0, y: 1.8, frame: '#2c3138' },
      // لوحة أفقية على الشمال
      { wall: 'left', image: 'blue_photo_studio', w: 1.9, h: 1.25, x: -0.6, y: 1.72, frame: '#9aa3ad' },
      // لوحة رأسية على اليمين
      { wall: 'right', image: 'brown_photostudio_02', w: 1.5, h: 1.9, x: 0.9, y: 1.78, frame: '#2c3138' },
    ],
    props: ['sofa', 'chairs', 'shelf', 'plant', 'lamp'],
  },

  {
    id: 'cozy',
    label: 'دافي وبيت قديم',
    palette: {
      floor: '#6f4a2f',       // خشب بنّي دافي
      wall: '#bf9b74',        // بيج طيني
      ceiling: '#dcc9ad',
      rug: '#8c3b32',         // أحمر نبيتي
      wood: '#5a3722',        // خشب غامق
      fabric: '#8a6a4f',      // كتان بنّي
      metal: '#a67c3d',       // نحاس
      light: '#ffb46b',       // لمبة دافية
      lightIntensity: 0.8,
      ambient: 0.72,
    },
    wallArt: [
      // لوحة كبيرة على الجدار الخلفي (3.2 م)
      { wall: 'back', image: 'warm_restaurant_night', w: 3.2, h: 1.8, x: 0, y: 1.8, frame: '#4a2f1d' },
      // جدار الشمال: صالة خشبية
      { wall: 'left', image: 'wooden_lounge', w: 2.2, h: 1.35, x: 0.5, y: 1.75, frame: '#6b4626' },
      // جدار اليمين: كافيه مريح + صورة المدفأة (إحساس البيت القديم)
      { wall: 'right', image: 'comfy_cafe', w: 1.7, h: 1.15, x: -0.7, y: 1.72, frame: '#3f2a1a' },
      { wall: 'right', image: 'fireplace', w: 1.2, h: 1.6, x: 1.9, y: 1.75, frame: '#3f2a1a' },
    ],
    props: ['sofa', 'chairs', 'shelf', 'fireplace', 'plant', 'books', 'lamp'],
  },

  {
    id: 'billiard',
    label: 'قاعة بلياردو',
    palette: {
      floor: '#2b3b36',       // موكيت أخضر غامق
      wall: '#3a4a41',        // أخضر حجري
      ceiling: '#1d2724',
      rug: '#7a1f24',         // أحمر طاولة/سجاد
      wood: '#4a2d1a',        // خشب الماهوجني
      fabric: '#125c3a',      // جوخ البلياردو
      metal: '#b08d57',       // نحاس ولمعة
      light: '#ffe3ae',       // إضاءة دافية فوق الطاولة
      lightIntensity: 0.92,
      ambient: 0.6,
    },
    wallArt: [
      // لوحة كبيرة على الجدار الخلفي (3.4 م)
      { wall: 'back', image: 'billiard_hall', w: 3.4, h: 1.9, x: 0, y: 1.8, frame: '#b08d57' },
      // البار على الشمال
      { wall: 'left', image: 'warm_bar', w: 2.2, h: 1.3, x: 0, y: 1.72, frame: '#6b4a2a' },
      // اليمين: لوحتان صغيرتان
      { wall: 'right', image: 'brown_photostudio_02', w: 1.3, h: 1.7, x: -1.2, y: 1.75, frame: '#b08d57' },
      { wall: 'right', image: 'wooden_lounge', w: 1.6, h: 1.0, x: 1.3, y: 1.7, frame: '#6b4a2a' },
    ],
    props: ['billiardTable', 'chairs', 'shelf', 'lamp', 'starLights'],
  },

  {
    id: 'playful',
    label: 'كرتوني ملوّن',
    palette: {
      floor: '#5ec4c9',       // تركواز فاتح
      wall: '#ffe27a',        // أصفر ليموني
      ceiling: '#fff6c9',
      rug: '#ef476f',         // بمبي فاقع
      wood: '#e0a13a',        // خشب عسلي
      fabric: '#118ab2',      // أزرق مرجاني
      metal: '#845ec2',       // بنفسجي
      light: '#ffffff',
      lightIntensity: 1.15,
      ambient: 1.05,
    },
    wallArt: [
      // لوحة كبيرة على الجدار الخلفي (3.3 م)
      { wall: 'back', image: 'cayley_interior', w: 3.3, h: 1.8, x: 0, y: 1.8, frame: '#ef476f' },
      // مربع صغير جنبها على نفس الجدار
      { wall: 'back', image: 'blue_photo_studio', w: 1.1, h: 1.1, x: -3.4, y: 1.9, frame: '#118ab2' },
      // الشمال: لوحة رأسية + لوحة أفقية
      { wall: 'left', image: 'brown_photostudio_02', w: 1.6, h: 2.0, x: -1.0, y: 1.75, frame: '#06d6a0' },
      { wall: 'left', image: 'comfy_cafe', w: 1.2, h: 0.9, x: 1.6, y: 1.7, frame: '#f7b32b' },
      // اليمين: لوحة رأسية
      { wall: 'right', image: 'photo_studio_loft_hall', w: 1.3, h: 1.6, x: 0.4, y: 1.75, frame: '#845ec2' },
    ],
    props: ['sofa', 'chairs', 'shelf', 'plant', 'lamp'],
  },
];

// بيرجّع النمط بالـ id، ولو مش موجود بيرجّع أول نمط بدل ما يرمي خطأ.
export function getStyle(id) {
  return ROOM_STYLES.find((style) => style.id === id) || ROOM_STYLES[0];
}
