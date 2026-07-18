# baltic

## Render deployment

Deploy this repository on Render as a **Web Service**, not as a Static Site. A Static Site deployment only serves `index.html`, so every relative API request such as `/api/projects`, `/api/gallery`, `/api/hero-slides`, `/api/banners`, `/api/messages`, and `/api/stats` will return 404.

Use these Render settings:

- Type: **Web Service**
- Build command: `npm install`
- Start command: `npm start`
- Required environment variable: `DATABASE_URL=...`

After deploy, verify `GET /api/health` returns:

```json
{
  "ok": true,
  "service": "baltic-caspian-api"
}
```

## Local upload folders

Uploads are stored locally under these VPS folders, which the API creates automatically if they are missing:

- `uploads/home`
- `uploads/banners`
- `uploads/hero`
- `uploads/gallery`
- `uploads/projects`
- `uploads/works`

## Admin panel settings table

Run this SQL in Supabase if the `admin_panel_settings` table is not present:

```sql
create table if not exists public.admin_panel_settings (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  value jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_admin_panel_settings_updated_at
before update on public.admin_panel_settings
for each row execute function public.set_updated_at();

insert into public.admin_panel_settings(key, value)
values (
  'admin_tab_visibility',
  '{
    "dashboard": true,
    "messages": true,
    "projects": true,
    "gallery": true,
    "hero": true,
    "homeImages": true,
    "ads": true
  }'::jsonb
)
on conflict (key) do nothing;
```

## VPS upload size note

The Express API and multer are configured for uploads up to 150MB. If this app is deployed behind Nginx on a VPS, set the same request-size limit in the relevant `server` or `location` block:

```nginx
client_max_body_size 150M;
```
