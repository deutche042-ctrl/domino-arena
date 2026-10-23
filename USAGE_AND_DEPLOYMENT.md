# دومينو أرينا — دليل الاستخدام والنشر (GitHub + Cloudflare)

دليل عملي لكل حاجة: تشغيل اللعبة محليًا، رفعها على GitHub، نشرها على Render أو
Cloudflare Workers، فتحها للأصحاب عبر Cloudflare Tunnel، إعداد الصوت/TURN،
الاختبارات، واستكشاف الأخطاء.

> **آخر تحديث:** 2026-10-23 — شوف `git log -1` لآخر كوميت في الريبو.

---

## 1) نظرة سريعة

- **اللعبة:** دومينو أونلاين 2–4 لاعبين (Block / Draw / All Fives).
- **السيرفر:** Node.js + Express + Socket.IO، والحالة كلها على السيرفر (الخصم لا يرى يدك).
- **العميل:** HTML/CSS/JS عادي + Three.js مُورَّد محليًا، بدون build step.
- **الغرف:** كود 4 حروف + لينك دعوة + QR + إعادة اتصال بتوكن.
- **المحتوى:** 6 تصاميم طاولة، 13 بيئة 360° (كافيه/بار/بلياردو/…)، 4 ثيمات قطع،
  جودة رسوم Auto/Low/High، بوتات بأربع مستويات وثلاث شخصيات، شات وصوت WebRTC.
- **النشر:** Render (Blueprint من GitHub) أو Cloudflare Workers + Durable Object.
- **الملفات السرية:** `.env` محلي ومستثنى من Git. النسخة القابلة للمشاركة هي `.env.example`.

---

## 2) المتطلبات

| الأداة | الإصدار | ملاحظات |
|---|---|---|
| Node.js | ≥ 18 (مُختبر على 24) | `node -v` |
| npm | ≥ 9 | بيجي مع Node |
| Git | أي إصدار حديث | للرفع على GitHub |
| cloudflared | اختياري | للعب من الجهاز عبر Tunnel |
| حساب GitHub | مطلوب للنشر | الريبو الحالي: `deutche042-ctrl/domino-arena` |
| حساب Cloudflare | اختياري | للنشر على Workers |

```powershell
node -v
npm -v
git --version
```

---

## 3) التشغيل المحلي

```powershell
cd C:\Users\Mahmoud\Desktop\domino
npm install
npm start
```

- اللعبة على: `http://localhost:3000`
- تغيير البورت:

```powershell
$env:PORT = "3100"
npm start
```

```bash
PORT=3100 npm start
```

- افتح المتصفح → اكتب اسمك → **إنشاء غرفة** أو **العب ضد البوتات**.
- اللعب على نفس الشبكة: استخدم IP الجهاز من `/host-info` أو زر QR/لينك الدعوة في اللوبي.
  `localhost` على الموبايل معناها الموبايل نفسه، مش الكمبيوتر.

### أوامر سريعة

| الأمر | الوظيفة |
|---|---|
| `npm start` | سيرفر اللعبة (افتراضي 3000) |
| `npm test` | اختبارات المحرك والبوتات (49 اختبار) |
| `npm run e2e 3100` | اختبار بروتوكول Socket.IO على سيرفر شغال |
| `npm run e2e:voice 3100` | اختبار الصوت والشات على سيرفر شغال |
| `npm run build` (داخل `worker/`) | بناء Worker |
| `npm run deploy` (داخل `worker/`) | نشر Worker على Cloudflare |

---

## 4) ملف `.env` (GitHub + Cloudflare فقط)

الملف موجود محليًا: `.env` — وهو **مستثنى من Git** (اتأكد بـ `git check-ignore -v .env`).
النسخة اللي بتتشارك/تتكوممت هي `.env.example` بنفس المفاتيح وبقيم فاضية.

> **مهم:** السيرفر مش بيقرأ `.env` تلقائيًا. المفاتيح دي خاصة بأدوات النشر
> (GitHub/Cloudflare). متغيرات تشغيل السيرفر (PORT/TURN…) بتتظبط في لوحة الاستضافة
> أو في الـshell — شوف القسم 9.

### المفاتيح

| المفتاح | إلزامي؟ | الشرح |
|---|---|---|
| `GITHUB_TOKEN` | اختياري | Personal Access Token لأوامر git/API الآلية. صلاحيات: `repo` (و `workflow` لو هترفع ملفات Actions). |
| `GITHUB_OWNER` | نعم | صاحب الريبو: `deutche042-ctrl` |
| `GITHUB_REPO` | نعم | اسم الريبو: `domino-arena` |
| `GITHUB_BRANCH` | نعم | الفرع الحالي: `master` (غيّره لو غيّرت اسم الفرع) |
| `CLOUDFLARE_API_TOKEN` | نعم للنشر غير التفاعلي | توكن من Cloudflare → My Profile → API Tokens. صلاحيات: **Workers Scripts:Edit** + **Account Settings:Read**. |
| `CLOUDFLARE_ACCOUNT_ID` | نعم | من Cloudflare Dashboard → Workers & Pages → Account ID. |
| `CLOUDFLARE_WORKER_NAME` | مرجعي | `domino-arena` (الاسم الفعلي في `worker/wrangler.toml`). |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | مرجعي | الـsubdomain بتاعك في `workers.dev` لتكوين الرابط. |
| `DOMINO_URL` | للاختبار | رابط الـWorker المنشور، لاختبار e2e عن بُعد. |
| `CF_TURN_KEY_ID` | نعم للصوت بين شبكات مختلفة | TURN Key ID من Cloudflare → Realtime → TURN. |
| `CF_TURN_KEY_TOKEN` | نعم مع اللي فوق | الـAPI token بتاع نفس الـTURN key — سريه، بيتحط Worker secret. |
| `TURN_URLS` / `TURN_SECRET` / `TURN_USER` / `TURN_PASS` | بديل | لو بتستخدم coturn بتاعك بدل Cloudflare TURN. |

### تحميل `.env` قبل أوامر النشر

**PowerShell (Windows):**

```powershell
Get-Content .env | Where-Object { $_ -match '^\s*[^#][^=]*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  Set-Item -Path ("Env:" + $k.Trim()) -Value $v.Trim()
}
```

**Bash / Git Bash / Linux / macOS:**

```bash
set -a
source .env
set +a
```

بعد كده `$env:CLOUDFLARE_API_TOKEN` (PowerShell) أو `$CLOUDFLARE_API_TOKEN` (Bash)
هيكون متاح لأوامر `wrangler` و`git`.

> لو مش عايز تحمّل الملف، انسخ القيم يدويًا لكل أمر. متحطش التوكنات جوه
> `wrangler.toml` أو أي ملف بيتكوممت.

---

## 5) النشر على GitHub

الريبو متظبط بالفعل:

```powershell
git remote -v
# origin  https://github.com/deutche042-ctrl/domino-arena.git (fetch)
# origin  https://github.com/deutche042-ctrl/domino-arena.git (push)
```

### الرفع العادي

```powershell
git status
git add .
git commit -m "docs: update usage and deployment guide"
git push origin master
```

### المصادقة

- **الأسهل:** Git Credential Manager (بيطلع نافذة تسجيل دخول GitHub أول مرة).
- **بديل:** استخدم PAT كـpassword مع اسم المستخدم عند الطلب (GitHub مبقاش يقبل
  كلمة مرور الحساب العادية).
- **أتمتة:** `GITHUB_TOKEN` في `.env`؛ لو هتستخدم GitHub CLI اعمله mapping:
  - PowerShell: `$env:GH_TOKEN = $env:GITHUB_TOKEN`
  - Bash: `export GH_TOKEN="$GITHUB_TOKEN"`
- **مهم:** متحطش التوكن في رابط الـremote بشكل دائم على جهاز مشترك.

### قواعد الأمان

- `.env` مستثنى — متعملهوش `git add -f`.
- راجع `git status` قبل الـcommit؛ ملفات scratch/.zcode/screenshots مستثناة أصلًا.
- التوكنات تتجدد من GitHub Settings → Developer settings → Tokens.

---

## 6) النشر على Render (Blueprint من GitHub)

1. ارفع الكود على GitHub (القسم 5).
2. Render → **New +** → **Blueprint** → اختار الريبو.
3. Render هيقرأ `render.yaml`:
   - `npm install` للبناء.
   - `npm start` للتشغيل.
   - `healthCheckPath: /healthz`.
   - خطة `free`.
4. بعد النشر هيطلع رابط زي: `https://domino-arena.onrender.com` (أو الاسم اللي Render يديه).
5. ابعت الرابط للأصحاب — HTTPS جاهز.

### Free tier

- السيرفر بينام بعد ~15 دقيقة خمول. عشان يفضل صاحي 24/7 مجانًا:
  - اعمل مراقب على `https://<app>.onrender.com/healthz` كل 5 دقايق
    (مثلًا cron-job.org).
- أول طلب بعد النوم ممكن ياخد ثواني (cold start).

### متغيرات البيئة على Render

- Render بيحدد `PORT` تلقائيًا — **متحطش PORT في لوحة Render**.
- لو عايز صوت/TURN، ضيف المتغيرات من القسم 9 في
  Render → Service → Environment.
- `DOMINO_PUBLIC_DIR` مش مطلوب على Render (الافتراضي صح).
- `MAX_ROOMS` و`LOBBY_TTL_MS` و`TURN_TIME_MS` اختيارية للتحكم في السعة والذاكرة.

---

## 7) النشر على Cloudflare Workers

المشروع فيه Worker كامل في `worker/` بيشغّل نفس `server/server.js` على
Durable Object، مع shims لـexpress/socket.io.

### مرة واحدة

```powershell
cd worker
npm install
```

### النشر بالتوكن (بدون متصفح)

```powershell
# من جذر المشروع: حمّل .env بالأمر في القسم 4، أو حط القيم يدويًا
$env:CLOUDFLARE_API_TOKEN = "..."
$env:CLOUDFLARE_ACCOUNT_ID = "..."

cd worker
npm run build
npm run deploy
```

- `npm run build` بيبني `worker/dist/worker.js`.
- `npm run deploy` بينشر على Cloudflare.
- لو Cloudflare طلب اختيار `workers.dev` subdomain أول مرة، اختاره من اللوحة.

### بديل تفاعلي

```powershell
cd worker
npx wrangler login
npm run deploy
```

### الرابط

```
https://domino-arena.<your-subdomain>.workers.dev
```

- `name = "domino-arena"` في `worker/wrangler.toml`.
- `workers_dev = true`، والأصول بتتقدم من `public/` عبر assets binding.
- Durable Object باسم `DominoGame` على SQLite (مطلوب للخطة المجانية).

### اختبار النشر عن بُعد

```powershell
cd C:\Users\Mahmoud\Desktop\domino
$env:DOMINO_URL = "https://domino-arena.<your-subdomain>.workers.dev"
node scripts/e2e.js
```

```bash
DOMINO_URL=https://domino-arena.<your-subdomain>.workers.dev node scripts/e2e.js
```

### ملاحظات مهمة

- كل deploy جديد بيفصل الـsockets الحالية؛ العملاء بيعيدوا الاتصال تلقائيًا.
- **الصوت/TURN:** الـWorker الحالي بيشغّل السيرفر بالـdefaults، ومتغيرات
  `TURN_*` مش متوصلة تلقائيًا من Cloudflare env إلى `process.env` جوه الـWorker.
  لو محتاج TURN مضمون، استخدم نشر Node/Render (القسم 9) أو وسّع الـWorker
  لتمرير env قبل تحميل السيرفر.
- `wrangler.toml` و`worker/package.json` هما مصدر الحقيقة لإعداد الـWorker؛
  `CLOUDFLARE_WORKER_NAME`/`CLOUDFLARE_WORKERS_SUBDOMAIN` في `.env` للمرجع
  وتكوين الروابط فقط.
- للتطوير المحلي: `cd worker && npm run dev` (يستخدم `wrangler dev`).
  لو احتجت secrets محلية، استخدم `.dev.vars` (مستثنى من Git).

---

## 8) اللعب من جهازك عبر Cloudflare Tunnel

### الطريقة السريعة (Windows)

1. ثبّت cloudflared (لو مش مثبت):
   ```powershell
   winget install --id Cloudflare.cloudflared
   ```
2. دوس دبل كليك على `play.bat`.
3. هيفتح السيرفر على 3000 + Tunnel، ويطبع رابط:
   ```
   https://xxxx-xxxx.trycloudflare.com
   ```
4. ابعت الرابط للأصحاب. HTTPS ضروري للميكروفون.

### الطريقة اليدوية

```powershell
# Terminal 1
npm start

# Terminal 2
cloudflared tunnel --url http://localhost:3000
```

- `play.bat` بيدوّر على cloudflared في:
  `C:\Program Files (x86)\cloudflared\cloudflared.exe`.
  لو مسار مختلف، عدّل الملف أو استخدم الأمر اليدوي.
- اللعب على نفس الواي فاي ممكن بدون Tunnel عبر IP الجهاز، لكن الميكروفون
  غالبًا محتاج HTTPS (استخدم Tunnel).

---

## 9) متغيرات تشغيل السيرفر (مش في `.env`)

دي إعدادات السيرفر نفسها. على Render/Node تتظبط في بيئة التشغيل (Dashboard أو
shell). على Cloudflare Worker القيم الافتراضية هي المستخدمة إلا لو وسّعت الـWorker.

| المتغير | الافتراضي | الشرح |
|---|---|---|
| `PORT` | `3000` | بورت السيرفر. Render بيحدده تلقائيًا. |
| `TURN_TIME_MS` | `30000` | مدة دور اللاعب بالمللي ثانية، بحد أدنى 1000. |
| `MAX_ROOMS` | `50` | أقصى عدد غرف متزامنة (حماية للذاكرة). |
| `LOBBY_TTL_MS` | `1800000` | تنظيف غرف اللوبي الخاملة (30 دقيقة)، بحد أدنى 5000. |
| `DOMINO_PUBLIC_DIR` | `../public` | مسار ملفات العميل (مش مطلوب عادة). |
| `TURN_URLS` | فاضي | روابط TURN مفصولة بفواصل، مثال: `turn:turn.example.com:3478,turns:turn.example.com:5349`. |
| `TURN_USER` | فاضي | اسم مستخدم TURN الثابت. |
| `TURN_PASS` | فاضي | كلمة سر TURN الثابتة. |
| `TURN_SECRET` | فاضي | سر coturn REST (مفضّل) لتوليد بيانات مؤقتة. |
| `TURN_TTL` | `600` | صلاحية بيانات TURN المؤقتة بالثواني (60–3600). |

### الصوت

- `/voice-config` بيرجع `{ iceServers }` فقط، ومش بيسرب أي متغيرات تانية.
- لو مفيش TURN، العملاء بيستخدموا STUN الافتراضي؛ ده بيشتغل في شبكات كتير
  لكن مش كلها. لشبكات صارمة (NAT متماثل) محتاج TURN.
- الميكروفون محتاج **HTTPS** أو `localhost`. على LAN عبر HTTP الميك مش هيشتغل.
- TURN_SECRET أفضل من TURN_USER/PASS لأنه بيولّد بيانات قصيرة العمر.
- على Render: ضيف المتغيرات في Environment.
- على Cloudflare Worker: راجع ملاحظة TURN في القسم 7.

---

## 10) الاختبارات

### اختبارات الوحدة (محرك + بوتات)

```powershell
npm test
```

المتوقع: `49` اختبار ناجح (قواعد المتغيرات، السبينر، الخمسات، fuzz 300 ماتش،
حدود البوتات ومنع الغش).

### e2e — سيرفر محلي

```powershell
# Terminal 1
$env:PORT = "3100"
npm start

# Terminal 2
npm run e2e 3100
npm run e2e:voice 3100
```

- `e2e`: 63 فحص (غرف/لوبي/لعب/شات/إعادة اتصال/بوتات/متفرجين).
- `e2e:voice`: 67 فحص (صوت، كتم، إشارات، شات، rate limit، إعادة اتصال).
- `E2E_TTL=1` (اختياري) بيشغّل فحص تنظيف غرف اللوبي الخاملة (بيطول ~20 ثانية).

### e2e — سيرفر منشور

```powershell
$env:DOMINO_URL = "https://your-deployment.example"
node scripts/e2e.js
```

### قبل أي commit

```powershell
npm test
node --check server/server.js
node --check public/js/app.js
git status
```

---

## 11) استخدام اللعبة بسرعة

### الرئيسية

- اكتب اسمك.
- **إنشاء غرفة** (لعب مع أصحاب) أو **العب ضد البوتات**.
- إعدادات اللعب: مستوى البوت، شخصية البوت، ثيم القطع، جودة الرسوم.
- إحصائيات محلية (ماتشات/فوز/سلسلة/متوسط).

### اللوبي

- كود الغرفة + نسخ الكود/اللينك + QR.
- المضيف بيحدد: النوع، نقاط الفوز، أقصى لاعبين، وقت الدور، عدد الكروت،
  السماح بالباص، حجب آخر كارتين.
- **تصميم الطاولة** و**بيئة اللعب**: اختيار محلي لكل جهاز، مع معاينة 3D/360°.
- الكل يضغط **أنا جاهز**، والمضيف يبدأ.

### اللعب

- دورك: القطع المتاحة بتظهر مرتفعة/ملونة.
- دوس على القطعة → الأطراف المتاحة تتوهج → دوس على الطرف.
- لو مفيش حركة: **اسحب** أو **باص** حسب النوع.
- المؤقّت بيظهر في الـHUD؛ انتهاء الوقت بيلعب/يتخطى تلقائيًا.
- شات + إيموجي + صوت (اختياري) + كتم من المضيف.
- نهاية اليد/الماتش: نقاط، ترتيب، إعادة ماتش/جولة.

### الجودة والطاولات والبيئات

- **جودة الرسوم:** Auto / عالي / منخفض. Auto بيختار الأفضل لجهازك (الموبايل
  بيبدأ منخفض).
- **تصميم الطاولة:** 6 تصاميم (كلاسيكية + 5 موديلات CC0).
- **بيئة اللعب:** 13 بيئة 360° (كافيه، بار، بلياردو، صالة، مطعم، مدفأة، بحر،
  غروب، نجوم…). الافتراضي: كافيه مريح.
- الاختيار بيتحفظ على **جهازك** (كل لاعب يقدر يختار شكله).

---

## 12) بنية المشروع

```
engine/          قواعد اللعبة النقية (deck, game, bot) — بدون IO
server/          Express + Socket.IO (server.js, rooms.js)
public/          العميل: index.html, css/, js/, vendor/ (Three.js, socket.io, خطوط)
  js/app.js      تنسيق الشاشات + Socket + اليد + الشات + الإعدادات
  js/board3d.js  طاولة Three.js + الطاولات المختارة + البيئة
  js/tables3d.js سجل تصاميم الطاولات + تحميل/تثبيت الموديل
  js/environments3d.js  سجل البيئات + تحميل HDRI
  js/tablepreview.js    معاينة طاولة 3D
  js/envpreview.js      معاينة بيئة 360°
  vendor/tables/        موديلات طاولات CC0
  vendor/environments/  بيئات 360° CC0 (1K/2K + خلفية + thumbs)
worker/          نشر Cloudflare Workers + Durable Object
  wrangler.toml  اسم الـWorker والأصول والـDO
scripts/         e2e.js / e2e-voice.js
tests/           اختبارات node:test
render.yaml      Blueprint لـRender
play.bat         تشغيل + Cloudflare Tunnel على Windows
.env.example     قالب مفاتيح GitHub/Cloudflare
USAGE_AND_DEPLOYMENT.md  هذا الدليل
```

---

## 13) استكشاف الأخطاء

### البورت مشغول

```powershell
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

أو شغّل على بورت تاني: `$env:PORT="3100"; npm start`.

### GitHub push مرفوض

- تأكد من المصادقة (Credential Manager أو PAT).
- لو التوكن انتهى/اتلغى: جدده من GitHub → Settings → Developer settings.
- تأكد إنك على الفرع الصح: `git branch --show-current` (المتوقع `master`).

### Cloudflare: Authentication error / 10000

- `CLOUDFLARE_API_TOKEN` صح ومفيهوش مسافات.
- `CLOUDFLARE_ACCOUNT_ID` صح.
- صلاحيات التوكن: Workers Scripts:Edit + Account Settings:Read.
- جرّب `npx wrangler whoami` من `worker/`.

### Render بينام/بطيء أول مرة

- عادي في الخطة المجانية. اضبط ping على `/healthz` كل 5 دقايق.

### الميكروفون لا يعمل

- لازم HTTPS أو `localhost` (مش HTTP على LAN).
- اسمح بصلاحية الميكروفون من المتصفح.
- لو الأصحاب على شبكات مختلفة ومفيش اتصال: اضبط TURN (القسم 9).
- `/voice-config` rate-limited (20 طلب/دقيقة/IP) — متعملش refresh كتير.

### الموبايل بطيء

- الجودة Auto بتختار Low للموبايل؛ جرّب **منخفض** يدويًا.
- البيئات/الطاولات بتتحمل عند الاختيار فقط (1K للموبايل).
- اقفل التبويبات التانية؛ الـWebGL محتاج ذاكرة.

### الواجهة القديمة ظاهرة بعد التحديث

- اعمل Hard Refresh (Ctrl+F5).
- للمطورين: زوّد `?v=` للملف المعدّل في `index.html` والمستوردين، وزوّد
  `SW_VER` في `public/sw.js` (الكاش بيعتمد على الاتنين).

### دخول الغرفة مرفوض بحجة محاولات كثيرة

- الحماية: 5 محاولات فاشلة/10 ثواني للسوكيت، و20/60 ثانية للـIP.
- استنى شوية أو ادخل غرفة ناجحة عشان العدادات تتصفر.

### 3D مش ظاهر / WebGL غير متاح

- اللعبة بتفضل شغالة باليد والـHUD؛ الطاولة 3D بس مش هتظهر.
- جرّب متصفح أحدث أو فعّل تسريع الرسوميات.

### اللعبة اتقفلت/الغرفة اختفت

- غرف اللوبي الخاملة بتتنضف بعد `LOBBY_TTL_MS`.
- غرف البوتات بتتقفل بعد خروج اللاعب البشري.
- إعادة الاتصال بتشتغل بالتوكن خلال سماحية معينة.

---

## 14) الأمان والصيانة

- **`.env` سري:** مستثنى من Git؛ متشاركوش. `.env.example` هو اللي بيتشارك.
- **أقل صلاحية:** توكن GitHub للريبو المطلوب فقط؛ توكن Cloudflare للـWorkers فقط.
- **تدوير التوكنات:** أي توكن اتكشف، الغيه فورًا من اللوحة.
- **TURN_SECRET:** متحطوش في العميل؛ `/voice-config` بيولّد بيانات مؤقتة فقط.
- **`.dev.vars`:** لأسرار wrangler المحلية، ومستثنى من Git.
- **النسخ الاحتياطي:** الريبو على GitHub + نسخة محلية.
- **التحديثات:** بعد أي تعديل في `public/` زوّد نسخ الكاش، وشغّل `npm test`
  وe2e المناسب.
- **التراخيص:** أي أصل جديد لازم يكون بترخيص يسمح بالاستخدام (CC0/CC-BY مع
  الكريديت). الأصول الحالية CC0 وموثقة في `public/vendor/*/CREDITS.md`.

---

## 15) الأصول والتراخيص

- **الطاولات (6):** 5 موديلات Poly Haven CC0 + الطاولة الكلاسيكية الأصلية.
  - التفاصيل: `public/vendor/tables/CREDITS.md`.
- **البيئات (13):** HDRIs من Poly Haven CC0، مُعالجة إلى 1K/2K + خلفية غرفة.
  - التفاصيل: `public/vendor/environments/CREDITS.md`.
- **Three.js:** MIT (مُورَّد محليًا).
- **socket.io / socket.io-client:** MIT.
- **الخطوط:** ملفات محلية في `public/vendor/fonts/`؛ الواجهة الحالية بتستخدم
  Arial/Segoe UI/Tahoma كـfallback.

---

## 16) Checklist قبل النشر

- [ ] `.env` متعمل وبه توكن Cloudflare/حساب (لو هتنشر Worker).
- [ ] `.env` مش ظاهر في `git status` (مستثنى).
- [ ] `npm test` ناجح.
- [ ] `node --check` على أي JS معدّل.
- [ ] الريبو مرفوع على GitHub والفرع صح.
- [ ] Render Blueprint اتقرأ (`render.yaml`) و`/healthz` بيرجع 200.
- [ ] أو Worker متبني ومنشور والرابط بيفتح.
- [ ] `DOMINO_URL` متظبط وe2e عن بُعد ناجح.
- [ ] تجربة إنشاء غرفة + دخول لاعب تاني + بدء لعبة.
- [ ] تجربة الميك على HTTPS (لو الصوت مطلوب) وTURN لو الشبكة صارمة.
- [ ] Hard Refresh للتأكد من أحدث نسخة.
