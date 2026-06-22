# baltic

## Render deployment

Deploy this repository on Render as a **Web Service**, not as a Static Site. A Static Site deployment only serves `index.html`, so every relative API request such as `/api/projects`, `/api/gallery`, `/api/hero-slides`, `/api/banners`, `/api/messages`, and `/api/stats` will return 404.

Use these Render settings:

- Type: **Web Service**
- Build command: `npm install`
- Start command: `npm start`
- Required environment variable: `DATABASE_URL=...`
- Optional storage variables: `SUPABASE_URL=...`, `SUPABASE_SERVICE_ROLE_KEY=...`

After deploy, verify `GET /api/health` returns:

```json
{
  "ok": true,
  "service": "baltic-caspian-api"
}
```

## Supabase Storage buckets

Create these Supabase Storage buckets manually before wiring real signed uploads:

- `projects`
- `gallery`
- `hero`
- `banners`
