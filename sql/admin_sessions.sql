create table if not exists public.admin_sessions (
  sid varchar not null primary key,
  sess json not null,
  expire timestamp(6) not null
);

create index if not exists idx_admin_sessions_expire on public.admin_sessions(expire);
