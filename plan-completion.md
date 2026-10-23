# خطة إكمال دومينو أرينا — خطة تنفيذية جاهزة للسيشن الجديد

> **للوكيل/السيشن الجديد:** اقرأ هذا الملف كاملًا ثم نفّذ المراحل بالترتيب. كل الحالة الحالية موثّقة هنا بالقيم الحقيقية المقيّسة. المستخدم يريد: لعبة دومينو أرينا تصل للمستخدم كـ **تطبيق أندرويد خفيف** يلعب **أونلاين على سيرفر دائم مجاني (Cloudflare)** و **أوفلاين/هوت سبوت بين تليفونين** و **لوحدي ضد البوتات** — بدون أي كارت دفع، وبدون تغيير في شكل اللعبة إلا بموافقته مع لقطات قبل/بعد.

---

## 1) حالة المشروع الآن (جُرّدت بتاريخ 2026-10-23 — القيم بالبايت من القرص)

| العنصر | الحالة |
|---|---|
| المستودع | `C:\Users\Mahmoud\Desktop\domino` — git محلي + remote `github.com/deutche042-ctrl/domino-arena` (public) |
| آخر كوميت | `eea66d9 worker: run the game server on Cloudflare Workers + Durable Objects` |
| **غير محفوظ** | `public/{index.html, app.js, sw.js}` (ربط السيرفر الداخلي بالعميل ✓ جاهز)، `mobile/` كامل (تطبيق Capacitor ✓)، `public/{room3d.js, room3d-styles.js, demo-room.html}` (غرفة 3D بديمو ✓) |
| **Cloudflare** | منشور ✓ على `https://domino-arena.deutche042.workers.dev` — e2e كامل 63/63 على الرابط الحي ✓ — كوده في `worker/` محفوظ ✓ — **لكن العميل المنشور فيه البيئة القديمة (صورة مسطّحة)** ✗ |
| **الغرفة 3D** | ديمو مكتمل بـ 4 أنماط (`modern`/`cozy`/`billiard`/`playful`) · 2,290–4,124 مثلث فقط لكل نمط · خامات ≤ 23 · تم إصلاح: قفل الكاميرا (`clampCameraToRoom`)، إبعاد النجفة عن الطرابيزة ✓ |
| **التطبيق** | `mobile/` فيه: Capacitor 8.5.3 ✓ · البلجن `@capawesome/capacitor-nodejs@0.2.0` (Node 18 داخل التطبيق) ✓ · `sync.mjs` (يبني `www/` + بندل السيرفر بـ esbuild) · `mobile/node/index.cjs` (يقرأ `DOMINO_PORT\|\|3000` ويستدعي `server-bundle.cjs`) · `verify-launcher.mjs` (فحص جاهزي للتشغيل الداخلي — يفشل لو 3000 مش فاضي) |
| **الـ APK** | المبني حاليًا: `mobile/android/app/build/outputs/apk/debug/app-debug.apk` = 304,536,579 بايت (~290MB — لأن فيه 3 معماريات ولا يوجد splits) · نسخة تسليم: `ZCode-main\.zcode\domino-apk\` |
| **بناء الأندرويد** | minSdk 24 · target/compile 36 · AGP 8.13.0 · Gradle 8.14.3 · Java 21 · **لا يوجد** splits/abiFilters/توقيع release · `mobile/capacitor.config.json`: `startMode: "manual"` (العميل يستدعي `Nodejs.start` بنفسه ✓) |
| **العدّة** | `C:/Users/Mahmoud/android-toolchain/` موجودة: `jdk/` (21) · `sdk/` (android-36 + build-tools 35/36 + platform-tools) |
| **التوكنات** | `%TEMP%\.cf-domino-token` (Cloudflare) و `%TEMP%\.gh-domino-token` (GitHub) — **موجودان لكن في مجلد مؤقت** ⚠ انقلهم أولًا |
| **GitHub** | آخر رفع: `eea66d9` على `main` |

## 2) معلومات معمارية حاسمة (لا تكسرها)

- الطبقات: `server → engine` فقط. المحرك `engine/` نقي بلا IO ولا timers — لا تلمس هذا المبدأ.
- عميل الويب: **بدون build ولا CDN إطلاقًا** — كل شيء في `public/` وvendored. ممنوع إضافة أدوات بناء للعميل.
- ** طرابيزة اللعب بمقاسات ثابتة محفوظة بنفسها في كل الإصدارات**: سطح 2.6×2.6م سماكة 0.12 على ارتفاع مركز 0.72 · فيلت 2.36 · 4 أرجل 0.16×0.66×0.16 · 6 كروت دومينو. أي بيئة جديدة تُبنى **حولها**.
- عنوان السيرفر في العميل: `app.js:2996 embeddedServerBase()` → `http://127.0.0.1:3000` داخل التطبيق فقط (بعلامة `window.Capacitor`)، والمتصفح = نفس أصل الصفحة. `app.js:3006 startEmbeddedServer()` يشغّل `Nodejs.start({script:'index.cjs', env:{PORT:'3000'}})`. `boot()` في 4096 يستدعيها. أي تعديل جديد للـ modes **لا يلمس** هذا المنطق بل يوسّعه.
- e2e: يتطلب سيرفرًا يعمل مسبقًا: `PORT=3123 node server/server.js &` ثم `node scripts/e2e.js 3123` (أو `DOMINO_URL=https://... node scripts/e2e.js`). الاختبار كامل = 63 فحصًا.
- Worker: `worker/` يشغّل `server/server.js` نفسه عبر shims (`worker/src/shims/` لأجل express وsocket.io وnode:http وnode:os وnode:url) — البناء `node build.mjs` والنشر `npx wrangler deploy` مع `CLOUDFLARE_API_TOKEN` و`CLOUDFLARE_ACCOUNT_ID=6aaa6b72f71a3a10d518f19d0e0adf6f`.

## 3) مصائد معروفة (اتكشفت من الفحص الفعلي — نمتنع عنها)

1. `import.meta.url` لا يعمل داخل Worker المُجمّع → الوكيل `shims/node-url.js` يحلها (لا تزل الalias).
2. **رقم الرد (ack) في socket.io v5 داخل هيدر الرسالة**: `42<id>[...]` وليس عنصرًا في `[..]` — والرد `43<id>[...]`.
3. **حدث بلا بيانات يُرسل `["ev"]` وليس `["ev", null]`** — العميل يفرق بينهم (فحص الطرد كشفها).
4. Workers تمنع أي `setInterval`/`setTimeout`/random في **النطاق العام** للوحدة → مؤقتات الاستيراد تُؤجَّل (`do.js` startDeferredIntervals) وتُشغَّل عند أول مقبس.
5. دومين أوبجكت: كل تحديث كود يفصل المقابس (العملاء يعيدون الاتصال تلقائيًا ✓).
6. **حجم APK**: البناء الحالي يجمع 3 معماريات → 290MB؛ `splits{abi}` أو arm64 فقط → ~90–110MB.
7. `/host-info` يحتاج CORS إضافتًا (الطَلب عبر أصل WebView مختلف) — أضف `Access-Control-Allow-Origin: *` له و`/voice-config` و`/healthz`.
8. لو port 3000 مشغول: `verify-launcher.mjs` يفشل عمدًا — ابدأ سيرفر على منفذ تاني للكومميونيكيشن العادي.
9. مستخدم اكتشف مشكلتين بصريتين بالديمو وثُبّتا: قفل الكاميرا داخل الغرفة ✓، إبعاد النجفة ✓ — احفظ نفس الحل عند دمج الغرفة في ملعب اللعبة (`clampCameraToRoom` + النجفة بعيدًا عن مركز الطرابيزة + المنظر من فوق نضيف من أي جسم).
10. ملفات البناء مستبعدة بالـ .gitignore: `worker/dist/` و`worker/.wrangler/` ✓. عند إضافة `mobile/` **لزم إضافة**: `mobile/www/` و`mobile/android/.gradle/` و`mobile/android/app/build/` و`mobile/android/app/.gradle/` و`mobile/android/local.properties` قبل الكوميت.

## 4) المراحل

### المرحلة 0 — حفظ الحالة (ساعة إلا ربع)
- [ ] حدّث `.gitignore` بمستبعديات `mobile/` (القائمة فوق).
- [ ] كوميت +  push لكل: (a) `mobile/` كامل (a) `public/{index.html,app.js,sw.js}` (ج] `public/{room3d.js,room3d-styles.js,demo-room.html}`.
- [ ] انقل التوكنات إلى `%USERPROFILE%\.zcode-keys\` (خارج كل مستودع) وحدّث أي سكربت يقرأها.
- [ ] ادفع على GitHub وتأكد أن آخر كوميت ظهر على `main`.

### المرحلة 1 — الغرفة 3D داخل اللعبة الفعلية (يوم)
- [ ] في `public/js/board3d.js`: استبدل الخلفية الشفافة/الصورة المسطحة (سطرا 104–106 و129–131) ببناء الغرفة عبر `createRoom(scene, styleId, { table:false })` — الغرفة تُبنى حوالين طرابيزة اللعبة (٦ خيوط: جدار خلفي + يمنى + أرضية + سقف، مع فتح أمامي للكاميرا).
- [ ] في `public/js/app.js`: عطّل `applyEnvironmentBackdrop` عندما تكون الغرفة 3D مفعّلة (لا صورة DOM خلف الكانفس).
- [ ] استخدم غطاء الجودة: low = بدون ظلال + بهيكل خفيف؛ حد المثلثات ≤ ٥٠٠٠.
- [ ] أضف استدعاء `clampCameraToRoom` داخل حلقة الرسم (زي ما معمول في `demo-room.html`).
- [ ] خيارات النمط: الواجهة الحالية لاختيار البيئات في اللوبي (`environments3d`) توسع لتشمل أنماط الغرفة الأربعة، مع افتراضي `modern`.
- [ ] اعرض على المستخدم **لقطات قبل/بعد** واطلب تأكيد النمط قبل التثبيت.
- [ ] بعد التثبيت: أعد البناء والنشر على Cloudflare وشغّل e2e على الرابط الحي (63/63).
- **قبول:** المستخدم يوافق على الشكل بالعين + 63/63 محليًا وعلى الرابط الحي + 60fps على موبايل متوسط.

### المرحلة 2 — APK النهائي (نصف يوم)
- [ ] `splits { abi { enable true; reset(); include 'armeabi-v7a','arm64-v8a' } universalApk false }` في `mobile/android/app/build.gradle` → APK لكل معمارية ~90–110MB.
- [ ] `minifyEnabled true` + `shrinkResources true` في `release` + توليد keystore محلي:
      `keytool -genkeypair -v -keystore C:/Users/Mahmoud/.zcode-keys/domino-release.jks -alias domino -keyalg RSA -keysize 2048 -validity 10000`
      (الكلمة السر يقرأها من سؤال للمستخدم؛ لا تكتبها في أي ملف بالمستودع.)
- [ ] **أونلاين أولًا داخل التطبيق**: نمط الأوضاع (المرحلة 3) يجعل أونلاين هو الافتراضي: `startSocket('https://domino-arena.deutche042.workers.dev')` **بدون** `startEmbeddedServer` في هذا الوضع (السيرفر الداخلي يظل للوضع الموضعي/الجنبي).
- [ ] أبني `assembleRelease` (وفق العقد) وانسخ الناتج إلى `ZCode-main\.zcode\domino-apk\` (نسخة التسليم).
- **قبول:** الحجم ≤ 110MB ويُثبَّت على تليفون حقيقي ويفتح سيشل اللعبة.

### المرحلة 3 — الأوضاع الثلاثة + الهوت سبوت + QR (يوم–يومان)
- [ ] **شاشة الأوضاع** (أول شيء): أزرار: أونلاين 🔵 / جنبي (هوت سبوت) 📡 / لوحدي 🎮 — تُحفظ في `localStorage('domino_mode')`.
- [ ] **أونلاين**: `startEmbeddedServer()` لا يعمل؛ `startSocket(CLOUDFLARE_URL)` فقط. أي فشل اتصال → رسالة عربية واضحة + إعادة.
- [ ] **جنبي/هوت سبوت** (المضيف): `startEmbeddedServer()` + قراءة `/host-info` المحلي للحصول على IP الشبكة + **عرض باركود** للرابط `http://<lan-ip>:3000?room=<CODE>` (مولّد QR موجود في `public/vendor/qrcode/qrcode.js` ✓) + نص إرشادي "افتح الهوت سبوت من الإعدادات".
- [ ] **جنبي (الضيف)**: **مسح بالكاميرا** خلال `BarcodeDetector` (المتوفر في Chrome/WebView الحديث) مع بديل مجرب: كتابة `ip:port` يدويًا أو كود الحذف — ممنوع أي تحميل وقت تشغيل؛ لو احتجت مكتبة مسح فConsolidation اجعلها vendored.
- [ ] **إخفاء الصوت في الأوفلاين/البوتات**: عندما الغرفة بدون إنترنت أو بوات — لا تُظهر زر المايك ولا الميوت، والدردشة تظل تعمل (المستخدم حدد هذا صراحة).
- [ ] **لوحدي**: زر يعمل غرفة `vsBots:true` (السيرفر يدعمها ✓) — أوفلاين عبر السيرفر الداخلي، وأونلاين عبر CF.
- [ ] **CORS على `/host-info`,`/voice-config`,`/healthz`** في `server/server.js` (+ نفس الشيء يصل تلقائيًا للـWorker عبر نفس الشيفرة).
- **قبول:** تليفونان على نفس هوت سبوت: المضيف يعمل غرفة والضيف يمسح الباركود ويدخل واللعبة تُلعَب كاملة بلا إنترنت — 2 لاعبين حقيقيين.

### المرحلة 4 — الصلب والنشر النهائي (نصف يوم)
- [ ] `npm test` (49) + e2e محلي (63/63) + e2e على CF (63/63).
- [ ] تحديث `README.md` بطرق التشغيل الثلاثة + تغيير الوثيقة إلى `plan-completion.md` كلها ✓.
- [ ] كوميتات نهائية + push + تسلم المستخدم: **APK (الإصدار النهائي)** + **الرابط الدائم** `https://domino-arena.deutche042.workers.dev` + تقرير نعم/لا لكل بند بالأدلة.

## 5) معايير القبول النهائية (كلها يجب أن تنجح)
1. الرابط الحي: الغرفة الجديدة داخل الملعب والطرابيزة قاعدة في داخلها — 63/63.
2. APK ≤ 110MB يتثبت ويفتح تليفون حقيقي.
3. أونلاين: تطبيق ↔ متصفح من مكان آخر على غرفة واحدة.
4. هوت سبوت: تليفونان بلا إنترنت + مسح باركود + لعبة كاملة.
5. أوفلاين/بوتات: المايك والميوت مخفيان والشات يعمل.
6. ريليس موقّع بـ keystore محفوظ عند المستخدم.

## 6) أوامر جاهزة
```bash
# سيرفر محلي
cd C:/Users/Mahmoud/Desktop/domino && PORT=3123 node server/server.js
# اختبارات
npm test
DOMINO_URL=https://domino-arena.deutche042.workers.dev node scripts/e2e.js
# بناء/نشر Cloudflare (يحتاج التوكن من %USERPROFILE%\.zcode-keys\)
cd worker && npm run build && CLOUDFLARE_API_TOKEN=$(cat ~/.zcode-keys/cf) CLOUDFLARE_ACCOUNT_ID=6aaa6b72f71a3a10d518f19d0e0adf6f npx wrangler deploy
# أندرويد
cd mobile && node sync.mjs && cd android && JAVA_HOME="C:/Users/Mahmoud/android-toolchain/jdk" gradlew.bat assembleDebug
```

## 7) حدود الوصول والفحص
- حدود كاميرا الغرفة: `minDistance 1.7` · `maxDistance 5.6` (يُكمّل 5.18 فعليًا) · `maxPolarAngle 0.495π` · `clampCameraToRoom`: x∈[-3.9,3.9], z∈[-2.9,2.9], y∈[0.8,2.9].
- النجفة: (١.٥٥, -٢.٠) أو (-٢.٣٥, 0.9) لبلياردو — **ليس فوق مركز الطرابيزة أبدًا** — حجم الغطاء نصف قطر 0.34 على ارتفاع 2.65م.
- الحساب الحي: apte `app-debug.apk` الحالي يفشل معايير الحجم — لا تسلّمه للمستخدم بوصفه نهائيًا.

— التزامًا بقواعد المستخدم: أي غيير في الشكل يعرض على المستخدم بلقطات قبل/بعد، والنتائج الحقيقية فقط تُنسب للحالة الفعلية — **لا تقول "خلصنا" قبل أن تتحقق بكل العين.**
