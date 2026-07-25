#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { normalizeMediaUrl, uploadUrlToPath } = require('../media-utils');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required to read media records. No changes made.');
  process.exit(1);
}
const prisma = new PrismaClient();
const uploadRoot = process.env.UPLOAD_ROOT || path.join(__dirname, '..', 'uploads');
const repair = process.argv.includes('--repair-urls');
const isLocal = (v) => normalizeMediaUrl(v).startsWith('/uploads/');
const jsonArray = (v) => Array.isArray(v) ? v : [];
const existsFor = (url) => { const p = uploadUrlToPath(url, uploadRoot); return { path:p, exists: !!(p && fs.existsSync(p) && fs.statSync(p).size > 0) }; };

function collect(type, row, fields) {
  const out = [];
  for (const [field, value] of fields) {
    if (Array.isArray(value)) value.forEach((v, i) => out.push({ type, id: row.id, field: `${field}[${i}]`, storedUrl: v }));
    else out.push({ type, id: row.id, field, storedUrl: value });
  }
  return out.filter(r => r.storedUrl && isLocal(r.storedUrl)).map(r => {
    const normalizedUrl = normalizeMediaUrl(r.storedUrl);
    const mapped = existsFor(normalizedUrl);
    return { ...r, normalizedUrl, filesystemPath: mapped.path, exists: mapped.exists };
  });
}

async function main() {
  const [projects, works, gallery, heroes, banners, audio, home] = await Promise.all([
    prisma.project.findMany(), prisma.workItem.findMany(), prisma.galleryItem.findMany(), prisma.heroSlide.findMany(), prisma.banner.findMany(), prisma.siteAudioTrack.findMany().catch(e => { console.error('Audio table unavailable:', e.code || e.message); return []; }), prisma.homeSectionImage.findMany().catch(()=>[])
  ]);
  const rows = [
    ...projects.flatMap(r => collect('Project', r, [['coverImage', r.coverImage], ['images', jsonArray(r.images)]])),
    ...works.flatMap(r => collect('Work', r, [['coverImage', r.coverImage], ['images', jsonArray(r.images)]])),
    ...gallery.flatMap(r => collect('Gallery', r, [['mediaUrl', r.mediaUrl], ['images', jsonArray(r.images)]])),
    ...heroes.flatMap(r => collect('Hero', r, [['mediaUrl', r.mediaUrl], ['image', r.image]])),
    ...banners.flatMap(r => collect('Banner', r, [['mediaUrl', r.mediaUrl]])),
    ...audio.flatMap(r => collect('Audio', r, [['audioUrl', r.audioUrl]])),
    ...home.flatMap(r => collect('HomeSectionImage', r, [['imageUrl', r.imageUrl]]))
  ];
  console.table(rows.map(({type,id,field,storedUrl,normalizedUrl,filesystemPath,exists}) => ({type,id,field,storedUrl,normalizedUrl,filesystemPath,exists})));

  if (!repair) return;
  const backup = { createdAt: new Date().toISOString(), projects, works, gallery, heroes, banners, audio, home };
  const backupPath = path.join(__dirname, `media-url-backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`Backup written: ${backupPath}`);
  const changes = rows.filter(r => r.exists && r.storedUrl !== r.normalizedUrl);
  for (const r of changes) console.log(`Would repair ${r.type} ${r.id} ${r.field}: ${r.storedUrl} -> ${r.normalizedUrl}`);
  console.log('Repair mode is intentionally conservative; apply printed changes manually after review. No records modified.');
}
main().finally(() => prisma.$disconnect());
