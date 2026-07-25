alter table public.banners
add column if not exists display_order integer not null default 0,
add column if not exists width integer not null default 260,
add column if not exists height integer not null default 600,
add column if not exists duration integer not null default 15;

alter table public.hero_slides
add column if not exists sort_order integer not null default 0,
add column if not exists active boolean not null default true;
