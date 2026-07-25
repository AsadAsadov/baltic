#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run') || !args.has('--import-real');
const importReal = args.has('--import-real');
const includeDemo = args.has('--include-demo');
const galleryDir = path.join(__dirname, '..', 'uploads', 'gallery');
const variantRe = /-(thumb|medium|large)\.webp$/i;
const imageRe = /\.(jpe?g|png|webp|avif|gif|bmp|tiff?)$/i;
const demoRe = /(unsplash|photo-|source\.unsplash|images\.unsplash)/i;

function publicUrl(file) { return `/uploads/gallery/${file}`; }
function baseOf(file) { return file.replace(variantRe, '').replace(/\.[^.]+$/, '').toLowerCase(); }
function titleFrom(file) { return path.basename(file, path.extname(file)).replace(/^[0-9a-f-]{8,}_?/i, '').replace(/[_-]+/g, ' ').trim() || 'Gallery image'; }
function sortFiles(files) { return [...files].sort((a,b)=>a.localeCompare(b, 'en', { numeric:true })); }

(async () => {
  if (!fs.existsSync(galleryDir)) throw new Error(`Gallery folder not found: ${galleryDir}`);
  const files = sortFiles(fs.readdirSync(galleryDir).filter(f => imageRe.test(f)));
  const variants = files.filter(f => variantRe.test(f));
  const originals = files.filter(f => !variantRe.test(f));
  const byBase = new Map();
  for (const f of files) {
    const base = baseOf(f);
    if (!byBase.has(base)) byBase.set(base, { base, originals: [], variants: [] });
    (variantRe.test(f) ? byBase.get(base).variants : byBase.get(base).originals).push(f);
  }
  const groups = [...byBase.values()].map(g => ({ ...g, originals: sortFiles(g.originals), variants: sortFiles(g.variants) }));
  const demo = originals.filter(f => demoRe.test(f));
  const real = originals.filter(f => !demoRe.test(f));
  const duplicateGroups = groups.filter(g => g.originals.length > 1);
  const missingOriginal = groups.filter(g => !g.originals.length && g.variants.length);
  const incompleteVariants = groups.filter(g => g.originals.length && !['thumb','medium','large'].every(v => g.variants.some(f => new RegExp(`-${v}\\.webp$`, 'i').test(f))));
  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'import-real', originalCandidateCount: originals.length, generatedVariantCount: variants.length, demoUnsplashCandidateCount: demo.length, realUploadCandidateCount: real.length, duplicateGroups: duplicateGroups.map(g=>g.originals), filesWithMissingOriginal: missingOriginal.map(g=>g.variants), filesWithIncompleteVariants: incompleteVariants.map(g=>({ original:g.originals[0], variants:g.variants })) }, null, 2));
  console.log('\nReal upload candidates:'); real.forEach(f => console.log(`  IMPORTABLE ${publicUrl(f)}`));
  console.log('\nDemo/Unsplash candidates:'); demo.forEach(f => console.log(`  REJECTED_DEMO ${publicUrl(f)}`));
  if (dryRun) return;
  let sortOrder = await prisma.galleryItem.count();
  for (const file of originals) {
    const isDemo = demoRe.test(file);
    if (isDemo && !includeDemo) { console.log(`REJECTED demo ${publicUrl(file)}`); continue; }
    if (!real.includes(file) && !includeDemo) { console.log(`REJECTED unknown ${publicUrl(file)}`); continue; }
    const url = publicUrl(file);
    const exists = await prisma.galleryItem.findFirst({ where: { OR: [{ mediaUrl: url }, { images: { array_contains: [url] } }] } });
    if (exists) { console.log(`SKIPPED existing ${url} -> id=${exists.id}`); continue; }
    const row = await prisma.galleryItem.create({ data: { mediaUrl: url, images: [url], titleAz: titleFrom(file), titleRu: titleFrom(file), titleEn: titleFrom(file), type: 'image', sortOrder: sortOrder++, archived: false } });
    console.log(`INSERTED id=${row.id} ${url}`);
  }
  console.log('Gallery import complete. Restart the app or wait for in-memory API cache TTL to expire.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async()=>prisma.$disconnect());
