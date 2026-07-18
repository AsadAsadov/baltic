require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const sharp = require('sharp');
const { performance } = require('perf_hooks');

const prisma = new PrismaClient({ log: [{ level: 'error', emit: 'event' }, { level: 'warn', emit: 'stdout' }] });
prisma.$on('error', (event) => console.error('[prisma:error]', event.message));
const app = express();
app.set('trust proxy', 1);

const isProduction = process.env.NODE_ENV === 'production';
const requiredEnv = ['DATABASE_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'SESSION_SECRET'];
for (const name of requiredEnv) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const adminSessionCookieName = 'bc_admin_session';
const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: isProduction ? { rejectUnauthorized: false } : undefined });
const adminSessionStore = new pgSession({ pool: sessionPool, tableName: 'admin_sessions', createTableIfMissing: true });
adminSessionStore.on('error', (error) => console.error('[session-store:error]', { message: error?.message }));

const allowedSameSiteOrigins = new Set([
  'https://balticcaspian.com',
  'https://www.balticcaspian.com',
  'http://localhost:3002',
  'http://127.0.0.1:3002'
]);
const isStateChangingMethod = (method) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
const validateAdminOrigin = (req, res, next) => {
  if (!isStateChangingMethod(req.method)) return next();
  const origin = req.get('origin');
  const referer = req.get('referer');
  if (origin && allowedSameSiteOrigins.has(origin)) return next();
  if (!origin && referer) {
    try { if (allowedSameSiteOrigins.has(new URL(referer).origin)) return next(); } catch (error) { return res.status(403).json({ ok: false, error: 'Sorğu mənbəyi qəbul edilmir' }); }
  }
  if (!origin && !referer && !isProduction) return next();
  return res.status(403).json({ ok: false, error: 'Sorğu mənbəyi qəbul edilmir' });
};

app.use(cors({ origin: false }));
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ extended: true, limit: '150mb' }));
app.use(session({
  name: adminSessionCookieName,
  store: adminSessionStore,
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  proxy: true,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const allowedUploadBuckets = ['projects', 'gallery', 'hero', 'banners', 'home', 'works'];
const UPLOAD_SIZE_LIMIT_BYTES = 150 * 1024 * 1024;
const uploadRoot = path.join(__dirname, 'uploads');
const uploadBucketFolders = Object.fromEntries(allowedUploadBuckets.map(bucket => [bucket, path.join(uploadRoot, bucket)]));
for (const folder of Object.values(uploadBucketFolders)) fs.mkdirSync(folder, { recursive: true });
const STANDARD_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/bmp', 'image/tiff']);
const HEIC_MIME_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const STANDARD_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp', '.tif', '.tiff']);
const HEIC_EXTENSIONS = new Set(['.heic', '.heif']);
const REJECTED_UNSANITIZED_IMAGE_MIME_TYPES = new Set(['image/svg+xml']);
const allowedVideoExt = new Set(['.mp4', '.webm', '.mov']);
const getUploadExtension = (name = '') => path.extname(path.basename(String(name || ''))).toLowerCase().replace(/[^a-z0-9.]/g, '');
const isAllowedImageUpload = (file) => {
  if (!file || !file.originalname) return false;
  const mimeType = String(file.mimetype || '').toLowerCase().trim();
  const extension = getUploadExtension(file.originalname);
  if (REJECTED_UNSANITIZED_IMAGE_MIME_TYPES.has(mimeType) || extension === '.svg') return false;
  if (STANDARD_IMAGE_MIME_TYPES.has(mimeType)) return STANDARD_IMAGE_EXTENSIONS.has(extension);
  if (HEIC_MIME_TYPES.has(mimeType)) return HEIC_EXTENSIONS.has(extension);
  if ((mimeType === '' || mimeType === 'application/octet-stream') && HEIC_EXTENSIONS.has(extension)) return true;
  return false;
};
const isAllowedVideoUpload = (file) => {
  const ext = getUploadExtension(file?.originalname || '');
  const type = String(file?.mimetype || '').toLowerCase().trim();
  return allowedVideoExt.has(ext) && (type.startsWith('video/') || type === 'application/octet-stream' || type === 'video/quicktime');
};
const isAllowedUploadFile = (file, bucket) => isAllowedImageUpload(file) || isAllowedVideoUpload(file);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: UPLOAD_SIZE_LIMIT_BYTES
  },
  fileFilter: (req, file, cb) => {
    if (isAllowedUploadFile(file, req.body?.bucket)) return cb(null, true);
    return cb(new Error('Yalnız dəstəklənən şəkil formatlarını seçin.'), false);
  }
});
const ensureUploadBucketFolder = async (bucket) => {
  const folder = uploadBucketFolders[bucket];
  if (!folder) return null;
  await fs.promises.mkdir(folder, { recursive: true });
  return folder;
};
const safeUploadFilename = (name = 'upload') => {
  const parsed = path.parse(path.basename(name));
  const base = (parsed.name || 'upload')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '') || 'upload';
  const ext = parsed.ext.toLowerCase().replace(/[^a-z0-9.]/g, '');
  return `${base}${ext}`;
};
const MAX_IMAGES_PER_ITEM = 40;
const limitImageArray = (images, label = 'images') => {
  if (!Array.isArray(images)) return { errors: [`${label} must be an array`] };
  if (images.length > MAX_IMAGES_PER_ITEM) return { errors: [`${label} cannot contain more than ${MAX_IMAGES_PER_ITEM} images`] };
  return { images };
};

const isDbError = (err) => ['PrismaClientInitializationError', 'PrismaClientUnknownRequestError', 'PrismaClientRustPanicError'].includes(err?.name) || ['P1000', 'P1001', 'P1002', 'P1003', 'P1010', 'P1011', 'P1012', 'P1013', 'P1014', 'P1015', 'P1017', 'P2024'].includes(err?.code);
const dbUnavailable = (res, err) => res.status(503).json({ ok: false, error: 'DATABASE_UNAVAILABLE', message: err?.message || 'Database connection failed', code: err?.code, field: err?.meta?.field_name || err?.meta?.column || err?.meta?.target });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
  console.error(`[api:error] ${req.method} ${req.originalUrl}`, { name: err?.name, code: err?.code, message: err?.message });
  if (isDbError(err)) return dbUnavailable(res, err);
  next(err);
});
const intId = (req) => Number.parseInt(req.params.id, 10);
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
const idWhere = (id) => {
  if (isUuid(id)) return { id: String(id) };
  const legacyId = Number.parseInt(id, 10);
  return Number.isFinite(legacyId) ? { legacyId } : { id: '00000000-0000-0000-0000-000000000000' };
};
const heroIdWhere = (id) => isUuid(id) ? { id: String(id) } : null;
const invalidHeroId = (res) => res.status(400).json({ ok: false, error: 'INVALID_HERO_ID' });
const jsonArray = (v) => Array.isArray(v) ? v : [];
const apiCache = new Map();
const CACHE_TTL = {
  projectsList: 3 * 60 * 1000,
  worksList: 3 * 60 * 1000,
  galleryList: 3 * 60 * 1000,
  heroList: 2 * 60 * 1000,
  publicSettings: 5 * 60 * 1000
};
const roundMs = (value) => Math.round((Number(value) || 0) * 10) / 10;
const shouldLogPerf = (m = {}) => (m.totalMs > 500 || m.dbMs > 300 || m.normalizeMs > 100);
function logSlowPerf(label, metrics = {}) {
  const clean = Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, typeof value === 'number' ? roundMs(value) : value]));
  if (shouldLogPerf(clean)) console.info(`[perf:${label}]`, clean);
}
function cacheKey(parts) { return Array.isArray(parts) ? parts.filter(Boolean).join(':') : String(parts); }
function invalidateCache(prefixes = []) {
  const list = Array.isArray(prefixes) ? prefixes : [prefixes];
  for (const key of apiCache.keys()) if (list.some(prefix => key === prefix || key.startsWith(`${prefix}:`))) apiCache.delete(key);
}
async function getOrSetCache(key, ttlMs, loader) {
  const now = Date.now();
  const existing = apiCache.get(key);
  if (existing?.data && existing.expiresAt > now) return { data: existing.data, cache: 'hit' };
  if (existing?.promise) return { data: await existing.promise, cache: 'shared-promise' };
  if (existing?.data) {
    const promise = Promise.resolve().then(loader).then(data => {
      apiCache.set(key, { data, expiresAt: Date.now() + ttlMs, promise: null });
      return data;
    }).catch(error => { apiCache.set(key, { ...existing, promise: null }); throw error; });
    apiCache.set(key, { ...existing, promise });
    return { data: existing.data, cache: 'stale' };
  }
  const promise = Promise.resolve().then(loader).then(data => {
    apiCache.set(key, { data, expiresAt: Date.now() + ttlMs, promise: null });
    return data;
  }).catch(error => { apiCache.delete(key); throw error; });
  apiCache.set(key, { data: null, expiresAt: 0, promise });
  return { data: await promise, cache: 'miss' };
}

const heroSlideSelect = { id:true, legacyId:true, titleAz:true, titleRu:true, titleEn:true, subtitleAz:true, subtitleRu:true, subtitleEn:true, mediaType:true, mediaUrl:true, image:true, buttonTextAz:true, buttonTextRu:true, buttonTextEn:true, buttonLink:true, tagAz:true, tagRu:true, tagEn:true, title1Az:true, title1Ru:true, title1En:true, title2Az:true, title2Ru:true, title2En:true, descAz:true, descRu:true, descEn:true, sortOrder:true, active:true, createdAt:true, updatedAt:true };
const adminTabDefaultVisibility = { dashboard:true, messages:true, projects:true, works:true, gallery:true, hero:true, homeImages:true, ads:true };

const ADMIN_NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, private',
  'Pragma': 'no-cache',
  'Expires': '0'
};
const setAdminNoStore = (res) => res.set(ADMIN_NO_STORE_HEADERS);
const isAdminPrivateGet = (req) => req.method === 'GET' && (
  req.path === '/admin' ||
  req.path.startsWith('/api/admin-panel-settings') ||
  req.path.startsWith('/api/messages') ||
  req.path.startsWith('/api/stats') ||
  (req.path.startsWith('/api/projects') && req.query.includeArchived === 'true') ||
  ((req.path.startsWith('/api/works') || req.path.startsWith('/api/work-items')) && req.query.includeArchived === 'true') ||
  (req.path.startsWith('/api/hero-slides') && req.query.admin === 'true') ||
  (req.path.startsWith('/api/gallery') && req.query.includeArchived === 'true')
);
app.use((req, res, next) => {
  if (isAdminPrivateGet(req)) setAdminNoStore(res);
  next();
});


const requireAdmin = (req, res, next) => {
  if (req.session?.adminAuthenticated === true) return next();
  return res.status(401).json({ ok: false, error: 'Admin girişi tələb olunur' });
};
const requireAdminWrite = [validateAdminOrigin, requireAdmin];
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { ok: false, error: 'Çox sayda uğursuz cəhd. Bir az sonra yenidən yoxlayın.' }
});
const invalidLogin = (res) => res.status(401).json({ ok: false, error: 'İstifadəçi adı və ya şifrə yanlışdır' });
const PROJECT_CATEGORIES = {
  house: 'Taxta Evlər',
  restaurant: 'Restoranlar',
  gazebo: 'Besedkalar',
  sauna: 'Hamam & Sauna'
};
const ALLOWED_CATEGORIES = new Set(Object.keys(PROJECT_CATEGORIES));
const CATEGORY_LABELS = {
  house: { az: 'Taxta Evlər', ru: 'Деревянные дома', en: 'Wooden Houses' },
  restaurant: { az: 'Restoranlar', ru: 'Рестораны', en: 'Restaurants' },
  gazebo: { az: 'Besedkalar', ru: 'Беседки', en: 'Gazebos' },
  sauna: { az: 'Hamam & Sauna', ru: 'Бани & Сауны', en: 'Bath & Sauna' }
};
const CATEGORY_ALIASES = new Map([
  ['house', 'house'], ['taxta ev', 'house'], ['taxta evlər', 'house'], ['wooden house', 'house'],
  ['restaurant', 'restaurant'], ['restoran', 'restaurant'], ['restoranlar', 'restaurant'],
  ['gazebo', 'gazebo'], ['besedka', 'gazebo'], ['besedkalar', 'gazebo'], ['besedka', 'gazebo'],
  ['sauna', 'sauna'], ['bath', 'sauna'], ['hamam', 'sauna'], ['hamam & sauna', 'sauna'], ['hamam və sauna', 'sauna']
]);
function normalizeCategoryValue(value) {
  const key = String(value || '').trim().toLowerCase();
  return CATEGORY_ALIASES.get(key) || key;
}
function validateCategory(value, label = 'category') {
  const category = normalizeCategoryValue(value || 'house');
  if (!ALLOWED_CATEGORIES.has(category)) return { errors: [`Unsupported ${label}: ${value}`] };
  return { category };
}
const workCategoryMap = Object.fromEntries(Object.entries(CATEGORY_LABELS).map(([key, labels]) => [key, { ru: labels.ru, en: labels.en }]))
function excerptText(value = '', limit = 180) { const clean = String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); return clean.length > limit ? `${clean.slice(0, limit).trim()}…` : clean; }
function workOut(w, options = {}) { const list = !!options.list; const descAz = list ? excerptText(w.descriptionAz) : w.descriptionAz; const descRu = list ? excerptText(w.descriptionRu) : w.descriptionRu; const descEn = list ? excerptText(w.descriptionEn) : w.descriptionEn; return w && { id:w.id, slug:w.slug, type:'work', category:w.category, categoryNameAz:CATEGORY_LABELS[w.category]?.az || w.category, categoryRu:CATEGORY_LABELS[w.category]?.ru || w.category, categoryEn:CATEGORY_LABELS[w.category]?.en || w.category, title:w.titleAz, titleAz:w.titleAz, titleRu:w.titleRu, titleEn:w.titleEn, description:descAz, descriptionAz:descAz, descriptionRu:descRu, descriptionEn:descEn, location:w.locationAz, locationAz:w.locationAz, locationRu:w.locationRu, locationEn:w.locationEn, area:w.area, stories:w.stories, rooms:w.rooms, buildTime:w.buildTimeAz, buildTimeAz:w.buildTimeAz, buildTimeRu:w.buildTimeRu, buildTimeEn:w.buildTimeEn, completionDate:w.completionDate, coverImage:listImage(w.coverImage, list ? 'medium' : 'large'), image:listImage(w.coverImage, list ? 'medium' : 'large'), originalImage:w.coverImage, imageVariants:withImageVariants(w.coverImage), images:list ? [listImage(w.coverImage, 'medium')].filter(Boolean) : jsonArray(w.images), sortOrder:w.sortOrder, archived:w.archived, featured:w.featured, active:w.active, createdAt:w.createdAt, updatedAt:w.updatedAt }; }
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj || {}, key);
const firstPresent = (body, keys, fallback = undefined) => {
  for (const key of keys) if (hasOwn(body, key)) return body[key];
  return fallback;
};
const cleanString = (value, fallback = '') => value == null ? fallback : String(value).trim();
const optionalString = (body, keys, fallback = '') => cleanString(firstPresent(body, keys, fallback), fallback);
const intField = (body, key, fallback = null) => {
  if (!hasOwn(body, key)) return fallback;
  if (body[key] === '' || body[key] == null) return null;
  const value = Number(body[key]);
  return Number.isInteger(value) ? value : NaN;
};
const boolField = (body, key, fallback = false) => hasOwn(body, key) ? body[key] === true || body[key] === 'true' || body[key] === 1 || body[key] === '1' : fallback;
const imageArrayField = (body, existing = null) => {
  if (hasOwn(body, 'images')) return Array.isArray(body.images) ? body.images.filter(Boolean) : [];
  if (hasOwn(body, 'image') || hasOwn(body, 'coverImage')) return [body.image || body.coverImage].filter(Boolean);
  return jsonArray(existing?.images);
};
function validateWorkBody(b = {}, existing = null) {
  const errors = [];
  const categoryCheck = validateCategory(firstPresent(b, ['category'], existing?.category || 'house'));
  const category = categoryCheck.category;
  const titleAz = optionalString(b, ['titleAz', 'title'], existing?.titleAz || '');
  const images = imageArrayField(b, existing);
  let coverImage = optionalString(b, ['coverImage', 'image'], existing?.coverImage || images[0] || '');
  if (!coverImage && images.length) coverImage = images[0];
  const sortOrder = intField(b, 'sortOrder', existing?.sortOrder ?? 0);
  const stories = intField(b, 'stories', existing?.stories ?? null);
  const rooms = intField(b, 'rooms', existing?.rooms ?? null);
  const active = boolField(b, 'active', existing?.active ?? true);
  const featured = boolField(b, 'featured', existing?.featured ?? false);
  const archived = boolField(b, 'archived', existing?.archived ?? false);
  const completionDateRaw = firstPresent(b, ['completionDate'], existing?.completionDate || null);
  if (!titleAz) errors.push('titleAz is required');
  if (!coverImage) errors.push('coverImage is required');
  if (categoryCheck.errors) errors.push(...categoryCheck.errors);
  const imageLimit = limitImageArray(images);
  if (imageLimit.errors) errors.push(...imageLimit.errors);
  if (!Number.isInteger(sortOrder) || sortOrder < 0) errors.push('sortOrder must be a non-negative integer');
  if (Number.isNaN(stories)) errors.push('stories must be an integer or empty');
  if (Number.isNaN(rooms)) errors.push('rooms must be an integer or empty');
  let completionDate = null;
  if (completionDateRaw) { completionDate = new Date(completionDateRaw); if (Number.isNaN(completionDate.getTime())) errors.push('completionDate must be a valid date or null'); }
  if (errors.length) return { errors };
  return { data: {
    ...(existing?.slug ? {} : { slug: b.slug }), category,
    titleAz, titleRu: optionalString(b, ['titleRu'], existing?.titleRu || titleAz) || titleAz,
    titleEn: optionalString(b, ['titleEn'], existing?.titleEn || titleAz) || titleAz,
    descriptionAz: optionalString(b, ['descriptionAz', 'description'], existing?.descriptionAz || ''),
    descriptionRu: optionalString(b, ['descriptionRu'], existing?.descriptionRu || optionalString(b, ['descriptionAz', 'description'], '')),
    descriptionEn: optionalString(b, ['descriptionEn'], existing?.descriptionEn || optionalString(b, ['descriptionAz', 'description'], '')),
    locationAz: optionalString(b, ['locationAz', 'location'], existing?.locationAz || ''),
    locationRu: optionalString(b, ['locationRu'], existing?.locationRu || optionalString(b, ['locationAz', 'location'], '')),
    locationEn: optionalString(b, ['locationEn'], existing?.locationEn || optionalString(b, ['locationAz', 'location'], '')),
    area: optionalString(b, ['area'], existing?.area || ''), stories, rooms,
    buildTimeAz: optionalString(b, ['buildTimeAz', 'buildTime'], existing?.buildTimeAz || ''),
    buildTimeRu: optionalString(b, ['buildTimeRu'], existing?.buildTimeRu || optionalString(b, ['buildTimeAz', 'buildTime'], '')),
    buildTimeEn: optionalString(b, ['buildTimeEn'], existing?.buildTimeEn || optionalString(b, ['buildTimeAz', 'buildTime'], '')),
    completionDate, coverImage, images, sortOrder, featured, archived, active
  } };
}
function projectIn(b = {}, existing = null) {
  const categoryCheck = validateCategory(firstPresent(b, ['category', 'cat'], existing?.category || 'house'));
  if (categoryCheck.errors) return { errors: categoryCheck.errors };
  const c = categoryCheck.category;
  const images = imageArrayField(b, existing);
  const limited = limitImageArray(images);
  if (limited.errors) return { errors: limited.errors };
  let coverImage = optionalString(b, ['coverImage', 'image'], existing?.coverImage || images[0] || '');
  if (!coverImage && images.length) coverImage = images[0];
  const titleAz = optionalString(b, ['titleAz', 'title'], existing?.titleAz || '');
  const stories = intField(b, 'stories', existing?.stories ?? 1);
  const rooms = intField(b, 'rooms', existing?.rooms ?? 1);
  const errors = [];
  if (!titleAz) errors.push('titleAz is required');
  if (Number.isNaN(stories)) errors.push('stories must be an integer or empty');
  if (Number.isNaN(rooms)) errors.push('rooms must be an integer or empty');
  if (errors.length) return { errors };
  return {
    category: c, categoryNameAz: catMap[c]?.az, categoryNameRu: catMap[c]?.ru, categoryNameEn: catMap[c]?.en,
    titleAz, titleRu: optionalString(b, ['titleRu'], existing?.titleRu || titleAz) || titleAz,
    titleEn: optionalString(b, ['titleEn'], existing?.titleEn || titleAz) || titleAz,
    descriptionAz: optionalString(b, ['descAz', 'desc', 'descriptionAz', 'description'], existing?.descriptionAz || ''),
    descriptionRu: optionalString(b, ['descRu', 'descriptionRu'], existing?.descriptionRu || optionalString(b, ['descAz', 'desc', 'descriptionAz', 'description'], '')),
    descriptionEn: optionalString(b, ['descEn', 'descriptionEn'], existing?.descriptionEn || optionalString(b, ['descAz', 'desc', 'descriptionAz', 'description'], '')),
    area: optionalString(b, ['area'], existing?.area || ''), stories: stories ?? 1, rooms: rooms ?? 1,
    buildTimeAz: optionalString(b, ['buildTimeAz', 'buildTime'], existing?.buildTimeAz || ''),
    buildTimeRu: optionalString(b, ['buildTimeRu'], existing?.buildTimeRu || optionalString(b, ['buildTimeAz', 'buildTime'], '')),
    buildTimeEn: optionalString(b, ['buildTimeEn'], existing?.buildTimeEn || optionalString(b, ['buildTimeAz', 'buildTime'], '')),
    coverImage, images, archived: boolField(b, 'archived', existing?.archived ?? false),
    ...(existing?.slug ? {} : { slug: b.slug })
  };
}
const localWorkUploadPath = (url = '') => {
  const value = String(url || '');
  if (!value.startsWith('/uploads/works/')) return null;
  const base = path.basename(value);
  if (base !== value.split('/').pop() || base.includes('..')) return null;
  const resolved = path.resolve(uploadBucketFolders.works, base);
  return resolved.startsWith(path.resolve(uploadBucketFolders.works) + path.sep) ? resolved : null;
};
async function safeDeleteUnusedWorkFiles(urls = [], excludingId = null) {
  for (const url of new Set(urls.filter(Boolean))) {
    if (/^https?:\/\//i.test(url)) continue;
    const filePath = localWorkUploadPath(url);
    if (!filePath) continue;
    const users = await prisma.workItem.findMany({ select:{id:true}, where:{ id: excludingId ? { not: excludingId } : undefined, OR:[{coverImage:url},{images:{ array_contains: [url] }}] } }).catch(()=>[]);
    if (!users.length) await fs.promises.unlink(filePath).catch(()=>{});
  }
}

const settingOut = (s) => ({ id:s.id, key:s.key, value:s.value || {}, createdAt:s.createdAt, updatedAt:s.updatedAt });

const catMap = CATEGORY_LABELS;

const IMAGE_VARIANT_WIDTHS = { thumb: 480, medium: 960, large: 1600 };
const IMAGE_VARIANT_QUALITY = { thumb: 74, medium: 78, large: 82 };
const imageVariantUrl = (url = '', variant = 'medium') => {
  const value = String(url || '');
  if (!value.startsWith('/uploads/') || !/\.(jpe?g|png|webp|avif|tiff?|bmp)(?:[?#].*)?$/i.test(value)) return value;
  const clean = value.split(/[?#]/)[0];
  const ext = path.extname(clean);
  return `${clean.slice(0, -ext.length)}-${variant}.webp`;
};
const imageVariantsFor = (url = '') => {
  const original = String(url || '');
  return original ? { original, thumb: imageVariantUrl(original, 'thumb'), medium: imageVariantUrl(original, 'medium'), large: imageVariantUrl(original, 'large') } : null;
};
const withImageVariants = (url = '') => imageVariantsFor(url) || null;
const listImage = (url = '', variant = 'medium') => imageVariantUrl(url, variant) || url;
async function createImageVariants(sourcePath, publicUrl) {
  const variants = imageVariantsFor(publicUrl);
  if (!variants || !isBrowserImage(publicUrl)) return null;
  await Promise.all(Object.entries(IMAGE_VARIANT_WIDTHS).map(async ([name, width]) => {
    const outPath = path.join(path.dirname(sourcePath), `${path.basename(sourcePath, path.extname(sourcePath))}-${name}.webp`);
    await sharp(sourcePath).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: IMAGE_VARIANT_QUALITY[name], effort: 4 }).toFile(outPath);
  }));
  return variants;
}

function projectOut(p, options = {}) {
  const list = !!options.list; const descAz = list ? excerptText(p.descriptionAz) : p.descriptionAz; const descRu = list ? excerptText(p.descriptionRu) : p.descriptionRu; const descEn = list ? excerptText(p.descriptionEn) : p.descriptionEn;
  const originalImages = jsonArray(p.images); const cover = p.coverImage || originalImages[0] || ''; const images = list ? [listImage(cover, 'medium')].filter(Boolean) : originalImages; return { id: p.id, legacyId: p.legacyId, slug:p.slug, type:'project', category: p.category, cat: p.category, categoryNameAz: p.categoryNameAz || catMap[p.category]?.az || p.category, categoryNameRu: p.categoryNameRu || catMap[p.category]?.ru || p.category, categoryNameEn: p.categoryNameEn || catMap[p.category]?.en || p.category, catName: p.categoryNameAz || catMap[p.category]?.az || p.category, catNameRu: p.categoryNameRu || catMap[p.category]?.ru || p.category, catNameEn: p.categoryNameEn || catMap[p.category]?.en || p.category, title: p.titleAz, titleAz: p.titleAz, titleRu: p.titleRu, titleEn: p.titleEn, shortDescription: descAz, shortDescriptionAz: descAz, shortDescriptionRu: descRu, shortDescriptionEn: descEn, description: descAz, desc: descAz, descriptionAz: descAz, descriptionRu: descRu, descriptionEn: descEn, descRu: descRu, descEn:descEn, area:p.area, stories:p.stories, rooms:p.rooms, buildTime:p.buildTimeAz, buildTimeAz:p.buildTimeAz, buildTimeRu:p.buildTimeRu, buildTimeEn:p.buildTimeEn, image:listImage(cover, list ? 'medium' : 'large'), coverImage:listImage(cover, list ? 'medium' : 'large'), originalImage:cover, imageVariants:withImageVariants(cover), images, views:p.views, archived:p.archived, createdAt:p.createdAt, updatedAt:p.updatedAt };
}
function galleryOut(g, options = {}) { const list = !!options.list; const originalImages = jsonArray(g.images); const primary = g.mediaUrl || originalImages[0] || ''; const src = g.type === 'image' ? listImage(primary, list ? 'medium' : 'large') : primary; return { id: g.id, src, mediaUrl: src, originalMediaUrl: primary, imageVariants: withImageVariants(primary), images: list && g.type === 'image' ? [src].filter(Boolean) : originalImages, title: g.titleAz, titleAz: g.titleAz, titleRu: g.titleRu, titleEn: g.titleEn, type: g.type, archived: g.archived, sortOrder: g.sortOrder, createdAt: g.createdAt, updatedAt: g.updatedAt }; }
function galleryIn(b) { const images = b.images || (b.src ? [b.src] : []); const limited = limitImageArray(images); if (limited.errors) return { errors: limited.errors }; return { mediaUrl: b.src || b.mediaUrl || '', images, titleAz: b.titleAz || b.title || '', titleRu: b.titleRu, titleEn: b.titleEn, type: b.type || 'image', sortOrder: Number(b.sortOrder) || 0 }; }
function getYouTubeId(url = '') { const value = String(url || '').trim(); const patterns = [/[?&]v=([^&]+)/i, /youtu\.be\/([^?&#/]+)/i, /youtube\.com\/embed\/([^?&#/]+)/i, /youtube\.com\/shorts\/([^?&#/]+)/i]; for (const pattern of patterns) { const match = value.match(pattern); if (match?.[1]) return decodeURIComponent(match[1]).replace(/[^a-zA-Z0-9_-]/g, ''); } return ''; }
function isYouTubeUrl(url = '') { return Boolean(getYouTubeId(url)); }
function isVideoUrl(url = '') { return isYouTubeUrl(url) || /\.(mp4|webm|mov)(?:[?#].*)?$/i.test(String(url)); }
function slideOut(s) { const mediaUrl = s.mediaUrl || s.image || ''; return { id: s.id, legacyId: s.legacyId, image: s.image || mediaUrl, mediaUrl, mediaType: s.mediaType || (isVideoUrl(mediaUrl) ? 'video' : 'image'), tag: s.tagAz, tagAz: s.tagAz, tagRu: s.tagRu, tagEn: s.tagEn, title: s.titleAz, titleAz: s.titleAz, titleRu: s.titleRu, titleEn: s.titleEn, subtitleAz: s.subtitleAz, subtitleRu: s.subtitleRu, subtitleEn: s.subtitleEn, buttonTextAz: s.buttonTextAz, buttonTextRu: s.buttonTextRu, buttonTextEn: s.buttonTextEn, buttonLink: s.buttonLink, title1: s.title1Az, title1Az: s.title1Az, title1Ru: s.title1Ru, title1En: s.title1En, title2: s.title2Az, title2Az: s.title2Az, title2Ru: s.title2Ru, title2En: s.title2En, desc: s.descAz, descAz: s.descAz, descRu: s.descRu, descEn: s.descEn, active: s.active, sortOrder: s.sortOrder }; }
function slideIn(b = {}, options = {}) { const mediaUrl = b.mediaUrl || b.media_url || b.image || b.src || b.url; const explicitType = b.mediaType || b.media_type || b.type; const mediaType = isVideoUrl(mediaUrl) ? 'video' : (explicitType || 'image'); const data = { tagAz: b.tagAz || b.tag, tagRu: b.tagRu, tagEn: b.tagEn, titleAz: b.titleAz || b.title, titleRu: b.titleRu, titleEn: b.titleEn, subtitleAz: b.subtitleAz, subtitleRu: b.subtitleRu, subtitleEn: b.subtitleEn, buttonTextAz: b.buttonTextAz, buttonTextRu: b.buttonTextRu, buttonTextEn: b.buttonTextEn, buttonLink: b.buttonLink, title1Az: b.title1Az || b.title1, title1Ru: b.title1Ru, title1En: b.title1En, title2Az: b.title2Az || b.title2, title2Ru: b.title2Ru, title2En: b.title2En, descAz: b.descAz || b.desc, descRu: b.descRu, descEn: b.descEn, active: b.active ?? true };
  if (mediaUrl) { data.mediaUrl = mediaUrl; data.image = b.image || mediaUrl; data.mediaType = mediaType; }
  if (options.includeSortOrder || Object.prototype.hasOwnProperty.call(b, 'sortOrder')) data.sortOrder = Number(b.sortOrder) || 0;
  return Object.fromEntries(Object.entries(data).filter(([,v]) => v !== undefined)); }
function homeSectionImageOut(i) { return { id: i.id, sectionKey: i.sectionKey, title: i.title, imageUrl: i.imageUrl, src: i.imageUrl, sortOrder: i.sortOrder, active: i.active, createdAt: i.createdAt, updatedAt: i.updatedAt }; }
function homeSectionImageIn(b = {}) { return { sectionKey: b.sectionKey || b.section_key, title: b.title || null, imageUrl: b.imageUrl || b.image_url || b.src, active: b.active ?? true }; }
function normalizePlacement(value) { return ['left', 'right', 'both'].includes(value) ? value : 'both'; }
function bannerOut(b) {
  return b && { id: b.id, legacyId: b.legacyId, active: b.active, type: b.type || b.mediaType || 'image', mediaType: b.mediaType || b.type || 'image', src: b.mediaUrl || '', mediaUrl: b.mediaUrl || '', link: b.linkUrl || '', linkUrl: b.linkUrl || '', title: b.title || b.titleAz || '', titleAz: b.titleAz || b.title || '', width: b.width, height: b.height, duration: b.duration, displayOrder: b.displayOrder || 0, views: b.views, clicks: b.clicks, placement: normalizePlacement(b.placement), position: normalizePlacement(b.placement), createdAt: b.createdAt };
}
function bannerIn(b = {}) {
  const mediaUrl = b.mediaUrl || b.media_url || b.src || '';
  const rawMediaType = b.mediaType || b.type || b.media_type || 'image';
  const mediaType = /\.(mp4|webm|mov)(?:[?#].*)?$/i.test(mediaUrl) ? 'video' : rawMediaType;
  const data = {
    active: b.active ?? true,
    mediaType,
    type: mediaType,
    mediaUrl,
    linkUrl: b.linkUrl || b.link_url || b.link || '',
    title: b.title || b.titleAz || '',
    titleAz: b.titleAz || b.title || '',
    width: Number(b.width) || 260,
    height: Number(b.height) || 600,
    duration: Number(b.duration) || 15,
    placement: normalizePlacement(b.placement || b.position)
  };
  if (Object.prototype.hasOwnProperty.call(b, 'displayOrder') || Object.prototype.hasOwnProperty.call(b, 'display_order')) data.displayOrder = Number(b.displayOrder ?? b.display_order) || 0;
  return data;
}

const slugify = (value = '') => String(value || '')
  .replace(/[Əə]/g, 'e').replace(/[Öö]/g, 'o').replace(/[Üü]/g, 'u').replace(/[Ğğ]/g, 'g').replace(/[Şş]/g, 's').replace(/[Çç]/g, 'c').replace(/[İIı]/g, 'i')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'detal';
const sanitizeSlug = (value = '') => slugify(value);
const slugId = (slug = '') => String(slug || '').split('-').pop();
const publicOrigin = () => (process.env.PUBLIC_SITE_URL || 'https://balticcaspian.com').replace(/\/+$/, '');
const absoluteUrl = (req, url = '') => /^https?:\/\//i.test(url) ? url : `${publicOrigin()}${String(url || '').startsWith('/') ? '' : '/'}${url || ''}`;
const escapeHtml = (value = '') => String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const isBrowserImage = (url='') => /\.(jpe?g|png|webp|avif|gif)(?:[?#].*)?$/i.test(String(url||''));
async function uniqueSlug(model, title, requested, existingId = null) {
  const base = sanitizeSlug(requested || title || existingId || 'detal');
  let candidate = base, n = 2;
  while (await prisma[model].findFirst({ where: { slug: candidate, ...(existingId ? { id: { not: existingId } } : {}) }, select: { id:true } })) candidate = `${base}-${n++}`;
  return candidate;
}
async function findProjectBySlug(slug) {
  const safe = sanitizeSlug(slug);
  const bySlug = await prisma.project.findFirst({ where: { slug: safe, archived:false } });
  if (bySlug) return bySlug;
  const id = slugId(slug);
  return prisma.project.findFirst({ where: { ...idWhere(id), archived:false } });
}
async function findWorkBySlug(slug) {
  const safe = sanitizeSlug(slug);
  const bySlug = await prisma.workItem.findFirst({ where: { slug: safe, active:true, archived:false } });
  if (bySlug) return bySlug;
  const id = slugId(slug);
  return isUuid(id) ? prisma.workItem.findFirst({ where:{ id, active:true, archived:false } }) : null;
}

const msgOut = (m) => ({ id: m.id, legacyId: m.legacyId, name: m.name || m.fullname || '', fullname: m.fullname || m.name || '', phone: m.phone, email: m.email || 'N/A', message: m.message, isRead: m.isRead ?? m.read ?? false, read: m.isRead ?? m.read ?? false, createdAt: m.createdAt, updatedAt: m.updatedAt, date: m.createdAt ? m.createdAt.toLocaleDateString('az-AZ') : '' });


app.get('/api/admin/session', (req, res) => {
  if (req.session?.adminAuthenticated === true) {
    return res.json({ ok: true, authenticated: true, username: req.session.adminUsername || process.env.ADMIN_USERNAME });
  }
  return res.json({ ok: true, authenticated: false });
});
app.post('/api/admin/login', validateAdminOrigin, loginLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!String(username || '').trim() || !String(password || '')) return invalidLogin(res);
  let passwordOk = false;
  try {
    passwordOk = await bcrypt.compare(String(password), process.env.ADMIN_PASSWORD_HASH);
  } catch (error) {
    console.error('[admin-login:bcrypt:error]', { message: error?.message });
    return invalidLogin(res);
  }
  if (String(username).trim() !== process.env.ADMIN_USERNAME || !passwordOk) return invalidLogin(res);
  req.session.regenerate((error) => {
    if (error) {
      console.error('[admin-login:session:error]', { message: error?.message });
      return res.status(500).json({ ok: false, error: 'Session yaradıla bilmədi' });
    }
    req.session.adminAuthenticated = true;
    req.session.adminUsername = process.env.ADMIN_USERNAME;
    return req.session.save((saveError) => {
      if (saveError) {
        console.error('[admin-login:save:error]', { message: saveError?.message });
        return res.status(500).json({ ok: false, error: 'Session saxlanıla bilmədi' });
      }
      return res.json({ ok: true, authenticated: true });
    });
  });
}));
app.post('/api/admin/logout', validateAdminOrigin, (req, res) => {
  req.session.destroy((error) => {
    res.clearCookie(adminSessionCookieName, { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' });
    if (error) {
      console.error('[admin-logout:error]', { message: error?.message });
      return res.status(500).json({ ok: false, error: 'Çıxış tamamlanmadı' });
    }
    return res.json({ ok: true });
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'baltic-caspian-api' }));
app.get('/api/health/db', async (req, res) => {
  try {
    await prisma.$queryRaw`select 1`;
    res.json({ ok: true, db: true });
  } catch (err) {
    console.error('[health:db]', { name: err?.name, code: err?.code, message: err?.message });
    res.status(503).json({ ok: false, db: false, error: err?.message || 'Database connection failed' });
  }
});


const projectListSelect = { id:true, legacyId:true, slug:true, category:true, categoryNameAz:true, categoryNameRu:true, categoryNameEn:true, titleAz:true, titleRu:true, titleEn:true, descriptionAz:true, descriptionRu:true, descriptionEn:true, area:true, stories:true, rooms:true, buildTimeAz:true, buildTimeRu:true, buildTimeEn:true, coverImage:true, images:true, views:true, archived:true, createdAt:true, updatedAt:true };
const workListSelect = { id:true, slug:true, category:true, titleAz:true, titleRu:true, titleEn:true, descriptionAz:true, descriptionRu:true, descriptionEn:true, locationAz:true, locationRu:true, locationEn:true, area:true, stories:true, rooms:true, buildTimeAz:true, buildTimeRu:true, buildTimeEn:true, completionDate:true, coverImage:true, images:true, sortOrder:true, archived:true, featured:true, active:true, createdAt:true, updatedAt:true };
const galleryListSelect = { id:true, mediaUrl:true, images:true, titleAz:true, titleRu:true, titleEn:true, type:true, archived:true, sortOrder:true, createdAt:true, updatedAt:true };
app.get('/api/projects', wrap(async (req,res)=>{
  if (req.query.includeArchived === 'true' && req.session?.adminAuthenticated !== true) return res.status(401).json({ ok:false, error:'Admin girişi tələb olunur' });
  const includeArchived = req.query.includeArchived === 'true';
  const key = cacheKey(['projects:list', includeArchived ? 'admin' : 'public']);
  const startedAt = performance.now(); let dbMs = 0, normalizeMs = 0, jsonMs = 0, count = 0;
  const result = includeArchived ? { data: await (async () => { const dbStarted = performance.now(); const rows = await prisma.project.findMany({ select: projectListSelect, where:{}, orderBy:{ createdAt:'desc' }}); dbMs = performance.now() - dbStarted; const normalizeStarted = performance.now(); const data = rows.map(p => projectOut(p, { list:true })); normalizeMs = performance.now() - normalizeStarted; return data; })(), cache:'bypass' } : await getOrSetCache(key, CACHE_TTL.projectsList, async () => { const dbStarted = performance.now(); const rows = await prisma.project.findMany({ select: projectListSelect, where:{ archived:false }, orderBy:{ createdAt:'desc' }}); dbMs = performance.now() - dbStarted; const normalizeStarted = performance.now(); const data = rows.map(p => projectOut(p, { list:true })); normalizeMs = performance.now() - normalizeStarted; return data; });
  count = result.data.length; res.set('Cache-Control','public, max-age=60, stale-while-revalidate=300'); res.set('X-BC-Cache', result.cache); const jsonStarted = performance.now(); res.json(result.data); jsonMs = performance.now() - jsonStarted; logSlowPerf('projects', { totalMs: performance.now() - startedAt, dbMs, normalizeMs, jsonMs, count, cache: result.cache });
}));
app.get('/api/projects/slug/:slug', wrap(async (req,res)=>{ const p=await findProjectBySlug(req.params.slug); if(!p) return res.status(404).json({ok:false,error:'PROJECT_NOT_FOUND'}); res.set('Cache-Control','public, max-age=60, stale-while-revalidate=300'); res.json(projectOut(p)); }));
app.get('/api/projects/:id', wrap(async (req,res)=>{ const p=await prisma.project.findFirst({ where:idWhere(req.params.id) }); if(!p) return res.status(404).json({ok:false,error:'PROJECT_NOT_FOUND'}); res.json(projectOut(p)); }));
app.post('/api/projects', requireAdminWrite, wrap(async (req,res)=>{ const data = projectIn(req.body); if (data.errors) return res.status(400).json({ok:false,errors:data.errors}); data.slug = await uniqueSlug('project', data.titleAz, data.slug); { const project = projectOut(await prisma.project.create({ data })); invalidateCache(['projects:list','project:']); res.status(201).json({ ok: true, project, ...project }); } }));
app.put('/api/projects/:id', requireAdminWrite, wrap(async (req,res)=>{ const p=await prisma.project.findFirst({ where:idWhere(req.params.id) }); if(!p) return res.status(404).json({ok:false,error:'PROJECT_NOT_FOUND'}); { const data = projectIn(req.body, p); if (data.errors) return res.status(400).json({ok:false,errors:data.errors}); { const project = projectOut(await prisma.project.update({ where:{ id:p.id }, data })); invalidateCache(['projects:list','project:']); res.json({ ok: true, project, ...project }); } }; }));
app.delete('/api/projects/:id', requireAdminWrite, wrap(async (req,res)=>{ const p=await prisma.project.findFirst({ where:idWhere(req.params.id) }); if (p) await prisma.project.delete({ where:{ id:p.id }}); invalidateCache(['projects:list','works:list','gallery:list']); res.json({ ok:true }); }));
app.patch('/api/projects/:id/archive', requireAdminWrite, wrap(async (req,res)=>{ const p=await prisma.project.findFirst({ where:idWhere(req.params.id) }); if(!p) return res.status(404).json({ok:false,error:'PROJECT_NOT_FOUND'}); { const project = projectOut(await prisma.project.update({ where:{ id:p.id }, data:{ archived: req.body.archived ?? !p.archived }})); invalidateCache(['projects:list','project:']); res.json({ ok: true, project, ...project }); } }));
app.post('/api/projects/:id/view', wrap(async (req,res)=>{
  const project = await prisma.project.findFirst({ where: idWhere(req.params.id) });
  if (!project) return res.json({ ok: false, skipped: true, reason: 'PROJECT_NOT_FOUND' });
  const updated = await prisma.project.update({ where: { id: project.id }, data: { views: { increment: 1 } } });
  if (isUuid(updated.id)) {
    try { await prisma.$executeRaw`insert into stat_events (type, entity_id, metadata) values ('project_view', ${updated.id}::uuid, '{}'::jsonb)`; } catch (err) { console.warn('[stats:event:skip]', err?.message); }
  }
  res.json(projectOut(updated));
}));


app.get(['/api/work-items', '/api/works'], wrap(async (req, res) => {
  const includeInactive = req.query.includeInactive === 'true' || req.query.includeArchived === 'true';
  if (includeInactive && req.session?.adminAuthenticated !== true) return res.status(401).json({ ok:false, error:'ADMIN_AUTH_REQUIRED' });
  const where = { ...(includeInactive ? {} : { active:true, archived:false }), ...(req.query.category ? { category:normalizeCategoryValue(req.query.category) } : {}), ...(req.query.featured === 'true' ? { featured:true } : {}) };
  const key = cacheKey(['works:list', JSON.stringify(where)]); const startedAt = performance.now(); let dbMs = 0, normalizeMs = 0, jsonMs = 0; const result = includeInactive ? { data: await (async()=>{ const dbStarted=performance.now(); const rows=await prisma.workItem.findMany({ select:workListSelect, where, orderBy:[{sortOrder:'asc'},{featured:'desc'},{createdAt:'desc'}] }); dbMs=performance.now()-dbStarted; const normalizeStarted=performance.now(); const data=rows.map(w=>workOut(w,{list:true})); normalizeMs=performance.now()-normalizeStarted; return data; })(), cache:'bypass' } : await getOrSetCache(key, CACHE_TTL.worksList, async()=>{ const dbStarted=performance.now(); const rows=await prisma.workItem.findMany({ select:workListSelect, where, orderBy:[{sortOrder:'asc'},{featured:'desc'},{createdAt:'desc'}] }); dbMs=performance.now()-dbStarted; const normalizeStarted=performance.now(); const data=rows.map(w=>workOut(w,{list:true})); normalizeMs=performance.now()-normalizeStarted; return data; }); res.set('Cache-Control','public, max-age=60, stale-while-revalidate=300'); res.set('X-BC-Cache', result.cache); const jsonStarted=performance.now(); res.json(result.data); jsonMs=performance.now()-jsonStarted; logSlowPerf('works', { totalMs:performance.now()-startedAt, dbMs, normalizeMs, jsonMs, count:result.data.length, cache:result.cache });
}));
app.get(['/api/work-items/slug/:slug','/api/works/slug/:slug'], wrap(async (req,res)=>{ const item=await findWorkBySlug(req.params.slug); if(!item) return res.status(404).json({ok:false,error:'WORK_ITEM_NOT_FOUND'}); res.set('Cache-Control','public, max-age=60, stale-while-revalidate=300'); res.json(workOut(item)); }));
app.get(['/api/work-items/:id', '/api/works/:id'], wrap(async (req, res) => { const item = await prisma.workItem.findUnique({ where:{ id:String(req.params.id) } }); if(!item) return res.status(404).json({ok:false,error:'WORK_ITEM_NOT_FOUND'}); if(!item.active && req.session?.adminAuthenticated !== true) return res.status(401).json({ok:false,error:'ADMIN_AUTH_REQUIRED'}); res.json(workOut(item)); }));
app.post(['/api/work-items', '/api/works'], requireAdminWrite, wrap(async (req,res)=>{
  const uploadCount = [req.body?.coverImage, ...(Array.isArray(req.body?.images) ? req.body.images : [])].filter(Boolean).length;
  console.info('[works:create:start]', { endpoint:req.originalUrl, recordType:'workItem', uploadCount, destinationDir:uploadBucketFolders.works });
  const v=validateWorkBody(req.body);
  if(v.errors) return res.status(400).json({ok:false,errors:v.errors,message:'İş məlumatları yadda saxlanılmadı.'});
  try {
    v.data.slug = await uniqueSlug('workItem', v.data.titleAz, v.data.slug);
    const created = await prisma.workItem.create({data:v.data});
    console.info('[works:create:success]', { id:created.id, slug:created.slug, active:created.active, uploadCount });
    invalidateCache(['works:list','work:']);
    res.status(201).json(workOut(created));
  } catch (err) {
    console.error('[works:create:error]', { endpoint:req.originalUrl, recordType:'workItem', uploadCount, destinationDir:uploadBucketFolders.works, code:err?.code, message:err?.message });
    res.status(isDbError(err) ? 503 : 500).json({ ok:false, error:'WORK_CREATE_FAILED', message:'İş məlumatları yadda saxlanılmadı.', code:err?.code });
  }
}));
app.put(['/api/work-items/reorder', '/api/works/reorder'], requireAdminWrite, wrap(async (req,res)=>{ await Promise.all((req.body.items||[]).map((it,i)=>prisma.workItem.update({where:{id:String(it.id)},data:{sortOrder:Number.isInteger(Number(it.sortOrder)) ? Number(it.sortOrder) : i}}))); invalidateCache(['works:list']); res.json({ok:true}); }));
app.put(['/api/work-items/:id', '/api/works/:id'], requireAdminWrite, wrap(async (req,res)=>{ const existing=await prisma.workItem.findUnique({where:{id:String(req.params.id)}}); if(!existing) return res.status(404).json({ok:false,error:'WORK_ITEM_NOT_FOUND'}); const v=validateWorkBody(req.body, existing); if(v.errors) return res.status(400).json({ok:false,errors:v.errors}); invalidateCache(['works:list','work:']); res.json(workOut(await prisma.workItem.update({where:{id:existing.id},data:v.data}))); }));
app.patch(['/api/work-items/:id/archive', '/api/works/:id/archive'], requireAdminWrite, wrap(async (req,res)=>{ const w=await prisma.workItem.findUnique({where:{id:String(req.params.id)}}); if(!w) return res.status(404).json({ok:false,error:'WORK_ITEM_NOT_FOUND'}); const archived = req.body.archived ?? !w.archived; invalidateCache(['works:list','work:']); res.json(workOut(await prisma.workItem.update({where:{id:w.id},data:{archived}}))); }));
app.patch(['/api/work-items/:id/status', '/api/works/:id/status'], requireAdminWrite, wrap(async (req,res)=>{ const w=await prisma.workItem.findUnique({where:{id:String(req.params.id)}}); if(!w) return res.status(404).json({ok:false,error:'WORK_ITEM_NOT_FOUND'}); invalidateCache(['works:list','work:']); res.json(workOut(await prisma.workItem.update({where:{id:w.id},data:{active:req.body.active ?? !w.active}}))); }));
app.patch(['/api/work-items/:id/featured', '/api/works/:id/featured'], requireAdminWrite, wrap(async (req,res)=>{ const w=await prisma.workItem.findUnique({where:{id:String(req.params.id)}}); if(!w) return res.status(404).json({ok:false,error:'WORK_ITEM_NOT_FOUND'}); invalidateCache(['works:list','work:']); res.json(workOut(await prisma.workItem.update({where:{id:w.id},data:{featured:req.body.featured ?? !w.featured}}))); }));
app.delete(['/api/work-items/:id', '/api/works/:id'], requireAdminWrite, wrap(async (req,res)=>{ const w=await prisma.workItem.findUnique({where:{id:String(req.params.id)}}); if(w){ await prisma.workItem.delete({where:{id:w.id}}); await safeDeleteUnusedWorkFiles([w.coverImage, ...jsonArray(w.images)], w.id); } invalidateCache(['works:list','work:']); res.json({ok:true}); }));

app.get('/api/gallery', wrap(async (req,res)=>{ if (req.query.includeArchived === 'true' && req.session?.adminAuthenticated !== true) return res.status(401).json({ ok:false, error:'Admin girişi tələb olunur' }); const includeArchived=req.query.includeArchived==='true'; const startedAt=performance.now(); let dbMs=0, normalizeMs=0, jsonMs=0; const result = includeArchived ? { data: await (async()=>{ const dbStarted=performance.now(); const rows=await prisma.galleryItem.findMany({ select:galleryListSelect, where:{}, orderBy:[{sortOrder:'asc'},{id:'desc'}] }); dbMs=performance.now()-dbStarted; const normalizeStarted=performance.now(); const data=rows.map(g=>galleryOut(g,{list:true})); normalizeMs=performance.now()-normalizeStarted; return data; })(), cache:'bypass' } : await getOrSetCache('gallery:list:public', CACHE_TTL.galleryList, async()=>{ const dbStarted=performance.now(); const rows=await prisma.galleryItem.findMany({ select:galleryListSelect, where:{archived:false}, orderBy:[{sortOrder:'asc'},{id:'desc'}] }); dbMs=performance.now()-dbStarted; const normalizeStarted=performance.now(); const data=rows.map(g=>galleryOut(g,{list:true})); normalizeMs=performance.now()-normalizeStarted; return data; }); res.set('Cache-Control','public, max-age=60, stale-while-revalidate=300'); res.set('X-BC-Cache', result.cache); const jsonStarted=performance.now(); res.json(result.data); jsonMs=performance.now()-jsonStarted; logSlowPerf('gallery', { totalMs:performance.now()-startedAt, dbMs, normalizeMs, jsonMs, count:result.data.length, cache:result.cache }); }));
app.post('/api/gallery', requireAdminWrite, wrap(async (req,res)=>{ const data = galleryIn(req.body); if (data.errors) return res.status(400).json({ok:false,errors:data.errors}); invalidateCache(['gallery:list']); res.status(201).json(galleryOut(await prisma.galleryItem.create({ data }))); }));
app.put('/api/gallery/reorder', requireAdminWrite, wrap(async (req,res)=>{ await Promise.all((req.body.items||[]).map((it,i)=>prisma.galleryItem.update({where:{id:Number(it.id)},data:{sortOrder:Number(it.sortOrder ?? i)}}))); invalidateCache(['gallery:list']); res.json({ok:true}); }));
app.put('/api/gallery/:id', requireAdminWrite, wrap(async (req,res)=>{ const data = galleryIn(req.body); if (data.errors) return res.status(400).json({ok:false,errors:data.errors}); invalidateCache(['gallery:list']); res.json(galleryOut(await prisma.galleryItem.update({ where:{id:intId(req)}, data}))); }));
app.delete('/api/gallery/:id', requireAdminWrite, wrap(async (req,res)=>{ await prisma.galleryItem.delete({where:{id:intId(req)}}); invalidateCache(['gallery:list']); res.json({ok:true}); }));
app.patch('/api/gallery/:id/archive', requireAdminWrite, wrap(async (req,res)=>{ const g=await prisma.galleryItem.findUniqueOrThrow({where:{id:intId(req)}}); invalidateCache(['gallery:list']); res.json(galleryOut(await prisma.galleryItem.update({where:{id:g.id},data:{archived:req.body.archived ?? !g.archived}}))); }));

app.get('/api/hero-slides', async (req, res) => {
  try {
    if (req.query.admin === 'true' && req.session?.adminAuthenticated !== true) return res.status(401).json({ ok:false, error:'Admin girişi tələb olunur' });
    const slides = await prisma.heroSlide.findMany({ select: heroSlideSelect, where: req.query.admin === 'true' ? {} : { active: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    res.json(slides.map(slideOut));
  } catch (err) {
    console.error('[hero-slides:get:error]', { name: err?.name, code: err?.code, message: err?.message, meta: err?.meta });
    res.status(isDbError(err) ? 503 : 500).json({ ok: false, error: 'HERO_SLIDES_GET_FAILED', message: err?.message || 'Hero slides could not be loaded', code: err?.code, field: err?.meta?.field_name || err?.meta?.column || err?.meta?.target });
  }
});
app.post('/api/hero-slides', requireAdminWrite, async (req, res) => {
  try {
    const body = req.body || {};
    const mediaUrl = body.mediaUrl || body.media_url || body.image || body.src || body.url;
    console.info('[hero-slides:post]', { bodyKeys: Object.keys(body), mediaUrlExists: Boolean(mediaUrl), imageExists: Boolean(body.image), media_type: body.media_type, mediaType: body.mediaType, type: body.type });
    if (!mediaUrl) return res.status(400).json({ ok: false, error: 'MEDIA_REQUIRED', message: 'Hero slayd üçün şəkil və ya video mütləqdir.' });
    const last = await prisma.heroSlide.findFirst({ select: { sortOrder: true }, orderBy: { sortOrder: 'desc' } });
    const mediaType = isVideoUrl(mediaUrl) ? 'video' : (body.mediaType || body.media_type || body.type || 'image');
    const data = slideIn({ ...body, mediaUrl, image: body.image || mediaUrl, mediaType, sortOrder: (last?.sortOrder ?? -1) + 1 }, { includeSortOrder: true });
    console.info('[hero-slides:post:data]', { keys: Object.keys(data) });
    res.status(201).json(slideOut(await prisma.heroSlide.create({ select: heroSlideSelect, data })));
  } catch (err) {
    console.error('[hero-slides:post:error]', { name: err?.name, code: err?.code, message: err?.message, meta: err?.meta });
    res.status(500).json({ ok: false, error: 'HERO_SLIDE_CREATE_FAILED', message: err?.message || 'Hero slide create failed', code: err?.code, field: err?.meta?.field_name || err?.meta?.column || err?.meta?.target });
  }
});
app.put('/api/hero-slides/reorder', requireAdminWrite, wrap(async (req,res)=>{ const ids=req.body.ids || (req.body.items||[]).map(it=>it.id); const validIds=(ids||[]).map(String).filter(isUuid); if (validIds.length !== (ids||[]).length) return invalidHeroId(res); await Promise.all(validIds.map((id,i)=>prisma.heroSlide.update({where:{id},data:{sortOrder:i}}))); res.json((await prisma.heroSlide.findMany({select:heroSlideSelect,orderBy:[{sortOrder:'asc'},{id:'asc'}]})).map(slideOut)); }));
app.put('/api/hero-slides/:id', requireAdminWrite, async (req, res) => {
  try {
    const where = heroIdWhere(req.params.id);
    if (!where) return invalidHeroId(res);
    const existing = await prisma.heroSlide.findUnique({ select: heroSlideSelect, where });
    if (!existing) return res.status(404).json({ ok: false, error: 'HERO_SLIDE_NOT_FOUND' });
    const data = slideIn(req.body || {});
    if (!data.mediaUrl && !data.image) { data.mediaUrl = existing.mediaUrl || existing.image; data.image = existing.image || existing.mediaUrl; }
    if (!data.mediaUrl) return res.status(400).json({ ok: false, error: 'MEDIA_REQUIRED', message: 'Hero slayd üçün şəkil və ya video mütləqdir.' });
    if (!data.image) data.image = data.mediaUrl;
    res.json(slideOut(await prisma.heroSlide.update({ select: heroSlideSelect, where: { id: existing.id }, data })));
  } catch (err) {
    console.error('[hero-slides:put:error]', { name: err?.name, code: err?.code, message: err?.message, meta: err?.meta });
    res.status(500).json({ ok: false, error: 'HERO_SLIDE_UPDATE_FAILED', message: err?.message || 'Hero slide update failed', code: err?.code, field: err?.meta?.field_name || err?.meta?.column || err?.meta?.target });
  }
});
app.delete('/api/hero-slides/:id', requireAdminWrite, wrap(async (req,res)=>{ const where=heroIdWhere(req.params.id); if(!where) return invalidHeroId(res); await prisma.heroSlide.delete({where}); res.json({ok:true});}));
app.patch('/api/hero-slides/:id/toggle', requireAdminWrite, wrap(async (req,res)=>{ const where=heroIdWhere(req.params.id); if(!where) return invalidHeroId(res); const s=await prisma.heroSlide.findUniqueOrThrow({select:{id:true,active:true},where}); res.json(slideOut(await prisma.heroSlide.update({select:heroSlideSelect,where:{id:s.id},data:{active:req.body.active ?? !s.active}}))); }));

app.get('/api/admin-panel-settings/:key', requireAdmin, wrap(async (req,res)=>{ const setting=await prisma.adminPanelSetting.findUnique({where:{key:req.params.key}}); if(setting) return res.json(settingOut(setting)); if(req.params.key==='admin_tab_visibility') return res.json({key:req.params.key,value:adminTabDefaultVisibility}); res.status(404).json({ok:false,error:'SETTING_NOT_FOUND',message:'Admin panel setting not found'}); }));
app.put('/api/admin-panel-settings/:key', requireAdminWrite, wrap(async (req,res)=>{ const value=req.body.value && typeof req.body.value==='object' ? req.body.value : req.body; res.json(settingOut(await prisma.adminPanelSetting.upsert({where:{key:req.params.key},create:{key:req.params.key,value},update:{value}}))); }));


app.get('/api/home-section-images', wrap(async (req,res)=>res.json((await prisma.homeSectionImage.findMany({ orderBy:[{sectionKey:'asc'},{sortOrder:'asc'}] })).map(homeSectionImageOut))));
app.get('/api/home-section-images/:sectionKey', wrap(async (req,res)=>res.json((await prisma.homeSectionImage.findMany({ where:{sectionKey:req.params.sectionKey, active:true}, orderBy:[{sortOrder:'asc'},{id:'asc'}] })).map(homeSectionImageOut))));
app.post('/api/home-section-images', requireAdminWrite, wrap(async (req,res)=>{ const data=homeSectionImageIn(req.body); if(!data.sectionKey) return res.status(400).json({ok:false,error:'SECTION_REQUIRED'}); if(!data.imageUrl) return res.status(400).json({ok:false,error:'IMAGE_REQUIRED'}); const last=await prisma.homeSectionImage.findFirst({where:{sectionKey:data.sectionKey},orderBy:{sortOrder:'desc'}}); res.status(201).json(homeSectionImageOut(await prisma.homeSectionImage.create({data:{...data,sortOrder:(last?.sortOrder ?? -1)+1}}))); }));
app.put('/api/home-section-images/reorder', requireAdminWrite, wrap(async (req,res)=>{ const ids=req.body.ids||[]; const sectionKey=req.body.sectionKey||req.body.section_key; await Promise.all(ids.map((id,i)=>prisma.homeSectionImage.update({where:{id:String(id)},data:{sortOrder:i, ...(sectionKey ? {sectionKey} : {})}}))); res.json((await prisma.homeSectionImage.findMany({where:sectionKey?{sectionKey}:{},orderBy:[{sortOrder:'asc'},{id:'asc'}]})).map(homeSectionImageOut)); }));
app.put('/api/home-section-images/:id', requireAdminWrite, wrap(async (req,res)=>{ const data=homeSectionImageIn(req.body); if(!data.imageUrl) delete data.imageUrl; res.json(homeSectionImageOut(await prisma.homeSectionImage.update({where:{id:String(req.params.id)},data}))); }));
app.delete('/api/home-section-images/:id', requireAdminWrite, wrap(async (req,res)=>{await prisma.homeSectionImage.delete({where:{id:String(req.params.id)}});res.json({ok:true});}));
app.patch('/api/home-section-images/:id/toggle', requireAdminWrite, wrap(async (req,res)=>{ const item=await prisma.homeSectionImage.findUniqueOrThrow({where:{id:String(req.params.id)}}); res.json(homeSectionImageOut(await prisma.homeSectionImage.update({where:{id:item.id},data:{active:req.body.active ?? !item.active}}))); }));

app.get('/api/banners', wrap(async (req,res)=>res.json((await prisma.banner.findMany({ where:req.query.public==='true'?{active:true}:{}, orderBy:[{displayOrder:'asc'},{createdAt:'asc'}]})).map(bannerOut))));
app.get('/api/banners/main', wrap(async (req,res)=>res.json(bannerOut(await prisma.banner.findFirst({where:{active:true},orderBy:[{displayOrder:'asc'},{createdAt:'asc'}]})) || null)));
app.post('/api/banners', requireAdminWrite, wrap(async (req,res)=>{ const last=await prisma.banner.findFirst({orderBy:{displayOrder:'desc'}}); res.status(201).json(bannerOut(await prisma.banner.create({data:{...bannerIn(req.body),displayOrder:(last?.displayOrder ?? -1)+1}}))); }));
app.put('/api/banners/reorder', requireAdminWrite, wrap(async (req,res)=>{ const ids=req.body.ids || []; await Promise.all(ids.map((id,i)=>prisma.banner.update({where:{id:String(id)},data:{displayOrder:i}}))); res.json((await prisma.banner.findMany({orderBy:[{displayOrder:'asc'},{createdAt:'asc'}]})).map(bannerOut)); }));
app.put('/api/banners/:id', requireAdminWrite, wrap(async (req,res)=>{ const b=await prisma.banner.findFirst({where:idWhere(req.params.id)}); if(!b) return res.status(404).json({ok:false,error:'BANNER_NOT_FOUND'}); const data=bannerIn(req.body); if (!Object.prototype.hasOwnProperty.call(req.body, 'displayOrder') && !Object.prototype.hasOwnProperty.call(req.body, 'display_order')) delete data.displayOrder; res.json(bannerOut(await prisma.banner.update({where:{id:b.id},data}))); }));
app.delete('/api/banners/:id', requireAdminWrite, wrap(async (req,res)=>{ const b=await prisma.banner.findFirst({where:idWhere(req.params.id)}); if (b) await prisma.banner.delete({where:{id:b.id}}); res.json({ok:true});}));
app.patch('/api/banners/:id/toggle', requireAdminWrite, wrap(async (req,res)=>{const b=await prisma.banner.findFirst({where:idWhere(req.params.id)}); if(!b) return res.status(404).json({ok:false,error:'BANNER_NOT_FOUND'}); res.json(bannerOut(await prisma.banner.update({where:{id:b.id},data:{active:req.body.active ?? !b.active}})));}));
app.post('/api/banners/:id/view', wrap(async (req,res)=>{ const b=await prisma.banner.findFirst({where:idWhere(req.params.id)}); if(!b) return res.json({ok:false,skipped:true,reason:'BANNER_NOT_FOUND'}); res.json(bannerOut(await prisma.banner.update({where:{id:b.id},data:{views:{increment:1}}}))); }));
app.post('/api/banners/:id/click', wrap(async (req,res)=>{ const b=await prisma.banner.findFirst({where:idWhere(req.params.id)}); if(!b) return res.json({ok:false,skipped:true,reason:'BANNER_NOT_FOUND'}); res.json(bannerOut(await prisma.banner.update({where:{id:b.id},data:{clicks:{increment:1}}}))); }));

app.get('/api/messages', requireAdmin, wrap(async (req,res)=>res.json((await prisma.contactMessage.findMany({ select:{ id:true, legacyId:true, name:true, fullname:true, phone:true, email:true, message:true, isRead:true, createdAt:true, updatedAt:true }, orderBy:{createdAt:'desc'} })).map(msgOut))));
app.post('/api/messages', wrap(async (req,res)=>{ const name=req.body.name || req.body.fullname || null; const fullname=req.body.fullname || req.body.name || null; res.status(201).json(msgOut(await prisma.contactMessage.create({data:{name,fullname,phone:req.body.phone,email:req.body.email,message:req.body.message}}))); }));
app.patch('/api/messages/:id/read', requireAdminWrite, wrap(async (req,res)=>res.json(msgOut(await prisma.contactMessage.update({where:{id:intId(req)},data:{isRead:true}})))));
app.delete('/api/messages/:id', requireAdminWrite, wrap(async (req,res)=>{await prisma.contactMessage.delete({where:{id:intId(req)}});res.json({ok:true});}));

app.get('/api/stats', requireAdmin, wrap(async (req,res)=>{ const rows=await prisma.siteStat.findMany(); res.json(Object.fromEntries(rows.map(r=>[r.key,r.value]))); }));
app.put('/api/stats/:key', requireAdminWrite, wrap(async (req,res)=>res.json(await prisma.siteStat.upsert({where:{key:req.params.key},create:{key:req.params.key,value:Number(req.body.value)||0},update:{value:Number(req.body.value)||0}}))));
app.post('/api/stats/event', wrap(async (req,res)=>res.status(201).json(await prisma.statEvent.create({data:{type:req.body.type,targetId:req.body.targetId,metadata:req.body.metadata||{}}}))));
app.get('/api/health/storage', (req, res) => res.json({ ok: true, localStorage: true, uploadRoot: '/uploads', allowedBuckets: allowedUploadBuckets }));

app.post('/api/uploads', requireAdminWrite, upload.single('file'), wrap(async (req, res) => {
  const bucket = req.body.bucket;
  console.info('[uploads:start]', { bucket, fileExists: Boolean(req.file), mimetype: req.file?.mimetype });
  if (!allowedUploadBuckets.includes(bucket)) {
    return res.status(400).json({ ok: false, error: 'INVALID_BUCKET', buckets: allowedUploadBuckets });
  }
  if (!req.file) return res.status(400).json({ ok: false, error: 'FILE_REQUIRED' });
  if (!isAllowedUploadFile(req.file, bucket)) return res.status(400).json({ ok: false, error: 'UNSUPPORTED_FILE_TYPE', message: 'Uploads support jpg, jpeg, png, webp, avif, gif, bmp, tif, tiff, heic, heif, mp4, webm, and mov. SVG uploads are rejected until sanitization is available.' });

  const bucketFolder = await ensureUploadBucketFolder(bucket);
  const filename = `${Date.now()}-${crypto.randomUUID()}-${safeUploadFilename(req.file.originalname)}`;
  const objectPath = path.join(bucket, filename);
  const filePath = path.join(bucketFolder, filename);
  await fs.promises.writeFile(filePath, req.file.buffer, { flag: 'wx' });
  const publicUrl = `/uploads/${bucket}/${filename}`;
  const variants = await createImageVariants(filePath, publicUrl).catch(error => { console.warn('[uploads:variants]', { message: error?.message, bucket }); return null; });
  res.status(201).json({ ok: true, bucket, path: objectPath, publicUrl, variants });
}));

app.post('/api/uploads/sign', requireAdminWrite, (req,res)=>{
  const bucket = req.body.bucket;
  if (!allowedUploadBuckets.includes(bucket)) return res.status(400).json({ error: 'Invalid bucket', buckets: allowedUploadBuckets });
  const filename = `${Date.now()}-${crypto.randomUUID()}-${safeUploadFilename(req.body.filename || 'upload')}`;
  const objectPath = path.join(bucket, filename);
  const publicUrl = `/uploads/${bucket}/${filename}`;
  res.json({ bucket, path: objectPath, publicUrl, uploadUrl: null, todo: 'Use POST /api/uploads for multipart uploads' });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API route not found' }));
app.use((err, req, res, next) => {
  console.error('[express:error]', { name: err?.name, code: err?.code, message: err?.message });
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      ok: false,
      error: 'FILE_TOO_LARGE',
      message: 'Fayl çox böyükdür. Maksimum 150MB yükləyə bilərsiniz.'
    });
  }
  if (isDbError(err)) return dbUnavailable(res, err);
  if (err?.message === 'Yalnız dəstəklənən şəkil formatlarını seçin.') {
    return res.status(400).json({ ok: false, error: 'UNSUPPORTED_FILE_TYPE', message: 'Bu şəkil formatı dəstəklənmir.' });
  }
  res.status(err.code === 'P2025' ? 404 : 500).json({ ok: false, error: err.message || 'Server error' });
});


const buildJsonLd = (view, isProject, url, image) => JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebPage', name: view?.titleAz || 'Baltic Caspian LTD', description: view?.descriptionAz || view?.desc || '', url, image: image ? [image] : undefined },
    { '@type': 'CreativeWork', name: view?.titleAz || 'Baltic Caspian LTD', description: view?.descriptionAz || view?.desc || '', url, image: image ? [image] : undefined },
    { '@type': 'BreadcrumbList', itemListElement: [
      { '@type':'ListItem', position:1, name:'Ana səhifə', item: publicOrigin() + '/' },
      { '@type':'ListItem', position:2, name:isProject ? 'Layihələr' : 'İşlərimiz', item: publicOrigin() + (isProject ? '/layiheler' : '/islerimiz') },
      { '@type':'ListItem', position:3, name:view?.titleAz || 'Detal', item:url }
    ] }
  ]
}).replace(/</g, '\\u003c');
const injectMeta = (html, meta) => html.replaceAll('__META_TITLE__', escapeHtml(meta.title))
  .replaceAll('__META_DESCRIPTION__', escapeHtml(meta.description))
  .replaceAll('__META_URL__', escapeHtml(meta.url))
  .replaceAll('__META_IMAGE__', escapeHtml(meta.image))
  .replaceAll('__JSON_LD__', meta.jsonLd || '{}');

app.use('/uploads', express.static(path.join(__dirname, 'uploads'), { index:false, maxAge:'30d', etag:true, lastModified:true, setHeaders: (res) => res.setHeader('Cache-Control','public, max-age=2592000') }));
app.use(express.static(__dirname, { index: false, maxAge:'7d', etag:true, lastModified:true, setHeaders: (res, filePath) => { if (/\.(css|js|png|webp|avif|jpe?g|svg|ico)$/i.test(filePath)) res.setHeader('Cache-Control','public, max-age=604800'); } }));
app.get(['/projects/:id', '/works/:id'], wrap(async (req, res, next) => {
  const isProject = req.path.startsWith('/projects/');
  const item = isProject ? await prisma.project.findFirst({ where: { ...idWhere(req.params.id), archived:false } }) : (isUuid(req.params.id) ? await prisma.workItem.findFirst({ where:{ id:req.params.id, active:true } }) : null);
  if (!item?.slug) return next();
  res.redirect(301, `${isProject ? '/layiheler' : '/islerimiz'}/${item.slug}`);
}));
app.get(['/layiheler/:slug', '/islerimiz/:slug'], wrap(async (req, res) => {
  const isProject = req.path.startsWith('/layiheler/');
  let item = null;
  try { item = isProject ? await findProjectBySlug(req.params.slug) : await findWorkBySlug(req.params.slug); } catch (err) { console.warn('[detail:ssr:fallback]', err?.message); }
  const html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
  if (!item) return res.status(404).send(injectMeta(html, { title: `${isProject ? 'Layihə' : 'İş'} tapılmadı | Baltic Caspian LTD`, description: 'Axtardığınız səhifə tapılmadı.', url: absoluteUrl(req, req.originalUrl), image: absoluteUrl(req, '/uploads/hero'), jsonLd: '{}' }));
  const view = isProject ? projectOut(item) : workOut(item);
  if (view.slug && req.params.slug !== view.slug) return res.redirect(301, `${isProject ? '/layiheler' : '/islerimiz'}/${view.slug}`);
  const title = `${view.titleAz || view.title || 'Detal'} | Baltic Caspian LTD`;
  const description = String(view.descriptionAz || view.desc || view.description || 'Baltic Caspian LTD layihə detalları.').replace(/\s+/g,' ').slice(0, 155);
  const firstImage = [view.coverImage, view.image, ...(Array.isArray(view.images) ? view.images : [])].find(isBrowserImage) || view.coverImage || view.image || '';
  const image = absoluteUrl(req, firstImage || '/uploads/hero');
  const url = `${publicOrigin()}${isProject ? '/layiheler' : '/islerimiz'}/${view.slug}`;
  res.set('Cache-Control','public, max-age=60, stale-while-revalidate=300');
  res.send(injectMeta(html, { title, description, url, image, jsonLd: buildJsonLd(view, isProject, url, image) }));
}));
app.get('/sitemap.xml', wrap(async (req,res)=>{
  const [projects, works] = await Promise.all([prisma.project.findMany({where:{archived:false},select:{slug:true,updatedAt:true}}), prisma.workItem.findMany({where:{active:true},select:{slug:true,updatedAt:true}})]);
  const urls = ['/', '/layiheler', '/islerimiz', '/qalereya', '/haqqimizda', '/elaqe', ...projects.map(p=>`/layiheler/${p.slug}`), ...works.map(w=>`/islerimiz/${w.slug}`)];
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(u=>`<url><loc>${escapeHtml(publicOrigin()+u)}</loc></url>`).join('')}</urlset>`);
}));
const SITE_TITLE = 'Baltic Caspian LTD';
const formatPageTitle = (label = '') => label ? `${label} | ${SITE_TITLE}` : SITE_TITLE;
const PAGE_META = {
  '/': { label: '', description: 'Premium taxta evlərin layihələndirilməsi və tikintisi.' },
  '/layiheler': { label: 'Layihələr', description: 'Baltic Caspian LTD taxta ev layihələri və fərdi memarlıq həlləri.' },
  '/islerimiz': { label: 'İşlərimiz', description: 'Baltic Caspian LTD tərəfindən tamamlanmış taxta ev işləri.' },
  '/qalereya': { label: 'Qalereya', description: 'Taxta evlər, tikinti prosesi və tamamlanmış layihələrin qalereyası.' },
  '/haqqimizda': { label: 'Haqqımızda', description: 'Baltic Caspian LTD komandası, dəyərləri və taxta ev tikintisi təcrübəsi.' },
  '/elaqe': { label: 'Əlaqə', description: 'Baltic Caspian LTD ilə əlaqə saxlayın və taxta ev layihənizi planlayın.' },
  '/admin': { label: 'İdarəetmə Paneli', description: 'Baltic Caspian LTD idarəetmə panelinə giriş.' }
};
const pageMetaForPath = pathValue => {
  const config = PAGE_META[pathValue] || { label: 'Səhifə tapılmadı', description: 'Axtardığınız səhifə tapılmadı.' };
  return { title: formatPageTitle(config.label), description: config.description };
};
const STATIC_PUBLIC_META = Object.fromEntries(Object.entries(PAGE_META).map(([route]) => [route, pageMetaForPath(route)]));
const normalizePublicPath = value => {
  let clean = String(value || '/').split('?')[0].split('#')[0].replace(/\/+/g, '/');
  clean = clean.replace(/\/+$/, '') || '/';
  return clean;
};
const ADMIN_ASSET_VERSION = '20260718-1';
const sendShellWithMeta = (req, res, meta, status = 200) => {
  if (normalizePublicPath(req.path) === '/admin') setAdminNoStore(res);
  fs.promises.readFile(path.join(__dirname,'index.html'), 'utf8')
    .then(html => res.status(status).send(injectMeta(html.replace('</head>', `<!-- admin-asset-version:${ADMIN_ASSET_VERSION} --></head>`), { title: meta.title, description: meta.description, url: `${publicOrigin()}${normalizePublicPath(req.path)}`, image:absoluteUrl(req, '/uploads/hero'), jsonLd:'{}' })))
    .catch(() => res.status(status).sendFile(path.join(__dirname,'index.html')));
};
app.get(Object.keys(STATIC_PUBLIC_META), (req,res)=>{
  const clean = normalizePublicPath(req.path);
  sendShellWithMeta(req, res, STATIC_PUBLIC_META[clean] || STATIC_PUBLIC_META['/']);
});
app.get('*', (req,res)=>{
  sendShellWithMeta(req, res, pageMetaForPath('__404__'), 404);
});

const PORT = process.env.PORT || 3000;
console.log(`DATABASE_URL exists: ${process.env.DATABASE_URL ? 'yes' : 'no'}`);
console.log(`NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
console.log(`Server port: ${PORT}`);
app.listen(PORT, () => console.log(`Baltic Caspian LTD API running on ${PORT}`));
