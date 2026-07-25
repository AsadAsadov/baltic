const path = require('path');

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|avif|tiff?|bmp)(?:[?#].*)?$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov)(?:[?#].*)?$/i;
const AUDIO_EXT_RE = /\.(mp3|wav|m4a|aac|ogg)(?:[?#].*)?$/i;

function isYouTubeUrl(value = '') {
  return /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)/i.test(String(value || ''));
}

function normalizeMediaUrl(url = '') {
  let value = String(url || '').trim().replace(/\\/g, '/');
  if (!value) return '';
  if (/^(data:|blob:)/i.test(value) || isYouTubeUrl(value)) return value;
  value = value.replace(/\/uploads(?:\/uploads)+\//ig, '/uploads/');

  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.pathname.includes('/uploads/')) {
        const pathname = parsed.pathname.replace(/\/uploads(?:\/uploads)+\//ig, '/uploads/');
        return `${pathname}${parsed.search || ''}`;
      }
    } catch (_) {}
    return value;
  }

  const fsMatch = value.match(/(?:^|\/)uploads\/(.+)$/i);
  if (fsMatch) return `/uploads/${fsMatch[1]}`.replace(/\/uploads(?:\/uploads)+\//ig, '/uploads/');
  const clean = value.replace(/^\.?\//, '');
  return clean.startsWith('uploads/') ? `/${clean}`.replace(/\/uploads(?:\/uploads)+\//ig, '/uploads/') : value;
}

function uploadUrlToPath(url = '', uploadRoot = path.join(__dirname, 'uploads')) {
  const clean = normalizeMediaUrl(url).split(/[?#]/)[0];
  if (!clean.startsWith('/uploads/')) return null;
  const rel = clean.slice('/uploads/'.length);
  if (!rel || rel.includes('\0')) return null;
  let decoded = rel;
  try { decoded = decodeURIComponent(rel); } catch (_) {}
  const resolved = path.resolve(uploadRoot, decoded);
  const root = path.resolve(uploadRoot);
  return resolved === root || !resolved.startsWith(root + path.sep) ? null : resolved;
}

function imageVariantUrl(url = '', variant = 'medium') {
  const value = normalizeMediaUrl(url).split(/[?#]/)[0];
  if (!value.startsWith('/uploads/') || !IMAGE_EXT_RE.test(value)) return '';
  if (VIDEO_EXT_RE.test(value) || AUDIO_EXT_RE.test(value)) return '';
  const ext = path.extname(value);
  if (!ext) return '';
  if (/-((thumb)|(medium)|(large))\.webp$/i.test(value)) return value.replace(/-(thumb|medium|large)\.webp$/i, `-${variant}.webp`);
  return `${value.slice(0, -ext.length)}-${variant}.webp`;
}

module.exports = { IMAGE_EXT_RE, VIDEO_EXT_RE, AUDIO_EXT_RE, normalizeMediaUrl, uploadUrlToPath, imageVariantUrl, isYouTubeUrl };
