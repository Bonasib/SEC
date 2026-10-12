'use strict';
// Stored files (photos and documents) live under UPLOAD_DIR, outside the code folder in production.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { HttpError } = require('./util');

const UPLOAD_DIR = process.env.UPLOAD_DIR || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'uploads') : path.join(__dirname, '..', 'uploads'));

const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|heic|heif)$/;
const DOC_TYPES = /^(application\/pdf|image\/(jpeg|png|webp|heic|heif)|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|application\/vnd\.ms-excel|text\/plain|text\/csv)$/;

function storage(sub) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, sub, new Date().toISOString().slice(0, 7));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, crypto.randomUUID() + (path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6) || '')),
  });
}

// Wrong file types are rejected with a clear message (not silently dropped)
// Some browsers send a generic type (application/octet-stream): the file extension then decides
const EXT_TYPES = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv', '.txt': 'text/plain' };
const filter = (re, msg) => (req, file, cb) => {
  const byExt = EXT_TYPES[path.extname(file.originalname || '').toLowerCase()];
  if (!re.test(file.mimetype) && byExt && re.test(byExt) && /^(application\/octet-stream|binary\/octet-stream|)$/.test(file.mimetype || '')) file.mimetype = byExt;
  return re.test(file.mimetype) ? cb(null, true) : cb(new HttpError(400, msg));
};
const imageUpload = multer({ storage: storage('images'), limits: { fileSize: 8 * 1024 * 1024, files: 1 }, fileFilter: filter(IMAGE_TYPES, 'Choose an image (JPG, PNG, WEBP) / اختر صورة') });
const docUpload = multer({ storage: storage('docs'), limits: { fileSize: 25 * 1024 * 1024, files: 10 }, fileFilter: filter(DOC_TYPES, 'Allowed: PDF, images, Word, Excel / الملفات المسموحة: PDF، صور، Word، Excel') });

const rel = (absPath) => path.relative(UPLOAD_DIR, absPath);
const sha256 = (absPath) => crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
function abs(relPath) {
  const file = path.resolve(UPLOAD_DIR, relPath);
  if (!file.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) throw new HttpError(400, 'Bad path');
  return file;
}
function send(res, relPath, mime, downloadName, inline = true) {
  const file = abs(relPath);
  if (!fs.existsSync(file)) throw new HttpError(404, 'File not found / الملف غير موجود');
  res.type(mime || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=86400');
  res.set('X-Content-Type-Options', 'nosniff');
  if (downloadName) res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
  res.sendFile(file);
}
const remove = (relPath) => { try { fs.rmSync(abs(relPath), { force: true }); } catch { /* already gone */ } };
const cleanup = (req) => [].concat(req.file || [], req.files || []).forEach((f) => fs.rm(f.path, () => {}));

module.exports = { UPLOAD_DIR, imageUpload, docUpload, rel, sha256, send, remove, cleanup, abs };
