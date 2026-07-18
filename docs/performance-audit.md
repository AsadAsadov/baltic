# Baltic Caspian performance audit notes

## Findings

- Public list endpoints previously used broad `findMany` calls and returned list cards with full `images` arrays, which encouraged the frontend to request original multi-megabyte uploads in project/gallery grids.
- Public list endpoints had no in-process response cache, so repeat navigation still waited for Prisma and JSON normalization.
- The frontend kept only short-lived in-memory entries without TTL metadata in persisted route cache and loaded card images with only native lazy loading, no `srcset`/`sizes` contract.
- Public pages already guard `loadAdminTabVisibility()` behind the admin initialization path; unauthenticated 401s should stop once old cached assets are replaced.
- `BC loqo.png` is not referenced in the repository; the canonical favicon is `/balticlogo.png?v=2`.

## Deployment checklist

```bash
cd /var/www/balticcaspian
git status
git diff
git pull origin main
npm install
npm run build:css
npx prisma generate
npx prisma migrate deploy
pm2 restart balticcaspian --update-env
pm2 save
nginx -t
systemctl reload nginx
pm2 logs balticcaspian --lines 150
```

## Image backfill

Dry-run first, then optimize by bucket/limit:

```bash
node scripts/optimize-existing-images.js --dry-run
node scripts/optimize-existing-images.js --bucket gallery --limit 20 --all
node scripts/optimize-existing-images.js --all
```

The script creates `-thumb.webp`, `-medium.webp`, and `-large.webp` variants without overwriting originals or updating database URLs.
