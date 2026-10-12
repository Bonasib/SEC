# النشر على Hostinger وربط GitHub · Deploying on Hostinger with GitHub

النظام تطبيق **Node.js 22** بقاعدة بيانات **SQLite** مدمجة (لا يحتاج MySQL). الملفات الجاهزة للنشر:
The system is a **Node.js 22** app with an embedded **SQLite** database (no MySQL needed). Ready-made deployment files:

| الملف · File | الغرض · Purpose |
|---|---|
| `.env.example` | جميع الإعدادات (انسخه إلى `.env`) · all settings (copy to `.env`) |
| `deploy/setup-vps.sh` | تجهيز VPS بأمر واحد: Node 22، PM2، Nginx، SSL، جدار حماية، نسخ احتياطي يومي · one-command VPS setup |
| `deploy/update.sh` | تحديث من GitHub بنسخة احتياطية وإعادة تشغيل بدون توقف · pull, back up, zero-downtime reload |
| `deploy/nginx-sec-wms.conf` | إعداد Nginx (رفع صور حتى 300MB) · reverse proxy |
| `ecosystem.config.cjs` | إعداد PM2 (نسخة واحدة) · PM2 process file |
| `Dockerfile`, `docker-compose.yml` | تشغيل عبر Docker مع حفظ البيانات في volume · Docker option |
| `.github/workflows/ci.yml` | تشغيل الاختبارات عند كل رفع · tests on every push |
| `.github/workflows/deploy-hostinger-vps.yml` | نشر تلقائي إلى VPS عند الرفع إلى `main` · auto-deploy on push to `main` |

> **مهم:** في الإنتاج (`NODE_ENV=production`) يبدأ النظام **بدون بيانات تجريبية**؛ يُنشأ حساب مدير النظام فقط بكلمة المرور `ADMIN_PASSWORD`، ثم تُستورد الهيكلة والموظفون والأصول من Excel (استيراد وتصدير البيانات).
> **Important:** in production the system starts **without sample data** — only the administrator account (password from `ADMIN_PASSWORD`). Then import the organization, employees, assets, fleet and courses from Excel (Import & Export).

---

## 1) رفع المشروع إلى GitHub · Put the project on GitHub

1. أنشئ مستودعًا **خاصًا (Private)** فارغًا على GitHub، مثل `sec-transmission-wms`.
   Create an empty **private** repository on GitHub, e.g. `sec-transmission-wms`.
2. من مجلد المشروع · From the project folder:
   ```bash
   git remote add origin git@github.com:OWNER/sec-transmission-wms.git
   git push -u origin main
   ```
3. ستعمل الاختبارات تلقائيًا في تبويب **Actions**. · Tests run automatically in the **Actions** tab.

---

## 2) الخيار (أ) — Hostinger VPS (موصى به) · Option A — Hostinger VPS (recommended)

مناسب لأن البيانات والصور تبقى على قرص دائم ولديك تحكم كامل.
Best fit: data and photos stay on a persistent disk and you have full control.

1. **hPanel → VPS** → نظام التشغيل **Ubuntu 24.04** (أو 22.04). وجّه نطاقًا فرعيًا مثل `wms.yourdomain.com` (سجل A) إلى عنوان IP الخاص بالـ VPS.
   Choose **Ubuntu 24.04** (or 22.04). Point a subdomain (A record) such as `wms.yourdomain.com` to the VPS IP.
2. ادخل إلى الخادم عبر SSH كمستخدم root ثم نفّذ · SSH in as root and run:
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/OWNER/sec-transmission-wms/main/deploy/setup-vps.sh   # public repo
   # أو انسخ الملف يدويًا للمستودع الخاص · or copy the file manually for a private repo
   REPO_URL=git@github.com:OWNER/sec-transmission-wms.git \
   DOMAIN=wms.yourdomain.com EMAIL=you@yourdomain.com \
   bash setup-vps.sh
   ```
   - سيعرض السكربت **مفتاح نشر (Deploy key)**: أضفه في GitHub → المستودع → Settings → Deploy keys (قراءة فقط) ثم اضغط Enter.
     The script prints a **deploy key**: add it in GitHub → repo → Settings → Deploy keys (read-only), then press Enter.
   - يطبع كلمة مرور المدير الأولى ويحفظها في `/opt/sec-wms/.env`. · It prints the first admin password (also saved in `/opt/sec-wms/.env`).
   - يُفعّل HTTPS تلقائيًا (Let's Encrypt) ونسخة احتياطية يومية 02:30 في `/var/lib/sec-wms/backups`.
     It enables HTTPS (Let's Encrypt) and a daily 02:30 backup in `/var/lib/sec-wms/backups`.
3. عدّل إعدادات البريد في `/opt/sec-wms/.env` (انظر القسم 5) ثم · Edit email settings, then:
   ```bash
   sudo -u wms pm2 reload sec-wms --update-env
   ```
4. افتح `https://wms.yourdomain.com` وسجّل الدخول بـ `admin`. **غيّر كلمة المرور** من ملفك الشخصي.
   Open the site, sign in as `admin` and **change the password** from your profile.

### النشر التلقائي من GitHub · Automatic deployment from GitHub
في GitHub → Settings → Secrets and variables → **Actions** أضف · add:

| Secret | القيمة · Value |
|---|---|
| `HOSTINGER_HOST` | عنوان IP للـ VPS · VPS IP |
| `HOSTINGER_USER` | `wms` |
| `HOSTINGER_SSH_KEY` | مفتاح خاص مسموح له بالدخول كمستخدم `wms` · a private key authorized for user `wms` |
| `HOSTINGER_PORT` | اختياري (22) · optional |

لإنشاء المفتاح · To create that key (on your computer):
```bash
ssh-keygen -t ed25519 -f hostinger_deploy -N ""
# على الخادم · on the server: add hostinger_deploy.pub to /home/wms/.ssh/authorized_keys
```
بعدها كل `git push` إلى `main` ⇐ اختبارات ⇐ نسخة احتياطية ⇐ تحديث وإعادة تشغيل بدون توقف.
After that every push to `main` → tests → backup → update and reload with no downtime.

---

## 3) الخيار (ب) — استضافة Node.js في hPanel (Business / Cloud) · Option B — hPanel Node.js Web App

متاح في خطط **Business Web Hosting** و **Cloud** (Startup / Professional / Enterprise). · Available on **Business** and **Cloud** plans.

1. hPanel → **Websites → Add Website → Node.js Web App → Import Git repository**، ثم اربط حساب GitHub وثبّت **Hostinger GitHub App** واسمح لها بالوصول إلى المستودع، ثم اختر الفرع `main`.
   hPanel → Websites → Add Website → Node.js Web App → **Import Git repository**; connect GitHub, install the **Hostinger GitHub App** with access to this repository, and pick `main`.
2. الإعدادات · Settings:
   - **Node.js version:** `22` أو `24` (يكتشفها تلقائيًا من `engines` في `package.json`) · auto-detected from `package.json`
   - **Build command:** اتركه فارغًا أو `npm ci` (لا يوجد بناء) · leave empty or `npm ci` (no build step)
   - **Start command:** `npm start`  · Entry file: `src/server.js`
3. **Environment variables** (من `.env.example`): `NODE_ENV=production`, `APP_URL`, `ADMIN_PASSWORD`, بيانات SMTP، و`DATA_DIR`.
   - اجعل `DATA_DIR` مجلدًا **خارج مجلد التطبيق** حتى لا يُحذف عند إعادة النشر، مثل `/home/<user>/sec-wms-data`.
     Set `DATA_DIR` to a folder **outside the app folder** so redeploys never remove the database/photos, e.g. `/home/<user>/sec-wms-data`.
4. انشر، ثم افتح الموقع وسجّل الدخول بـ `admin`. · Deploy, open the site, sign in as `admin`.
5. فعّل النشر التلقائي عند الرفع (Auto-deploy) من نفس الصفحة إن توفر. · Enable auto-deploy on push if offered.

> ملاحظة: يشغّل النظام مجدولًا داخليًا كل دقيقة (التنبيهات، التسليم المجدول، البريد). يجب أن تعمل **نسخة واحدة فقط** دائمًا.
> The app runs an internal every-minute scheduler (alerts, scheduled hand-overs, email). Keep **exactly one instance** running.

---

## 4) الخيار (ج) — Docker على VPS · Option C — Docker on a VPS

```bash
git clone git@github.com:OWNER/sec-transmission-wms.git && cd sec-transmission-wms
cp .env.example .env    # عدّل القيم · edit values (keep DATA_DIR=/data)
docker compose up -d --build
```
البيانات في volume باسم `wms-data`. استخدم إعداد Nginx في `deploy/` أمام المنفذ 3000 مع certbot.
Data lives in the `wms-data` volume. Put the Nginx config from `deploy/` in front of port 3000 and run certbot.

---

## 5) البريد عبر Hostinger · Email with Hostinger Mail

أنشئ بريدًا مثل `wms@yourdomain.com` في hPanel → Emails، ثم في `.env`:
Create a mailbox such as `wms@yourdomain.com` in hPanel → Emails, then set:
```
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=wms@yourdomain.com
SMTP_PASS=********
MAIL_FROM="Transmission WMS <wms@yourdomain.com>"
APP_URL=https://wms.yourdomain.com
```
جرّبه من **الإعدادات → إرسال بريد اختبار**. · Test from **Settings → Send test email**.

---

## 6) التشغيل اليومي · Operations

| المهمة · Task | الأمر · Command (VPS) |
|---|---|
| الحالة والسجلات · status & logs | `sudo -u wms pm2 status` · `sudo -u wms pm2 logs sec-wms` |
| تحديث يدوي · manual update | `sudo -u wms bash /opt/sec-wms/deploy/update.sh` |
| نسخة احتياطية الآن · backup now | `cd /opt/sec-wms && sudo -u wms npm run backup` |
| فحص الصحة · health check | `curl https://wms.yourdomain.com/healthz` |
| الاستعادة · restore | `pm2 stop sec-wms` → `cp backups/app-XXXX.db /var/lib/sec-wms/app.db` → `pm2 start sec-wms` |

انسخ مجلد `/var/lib/sec-wms/backups` دوريًا خارج الخادم (مثل Hostinger Backups أو تخزين خارجي).
Copy `/var/lib/sec-wms/backups` off the server regularly (Hostinger backups or external storage).

### استخراج البيانات من الملفات · Extracting data from files

- يقرأ النظام الصور والملفات الممسوحة محليًا (OCR). تُنزَّل ملفات اللغة (~8MB) مرة واحدة من jsDelivr إلى `DATA_DIR/ocr-cache`؛ في خادم بلا إنترنت انسخ `ara.traineddata` و`eng.traineddata` إليه.
  OCR runs on the server. The language files (~8 MB) download once from jsDelivr into `DATA_DIR/ocr-cache`; on an offline server copy `ara.traineddata` and `eng.traineddata` there.
- اختياري: `ANTHROPIC_API_KEY` لقراءة أدق بالذكاء الاصطناعي. **تنبيه خصوصية:** عند تفعيله تُرسل الصور وملفات PDF الممسوحة إلى Anthropic.
  Optional: `ANTHROPIC_API_KEY` for AI reading. **Privacy:** with it set, photos and scanned PDFs are sent to Anthropic.

## 7) قائمة التحقق قبل التشغيل الفعلي · Go-live checklist

- [ ] HTTPS يعمل (ملفات تعريف الارتباط آمنة في الإنتاج) · HTTPS works (cookies are Secure in production)
- [ ] تغيير كلمة مرور `admin` · admin password changed
- [ ] إعداد SMTP وإرسال بريد اختبار · SMTP configured and tested
- [ ] استيراد الهيكل التنظيمي ثم الموظفين ثم الأصول والأسطول والدورات · import org → employees → assets, fleet, courses
- [ ] اعتماد قيم الإعدادات (المهل، حد 20 مهمة، النقاط) · approve policy values in Settings / Points
- [ ] النسخ الاحتياطي اليومي يعمل وتمت تجربة الاستعادة · daily backup running, restore tested
- [ ] `SEED_DEMO=false` (لا بيانات تجريبية) · no sample data
- [ ] قرار مكتوب بشأن `ANTHROPIC_API_KEY` (إرسال الملفات إلى Anthropic أم لا) · a decision on `ANTHROPIC_API_KEY` (send files to Anthropic or not)
- [ ] تعيين مدقق واحد على الأقل (دور auditor) لمراجعة البيانات المستخرجة · at least one auditor to review extracted data
