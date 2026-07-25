#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const uploadRoot = path.join(__dirname, '..', 'uploads');
const buckets = ['projects', 'works', 'gallery', 'hero', 'home', 'banners', 'about'];
const widths = { thumb: 420, medium: 960, large: 1600 };
const qualities = { thumb: 76, medium: 80, large: 82 };
const imageExt = /\.(jpe?g|png|webp|avif|tiff?|bmp)$/i;
const skippedExt = /\.(svg|gif)$/i;
const variantSuffix = /-(thumb|medium|large)\.webp$/i;
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag, fallback = '') => { const index = args.indexOf(flag); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const dryRun = has('--dry-run') || !has('--all');
const force = has('--force');
const skipExisting = has('--skip-existing') || !force;
const bucketArg = valueOf('--bucket', '');
const limitArg = Math.max(0, Number.parseInt(valueOf('--limit', '0'), 10) || 0);
const concurrencyArg = Math.max(1, Math.min(8, Number.parseInt(valueOf('--concurrency', '2'), 10) || 2));
const selectedBuckets = bucketArg && bucketArg !== 'all' ? [bucketArg] : buckets;

function usage() {
  console.log('Usage: node scripts/optimize-existing-images.js [--dry-run] [--all] [--bucket projects|works|gallery|hero|home|banners|about|all] [--limit 20] [--concurrency 2] [--force] [--skip-existing]');
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (imageExt.test(entry.name) && !skippedExt.test(entry.name) && !variantSuffix.test(entry.name)) out.push(full);
  }
  return out;
}
function variantPath(file, name) {
  return path.join(path.dirname(file), `${path.basename(file, path.extname(file))}-${name}.webp`);
}
function fileSize(file) { try { return fs.statSync(file).size; } catch { return 0; } }
async function optimizeOne(file) {
  const variants = Object.keys(widths).map(name => ({ name, file: variantPath(file, name) }));
  const targets = skipExisting ? variants.filter(item => !fs.existsSync(item.file)) : variants;
  if (!targets.length) return { status: 'skipped', reason: 'variants-exist', file };
  const before = fileSize(file);
  if (dryRun) return { status: 'dry-run', file, variants: targets.map(item => item.file), before };
  let writtenBytes = 0;
  const image = sharp(file, { animated: false }).rotate();
  for (const target of targets) {
    await image.clone().resize({ width: widths[target.name], withoutEnlargement: true }).webp({ quality: qualities[target.name], effort: 4 }).toFile(target.file);
    writtenBytes += fileSize(target.file);
  }
  return { status: 'optimized', file, variants: targets.map(item => item.name), before, after: writtenBytes, saved: Math.max(0, before - writtenBytes) };
}
async function runPool(files) {
  let index = 0;
  const report = { optimized: 0, skipped: 0, dryRun: 0, failed: 0, beforeBytes: 0, afterBytes: 0, savedBytes: 0, failures: [] };
  async function worker() {
    while (index < files.length) {
      const file = files[index++];
      try {
        const result = await optimizeOne(file);
        console.log(result);
        if (result.status === 'optimized') { report.optimized += 1; report.beforeBytes += result.before || 0; report.afterBytes += result.after || 0; report.savedBytes += result.saved || 0; }
        else if (result.status === 'dry-run') { report.dryRun += 1; report.beforeBytes += result.before || 0; }
        else report.skipped += 1;
      } catch (error) { report.failed += 1; report.failures.push({ file, message: error.message }); console.error('[failed]', { file, message: error.message }); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrencyArg, Math.max(files.length, 1)) }, worker));
  return report;
}
(async () => {
  if (bucketArg && bucketArg !== 'all' && !buckets.includes(bucketArg)) { usage(); process.exit(1); }
  let files = selectedBuckets.flatMap(bucket => walk(path.join(uploadRoot, bucket)));
  if (limitArg > 0) files = files.slice(0, limitArg);
  console.log({ dryRun, force, skipExisting, buckets: selectedBuckets, count: files.length, concurrency: concurrencyArg, widths, qualities });
  const result = await runPool(files);
  const savedPercent = result.beforeBytes ? Math.round((result.savedBytes / result.beforeBytes) * 1000) / 10 : 0;
  console.log({ done: true, ...result, savedPercent });
})().catch(error => { console.error(error); process.exit(1); });
