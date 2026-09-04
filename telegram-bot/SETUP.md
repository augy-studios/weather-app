# Setting the bot up

Start to finish: creating the bot with BotFather, dressing its profile, creating the
Supabase tables, wiring the web app, and getting the process running on the VPS.

Roughly twenty minutes, most of it waiting for BotFather.

- [1. Create the bot](#1-create-the-bot)
- [2. Get your Telegram API credentials](#2-get-your-telegram-api-credentials)
- [3. Dress the profile](#3-dress-the-profile)
- [4. Set the command list](#4-set-the-command-list)
- [5. Lock down where it works](#5-lock-down-where-it-works)
- [6. Create the Supabase tables](#6-create-the-supabase-tables)
- [7. Wire up the web app](#7-wire-up-the-web-app)
- [8. Configure and start the bot](#8-configure-and-start-the-bot)
- [9. Check it end to end](#9-check-it-end-to-end)
- [Changing things later](#changing-things-later)

## 1. Create the bot

Open [@BotFather](https://t.me/BotFather) in Telegram.

```text
/newbot
```

It asks two questions.

| It asks | Answer |
| --- | --- |
| Name | `UwU Weather` |
| Username | `uwuweatherapp_bot` |

The name is what people see at the top of the chat and can be changed at any time. The
username is permanent, must end in `bot`, and is what `t.me/uwuweatherapp_bot` resolves
to.

BotFather replies with a token that looks like
`1234567890:AAaaBBbbCCccDDddEEeeFFffGGgg`. That token **is** the bot. Anyone holding it
can act as it, so keep it out of git, out of screenshots and out of chat logs. It goes
in `.env` as `TELEGRAM_BOT_TOKEN` in step 8.

If it ever leaks, `/revoke` in BotFather issues a new one and kills the old.

## 2. Get your Telegram API credentials

Telethon speaks the full Telegram API rather than the simpler bot API, so it needs an
app id as well as the bot token. These identify the client software, not the bot, and
one pair works for every bot you run.

1. Go to [my.telegram.org/apps](https://my.telegram.org/apps) and sign in with your
   phone number.
2. Fill in **App title** and **Short name** with anything sensible, such as
   `uwu-weather-bot`. Platform can be Other, and the URL can be left empty.
3. Save, then copy **App api_id** and **App api_hash**.

Those become `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`.

## 3. Dress the profile

Still in BotFather. Each of these asks which bot first, so pick
`@uwuweatherapp_bot` when prompted.

**The one line under the name**, up to 120 characters:

```text
/setabouttext
```

```text
Weather anywhere, in a chat. Now, the next 24 hours, five days, and a two hour rain nowcast.
```

**The text on the empty chat screen**, up to 512 characters, seen before anyone presses
Start:

```text
/setdescription
```

```text
Weather for anywhere, in the same words the web app uses.

Send a city name and get current conditions, the next 24 hours, a five day outlook and a two hour rain nowcast. Share a location pin and it works too.

Save the places you check often, sync them with weatherapp.today so one list follows you everywhere, and get the day ahead every morning at a time you pick.

Data from Open-Meteo. Made with love in Singapore.
```

**The profile picture**:

```text
/setuserpic
```

Upload `main-site/weather-512.png` from this repository. Square images work best and
Telegram crops to a circle, so keep the sun icon centred.

## 4. Set the command list

This is the menu that appears when someone types `/` in the chat.

```text
/setcommands
```

Pick the bot, then paste this block in one message. The format is
`command - description`, one per line, no slash on the command, and nothing longer than
256 characters.

```text
start - What this bot is, every command, and quick links
weather - Current conditions, for example Tokyo
forecast - The next five days
hourly - The next 24 hours
nowcast - Rain in the next two hours
fav - Your saved places, one button each
save - Save a place to your list
remove - Drop a saved place
units - Switch between Celsius and Fahrenheit
sub - A daily digest at a time you choose
unsub - Stop the daily digest
settings - Everything you have set, in one place
link - Link this Telegram account to your portal account to sync favourites
code - Get a six digit code to type into the web app
unlink - Remove the link
```

The list can take a minute to appear in clients, and an already open chat may need to
be reopened before it shows.

There is deliberately no `help` command. Everything it would have said is in `/start`,
which is the one command every new person presses anyway.

## 5. Lock down where it works

The bot holds one person's saved places, so it belongs in private chats.

```text
/setjoingroups
```

Choose **Disable**. Nobody can add it to a group.

```text
/setprivacy
```

Choose **Enable**. Even if it somehow ends up in a group, it only ever sees commands
aimed at it, not the conversation. The code refuses to answer outside private chats
regardless, but there is no reason to receive the messages at all.

Leave inline mode off. It is not used.

## 6. Create the Supabase tables

Only needed for syncing favourites with the web app. Skip it and everything else still
works; the sync commands say plainly that it is switched off.

1. Open your Supabase project, then **SQL Editor**.
2. Paste the whole of
   [`../main-site/migrations/0001_telegram_link_and_favourites.sql`](../main-site/migrations/0001_telegram_link_and_favourites.sql)
   and run it.

Or from a machine with the CLI:

```bash
supabase db execute --file main-site/migrations/0001_telegram_link_and_favourites.sql
```

It creates eight tables, all prefixed `uwu_weather_`: the links themselves, the deep
link tokens, the pull codes, the backup codes, the requests that allow a set of those
to be created, the notice queue the bot delivers from, the shared favourites, and a
small counter table that limits code guessing. It also adds two functions, one for
that counter and one to sweep expired rows.

Every one of them has row level security on with no policies, and the anon and
authenticated roles are revoked. Only the service role key reaches them, which is why
that key never leaves the server.

Then, from **Project settings, API**, copy:

- the **Project URL**, which becomes `SUPABASE_URL`
- the **service_role** key, which becomes `SUPABASE_SERVICE_KEY`

The `anon` key is the wrong one here. It is meant to be public and cannot see these
tables at all.

## 7. Wire up the web app

The sync panel on the site talks to two serverless routes that ship with it,
`/api/link` and `/api/favourites`. They need the same two Supabase values.

In the Vercel project, under **Settings, Environment Variables**, add:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | your project URL |
| `SUPABASE_SERVICE_KEY` | the service role key |
| `TELEGRAM_BOT_USERNAME` | `uwuweatherapp_bot`, only if it ever differs |

Redeploy so the routes pick them up. Without them the sync panel reports that syncing
is not switched on, and the rest of the site is untouched.

## 8. Configure and start the bot

On the VPS:

```bash
cd ~/weather-app/telegram-bot
cp .env.example .env
nano .env
```

Fill in:

```ini
TELEGRAM_API_ID=1234567
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
TELEGRAM_BOT_TOKEN=1234567890:AAaaBBbbCCccDDddEEeeFFffGGgg
SUPABASE_URL=https://yourproject.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGciOi...
DONATION_URL=https://donate.stripe.com/28o2akeAr3hv0DK6oo
```

No quotes, no spaces around the equals sign. Then:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python bot.py
```

A healthy start prints one line:

```text
2026-09-04 14:02:11  INFO    bot  Running as @uwuweatherapp_bot, syncing is on, database at /home/you/weather-app/telegram-bot/data/bot.db
```

Stop it with ctrl-c, then start it for real under tmux. See
[README.md](README.md#running-it-in-tmux) for that and for keeping it alive across
reboots.

## 9. Check it end to end

In a private chat with the bot:

1. `/start` shows the introduction with a web app button and a coffee button.
2. `Tokyo` on its own returns the weather, with buttons that switch view.
3. **Save this place**, then `/fav`, shows Tokyo as a button.
4. Restart the bot, then tap a button on that older message. It still works. That is
   the button registry doing its job.
5. `/sub 08:00` confirms a digest and says roughly how long until the first one.

Then the sync, which needs the Supabase and Vercel steps above done:

1. On the site, open the sync panel with the circular arrows button in the header, then
   **Open the chat**. Approve in Telegram. The panel updates on its own, and both lists
   are now one merged list.
2. Remove a place on the site, then send `/fav` in the chat. It is gone there too, and
   it does not come back when another browser syncs.
3. In the sync panel, **Create a new set** under Backup codes. An approval message
   arrives in the chat; nothing is created until you tap **Approve**, and the codes
   then appear in the browser. Tap Approve a second time and it refuses, which is the
   single use record doing its job.
4. Type one of those codes into the code box in a different browser. It links, and the
   bot tells you a code was used.
5. `/unlink` in the chat. It asks what to do with the shared copy, then asks you to
   confirm that choice before anything happens. Confirm, then reload the site. Saved
   places are still on both sides, they have simply stopped travelling.

## Changing things later

| To change | Do this |
| --- | --- |
| The display name | `/setname` in BotFather |
| The one liner or description | `/setabouttext` or `/setdescription` |
| The command menu | `/setcommands`, pasting the whole block again |
| The picture | `/setuserpic` |
| The token, after a leak | `/revoke`, then update `.env` and restart |
| Deleting the bot | `/deletebot`, which cannot be undone |

The command block is the whole list every time. BotFather replaces what is there rather
than merging, so removing a line removes the command from the menu.
