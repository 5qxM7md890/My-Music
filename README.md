# MYMUSICBOT (نسخة مُنظّفة ومُصلّحة)

هذي النسخة تصلّح أهم سبب كان يكسّر اتصال Lavalink عندك:
- ملف `.env` كان يستخدم `LAVALINK_AUTH` بينما الكود كان يقرأ `LAVALINK_PASSWORD`.
  الآن الكود يدعم الاثنين.
- ملف Lavalink `application.yml` كان فيه كلمة سر placeholder وما فيه YouTube plugin.

> **مهم جداً:** التوكنات اللي كانت داخل `.env` انكشفت هنا. لازم **تغيّر** توكنات البوتات من Discord Developer Portal فوراً.

## المتطلبات
- Node.js 18+ (يفضّل 20+)
- سيرفر Lavalink v4 (Java) أو Docker (اختياري)
- صلاحيات Discord للبوت: `Send Messages`, `Embed Links`, `Connect`, `Speak`

## إعداد البوت (Node)
1) ارفع ملفات البوت على سيرفر Node في control.bot-hosting.net
2) انسخ `.env.example` إلى `.env` داخل السيرفر وعبّي القيم
3) ثبّت الحزم:
   - لو اللوحة تسويها تلقائي: بس شغّل السيرفر
   - أو يدوي: `npm i`
4) سجّل أوامر السلاش:
   - شغّل: `npm run deploy` مرة وحدة
5) شغّل البوت:
   - `npm start`

## إعداد Lavalink (Java) — الخيار الموصى به لليوتيوب
### خيار A: Docker (إذا متوفر)
داخل مجلد `lavalink/`:
- عدّل كلمة السر في `application.yml` إذا تبغى
- شغّل:
  `docker compose -f compose.yml up -d`

### خيار B: Java server (الأشهر في لوحات الاستضافة)
1) نزّل Lavalink v4 jar من GitHub releases (المستودع الرسمي)
2) ارفع `Lavalink.jar` + `application.yml` (هذا الملف) في نفس المجلد
3) Start command:
   `java -jar Lavalink.jar`

> `application.yml` هنا مهيأ لتحميل Plugin اليوتيوب تلقائياً عبر:
> `lavalink.plugins` (Maven) — إذا استضافتك تمنع التحميل، لازم ترفع jar plugin يدويًا داخل `plugins/`.

## متغيرات Lavalink المهمة
- `LAVALINK_URL` مثال: `fi7.bot-hosting.net:20060`
- `LAVALINK_PASSWORD` أو `LAVALINK_AUTH` لازم يطابق كلمة السر في `application.yml`

## أوامر البوت
- `/play query`
- `/search query` (يعطيك قائمة تختار منها)
- `/skip`
- `/pause`
- `/resume`
- `/stop`
- `/queue`
- `/panel`
- `/rooms`
- `/bind` (إدارة السيرفر)
- `/unbind` (إدارة السيرفر)
- `/debug`

## وضع Multi-Room (تشغيل 15 بوت على 15 روم — أو أكثر)
### الفكرة
- **MANAGER_TOKEN**: هذا البوت فقط للوحة التحكم والأوامر (ما يدخل فويس).
- **WORKER_TOKENS**: هذولي بوتات الصوت اللي يدخلون الرومات ويشغلون الموسيقى.
- كل **روم صوتي** له **Session** و **Queue** مستقلة.

### الخصوصية (مثل ما طلبت)
- اللوحة العامة في روم التحكم **ما تعرض اسم الأغنية**.
- إذا ضغطت زر **My Room Panel** بيطلع لك Panel **Ephemeral** (يظهر لك أنت بس) ويعرض:
  - Now Playing + Queue + أزرار التحكم
- عشان أحد يشوف وش شغال في روم معيّن لازم يدخل نفس الروم الصوتي ثم يضغط **My Room Panel**.

### تخصيص الإيموجيات في اللوحة
تقدر تغيّر إيموجيات الأزرار من `config.json`:
```json
{
  "emojis": {
    "refresh": { "id": "1449445887532072991", "name": "icons_refresh" },
    "myRoomPanel": { "id": "1449446233935450244", "name": "MekoServer" },
    "musicNote": { "id": "1452378261878472999", "name": "Volume" }
  }
}
```
> الاسم بدون `:` (لو كتبته مع `:` ما يضر، الكود يشيله).

### إعداد الرومات وتوزيع البوتات
عندك طريقتين:

#### 1) عن طريق الأوامر (أسهل)
1) شغّل البوت وخليه يسجل الأوامر.
2) في روم التحكم:
   - `/bind room:<روم_صوتي> bot:<رقم>`
   - مثال: `/bind room:#المحكمة bot:1`
3) اعرض التوزيع:
   - `/rooms`
4) حدّث اللوحة:
   - `/panel`

#### 2) عن طريق config.json
أضف قسم `rooms` بهذا الشكل:
```json
{
  "controlTextChannelId": "...",
  "cleanControlChannel": true,
  "keep24_7": true,
  "restrictToRooms": true,
  "restrictCommandsToControlChannel": true,
  "rooms": [
    { "voiceChannelId": "VOICE_ID_1", "bot": 1 },
    { "voiceChannelId": "VOICE_ID_2", "bot": 2 },
    { "voiceChannelId": "VOICE_ID_3", "bot": 3 },
    { "voiceChannelId": "VOICE_ID_4", "bot": 4 },
    { "voiceChannelId": "VOICE_ID_5", "bot": 5 },

    { "voiceChannelId": "VOICE_ID_6", "bot": 6 },
    { "voiceChannelId": "VOICE_ID_7", "bot": 7 },
    { "voiceChannelId": "VOICE_ID_8", "bot": 8 },
    { "voiceChannelId": "VOICE_ID_9", "bot": 9 },
    { "voiceChannelId": "VOICE_ID_10", "bot": 10 },

    { "voiceChannelId": "VOICE_ID_11", "bot": 11 },
    { "voiceChannelId": "VOICE_ID_12", "bot": 12 },
    { "voiceChannelId": "VOICE_ID_13", "bot": 13 },
    { "voiceChannelId": "VOICE_ID_14", "bot": 14 },
    { "voiceChannelId": "VOICE_ID_15", "bot": 15 }
  ]
}
```

**ملاحظة:** رقم `bot` يعني ترتيب التوكن داخل `WORKER_TOKENS` (1 = أول توكن). تقدر تزود أكثر من 15 إذا عندك توكنات أكثر.

### ملاحظات مهمة
- **تغيير مهم:** `/play` إذا بحثت بالاسم (Search) صار يضيف **أول نتيجة فقط** بدل ما يضيف 10.
- إذا تبغى تختار من النتائج استخدم `/search` (يطلع Select Menu).
- لو `keep24_7=true` البوتات تدخل الرومات المضافة وتظل موجودة.
- لو تبغى تسمح تشغيل الموسيقى بأي روم بدون تقييد، خلي:
  - `restrictToRooms=false`
- لو تبغى تسمح للأوامر بكل السيرفر (مو بس روم التحكم):
  - `restrictCommandsToControlChannel=false`

## تخصيص ايموجيات اللوحة
تقدر تضيف داخل `config.json`:
```json
{
  "emojis": {
    "refresh": { "id": "1449445887532072991", "name": "icons_refresh" },
    "myRoomPanel": { "id": "1449446233935450244", "name": "MekoServer" }
  }
}
```
> الاسم بدون النقطتين `:`.

## ملاحظة عن “بديل أفضل من Lavalink”
حاليًا كثير مكتبات Node أوقفت دعم YouTube رسميًا بسبب كثرة الانكسار.
لو تبغى YouTube باستقرار أعلى، Lavalink v4 + youtube-source plugin غالبًا أفضل حل.
