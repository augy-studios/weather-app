-- 0002  Lightning alerts on Telegram
--
-- Run after 0001, the same way:
--   supabase db execute --file main-site/migrations/0002_lightning_alerts.sql
--
-- One row per Telegram account that asked to hear about lightning near its
-- synced favourites. Turned on and off from the web app's alerts panel by a
-- linked browser. The places are the favourites themselves, so there is nothing
-- else to keep in step. Browser push alerts do not live here: their
-- subscriptions are in Upstash, next to the cron that sends them.
--
-- The alerts reach Telegram through uwu_weather_notices, kind 'lightning',
-- which the bot already polls and delivers.

create table if not exists uwu_weather_lightning (
  telegram_id bigint      primary key,
  enabled     boolean     not null default true,
  radius_km   integer     not null default 10 check (radius_km in (5, 10, 20)),
  updated_at  timestamptz not null default now()
);

create index if not exists uwu_weather_lightning_enabled
  on uwu_weather_lightning (enabled);

alter table uwu_weather_lightning enable row level security;
revoke all on table uwu_weather_lightning from anon, authenticated;
