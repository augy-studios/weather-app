-- 0001  Telegram linking and synced favourites
--
-- Run this in the Supabase SQL editor, or with the CLI:
--   supabase db execute --file main-site/migrations/0001_telegram_link_and_favourites.sql
--
-- There is no user table here on purpose. A browser holds a random portal id in
-- its own storage, and a link row says which Telegram account that browser
-- belongs to. Favourites hang off the Telegram id, so every browser linked to
-- the same account reads the same list.
--
-- Every table is closed to the anon and authenticated roles and has row level
-- security on with no policies, so only the service key reaches them. That key
-- lives on the VPS with the bot and in the Vercel project settings, never in
-- anything a browser downloads.

create extension if not exists pgcrypto;

-- --------------------------------------------------------------------------
-- Which browser belongs to which Telegram account
-- --------------------------------------------------------------------------
create table if not exists uwu_weather_links (
  portal_id         uuid        primary key,
  telegram_id       bigint      not null,
  telegram_username text,
  label             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_seen_at      timestamptz
);

create index if not exists uwu_weather_links_telegram_id
  on uwu_weather_links (telegram_id);

-- --------------------------------------------------------------------------
-- Deep link tokens. The web app writes one, then sends the person to
-- https://t.me/<bot>?start=<token> and polls this row until it turns claimed.
-- --------------------------------------------------------------------------
create table if not exists uwu_weather_link_tokens (
  token       text        primary key,
  portal_id   uuid        not null,
  label       text,
  status      text        not null default 'pending'
                          check (status in ('pending', 'claimed', 'denied', 'expired')),
  telegram_id bigint,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  resolved_at timestamptz
);

create index if not exists uwu_weather_link_tokens_portal
  on uwu_weather_link_tokens (portal_id, created_at desc);

-- --------------------------------------------------------------------------
-- Pull codes. The person sends /code to the bot and types the six digits into
-- the web app, which claims the row here.
-- --------------------------------------------------------------------------
create table if not exists uwu_weather_link_codes (
  code              text        primary key,
  telegram_id       bigint      not null,
  telegram_username text,
  portal_id         uuid,
  status            text        not null default 'pending'
                                check (status in ('pending', 'claimed', 'expired')),
  created_at        timestamptz not null default now(),
  expires_at        timestamptz not null,
  claimed_at        timestamptz
);

create index if not exists uwu_weather_link_codes_telegram
  on uwu_weather_link_codes (telegram_id, status);

-- --------------------------------------------------------------------------
-- Backup codes, the way in when Telegram itself is out of reach: a lost phone,
-- a locked account, no signal. The bot shows each code once and keeps only its
-- SHA-256, so a copy of this table is not a way in.
-- --------------------------------------------------------------------------
create table if not exists uwu_weather_backup_codes (
  id          uuid        primary key default gen_random_uuid(),
  telegram_id bigint      not null,
  code_hash   text        not null unique,
  batch       uuid        not null,
  created_at  timestamptz not null default now(),
  used_at     timestamptz,
  used_by     uuid
);

create index if not exists uwu_weather_backup_codes_owner
  on uwu_weather_backup_codes (telegram_id, used_at);

-- --------------------------------------------------------------------------
-- Permission to create a set of backup codes.
--
-- The request starts in the browser and is answered in Telegram, so neither
-- half can mint a way in on its own: a linked browser cannot create codes
-- without the Telegram account agreeing, and the Telegram account never has
-- the codes read out to it. The browser polls this row, and collects exactly
-- once.
-- --------------------------------------------------------------------------
create table if not exists uwu_weather_backup_requests (
  id           uuid        primary key default gen_random_uuid(),
  portal_id    uuid        not null,
  telegram_id  bigint      not null,
  label        text,
  status       text        not null default 'pending'
                           check (status in ('pending', 'approved', 'rejected',
                                             'expired', 'collected')),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  resolved_at  timestamptz,
  collected_at timestamptz
);

create index if not exists uwu_weather_backup_requests_portal
  on uwu_weather_backup_requests (portal_id, created_at desc);
create index if not exists uwu_weather_backup_requests_owner
  on uwu_weather_backup_requests (telegram_id, status);

-- --------------------------------------------------------------------------
-- Messages the web app wants the bot to deliver. The web app cannot reach
-- Telegram, so it leaves a note here and the bot picks it up as it polls.
-- --------------------------------------------------------------------------
create table if not exists uwu_weather_notices (
  id          uuid        primary key default gen_random_uuid(),
  telegram_id bigint      not null,
  kind        text        not null,
  data        jsonb       not null default '{}'::jsonb,
  status      text        not null default 'pending'
                          check (status in ('pending', 'sent', 'failed')),
  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

create index if not exists uwu_weather_notices_pending
  on uwu_weather_notices (status, created_at);

-- --------------------------------------------------------------------------
-- The shared favourites. Coordinates are stored to four decimals, about eleven
-- metres, so the bot and the site agree on what counts as the same place.
--
-- A removal sets deleted_at rather than deleting the row. Without that
-- tombstone, a device still holding a stale copy would push a deleted place
-- back up the next time it synced. Saving the place again clears it.
-- --------------------------------------------------------------------------
create table if not exists uwu_weather_favourites (
  id          uuid          primary key default gen_random_uuid(),
  telegram_id bigint        not null,
  name        text          not null,
  lat         numeric(9, 4) not null,
  lon         numeric(9, 4) not null,
  created_at  timestamptz   not null default now(),
  deleted_at  timestamptz,
  unique (telegram_id, lat, lon)
);

create index if not exists uwu_weather_favourites_owner
  on uwu_weather_favourites (telegram_id, deleted_at, created_at);

-- --------------------------------------------------------------------------
-- Rate limiting that survives a serverless instance going away.
--
-- A six digit code lives ten minutes, but the space is shared by everyone, so
-- bulk guessing could stumble onto whichever code happens to be live. Counting
-- failures per address, here rather than in a process that is about to be
-- recycled, is what makes that pointless.
-- --------------------------------------------------------------------------
create table if not exists uwu_weather_rate_limits (
  bucket       text        primary key,
  count        integer     not null default 0,
  window_start timestamptz not null default now()
);

create or replace function uwu_weather_bump_rate(p_bucket text, p_window_seconds integer)
returns integer
language plpgsql
as $$
declare
  v_count integer;
begin
  insert into uwu_weather_rate_limits (bucket, count, window_start)
  values (p_bucket, 1, now())
  on conflict (bucket) do update
    set count = case
          when uwu_weather_rate_limits.window_start
               < now() - make_interval(secs => p_window_seconds)
          then 1
          else uwu_weather_rate_limits.count + 1
        end,
        window_start = case
          when uwu_weather_rate_limits.window_start
               < now() - make_interval(secs => p_window_seconds)
          then now()
          else uwu_weather_rate_limits.window_start
        end
  returning uwu_weather_rate_limits.count into v_count;
  return v_count;
end $$;

-- --------------------------------------------------------------------------
-- Lock everything to the service key
-- --------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'uwu_weather_links',
    'uwu_weather_link_tokens',
    'uwu_weather_link_codes',
    'uwu_weather_backup_codes',
    'uwu_weather_backup_requests',
    'uwu_weather_notices',
    'uwu_weather_favourites',
    'uwu_weather_rate_limits'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from anon, authenticated', t);
  end loop;
end $$;

revoke all on function uwu_weather_bump_rate(text, integer) from anon, authenticated;

-- --------------------------------------------------------------------------
-- Housekeeping. The bot expires its own rows as it polls, and this clears the
-- husks. Schedule it if pg_cron is enabled, otherwise run it now and then.
--
--   select cron.schedule('uwu-weather-link-sweep', '17 3 * * *',
--                        $$select uwu_weather_sweep_links()$$);
-- --------------------------------------------------------------------------
create or replace function uwu_weather_sweep_links() returns void
language sql
as $$
  delete from uwu_weather_link_tokens where created_at < now() - interval '2 days';
  delete from uwu_weather_link_codes where created_at < now() - interval '2 days';
  delete from uwu_weather_notices
    where status <> 'pending' and created_at < now() - interval '7 days';
  delete from uwu_weather_backup_requests where created_at < now() - interval '7 days';
  -- Spent backup codes are kept a month so "when was this used" stays answerable.
  delete from uwu_weather_backup_codes where used_at < now() - interval '30 days';
  -- A tombstone only has to outlive the staleness of any device that might sync
  -- again. A month is generous for that.
  delete from uwu_weather_favourites where deleted_at < now() - interval '30 days';
  delete from uwu_weather_rate_limits where window_start < now() - interval '1 day';
$$;
