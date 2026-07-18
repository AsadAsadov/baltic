#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const uploadRoot = path.join(__dirname, '..', 'uploads');
const buckets = ['projects', 'gallery', 'works'];
const widths = { thumb: 480, medium: 960, large: 1600 };
const qualities = { thumb: 74, medium: 78, large: 82 };
const imageExt = /\.(jpe?g|png|webp|avif|tiff?|bmp)$/i;
const variantSuffix = /-(thumb|medium|large)\.webp$/i;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || !args.includes('--all');
const bucketArg = args[args.indexOf('--bucket') + 1];
const limitArg = Number(args[args.indexOf('--limit') + 1] || 0);
const concurrencyArg = Math.max(1, Math.min(4, Number(args[args.indexOf('--concurrency') + 1] || 2)));
const selectedBuckets = bucketArg ? [bucketArg] : buckets;

function usage() {
  console.log('Usage: node scripts/optimize-existing-images.js [--dry-run] [--all] [--bucket projects|gallery|works] [--limit 20] [--concurrency 2]');
}
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (imageExt.test(entry.name) && !variantSuffix.test(entry.name)) out.push(full);
  }
  return out;
}
function variantPath(file, name) {
  return path.join(path.dirname(file), `${path.basename(file, path.extname(file))}-${name}.webp`);
}
async function optimizeOne(file) {
  const missing = Object.keys(widths).filter(name => !fs.existsSync(variantPath(file, name)));
  if (!missing.length) return { file, skipped: true, reason: 'variants-exist' };
  if (dryRun) return { file, dryRun: true, variants: missing.map(name => variantPath(file, name)) };
  for (const name of missing) {
    await sharp(file).rotate().resize({ width: widths[name], withoutEnlargement: true }).webp({ quality: qualities[name], effort: 4 }).toFile(variantPath(file, name));
  }
  return { file, optimized: true, variants: missing };
}
async function runPool(files) {
  let index = 0, ok = 0, failed = 0;
  async function worker() {
    while (index < files.length) {
      const file = files[index++];
      try { console.log(await optimizeOne(file)); ok += 1; }
      catch (error) { failed += 1; console.error('[failed]', { file, message: error.message }); }
    }
  }
  await Promise.all(Array.from({ length: concurrencyArg }, worker));
  return { ok, failed };
}
(async () => {
  if (bucketArg && !buckets.includes(bucketArg)) { usage(); process.exit(1); }
  let files = selectedBuckets.flatMap(bucket => walk(path.join(uploadRoot, bucket)));
  if (limitArg > 0) files = files.slice(0, limitArg);
  console.log({ dryRun, buckets: selectedBuckets, count: files.length, concurrency: concurrencyArg });
  const result = await runPool(files);
  console.log({ done: true, ...result });
})().catch(error => { console.error(error); process.exit(1); });
