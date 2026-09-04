# UwU Weather, the Telegram bot

The [weatherapp.today](https://weatherapp.today) weather app, in a chat. It reads the
same Open-Meteo data the web app reads and describes it in the same words: current
conditions, the next 24 hours, a five day outlook, and a two hour precipitation
nowcast. It can also carry your saved places back and forth with the web app, and it
can send you the day ahead every morning.

Built on [Telethon](https://docs.telethon.dev/). Runs as a single Python process on a
VPS, with SQLite for its own state and Supabase for anything shared with the site.

- [What it does](#what-it-does)
- [Commands](#commands)
- [Syncing favourites](#syncing-favourites)
- [Backup codes](#backup-codes)
- [Installing on Debian 13](#installing-on-debian-13)
- [Running it in tmux](#running-it-in-tmux)
- [Configuration](#configuration)
- [How it is put together](#how-it-is-put-together)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [What is kept](#what-is-kept)

First time setting the bot up with BotFather? Read [SETUP.md](SETUP.md) first, then
come back here.

## What it does

- **Weather anywhere.** Send a city name on its own and the weather comes back. Share
  a location pin and it works too. Free text like `Springfield, IL, US` is parsed into
  name, region and country exactly the way the web app parses it.
- **Four views of one place.** Now, the next 24 hours, five days, and the two hour
  rain nowcast, switchable with the buttons under every reply.
- **Saved places.** Up to 24 of them, each one a button that fetches its weather.
- **One list across both.** Link the bot to the web app and both sides read and write
  the same saved places. If each side already had favourites before linking, the first
  link merges them into one list: nothing is lost, and a place saved on both sides
  becomes a single entry rather than a duplicate.
- **A daily digest.** Pick a time and get the day ahead every morning, in the local
  clock of the place it covers.
- **Buttons that never die.** Every button is stored in SQLite, so one sent months ago
  still works after restarts, reboots and upgrades.
- **Metric or imperial**, per person.

## Commands

| Command | What it does |
| --- | --- |
| `/start` | What the bot is, every command, and links to the web app and the donation page |
| `/weather [city]` | Current conditions. With no city, the last place you looked at |
| `/forecast [city]` | The next five days |
| `/hourly [city]` | The next 24 hours |
| `/nowcast [city]` | Rain in the next two hours, as a text sparkline |
| `/fav` | Your saved places, one button each |
| `/save [city]` | Save a place. With no city, the last place you looked at |
| `/remove [city]` | Drop a saved place, or tap one from the list |
| `/units` | Switch between Celsius and Fahrenheit |
| `/sub [HH:MM] [city]` | A daily digest at that local time |
| `/unsub` | Stop the digest |
| `/settings` | Everything you have set, in one place |
| `/link` | Share favourites with the web app |
| `/code` | Six digits to type into the web app |
| `/unlink` | Stop sharing favourites |

There is no `/help`. Everything it would have said lives in `/start`.

The bot answers in private chats only. It holds one person's saved places, so a group
chat is the wrong place for it. A command sent in a group gets a short pointer back to
the private chat and nothing else.

## Syncing favourites

There is no account and no password anywhere in this. A browser keeps a random id in
its own storage, and a link row says which Telegram account that browser belongs to.
Saved places hang off the Telegram id, so every browser linked to the same account
reads one list.

Three ways to link, all of them started by you rather than by anyone else:

1. **Deep link.** The web app writes a token and opens `t.me/uwuweatherapp_bot?start=<token>`.
   You confirm in Telegram and the web app, still polling, picks it up. This is the
   one to use when the site and Telegram are on the same device.
2. **Pull code.** You send `/code`, the bot gives you six digits, you type them into
   the sync panel. Use this when the site is on a laptop and Telegram is on your phone,
   because nothing has to travel from the laptop to the phone.
3. **Backup code.** Telegram itself is out of reach. See below.

Whichever route you take, the first link **merges** both lists. Places on the phone and
places in the browser all survive.

Afterwards, a removal is a removal. Deleting a place stores a tombstone rather than
dropping the row, so a device that still holds a stale copy cannot push it back the
next time it syncs. Saving the place again clears the tombstone. Tombstones are swept
after 30 days.

`/unlink` cuts the link, and asks twice before it does: once to choose whether the
shared copy is kept or erased, then once more to confirm that exact choice, with a
cancel on both. Your saved places stay in both places either way, they just stop
travelling between them.

## Backup codes

Every route above needs Telegram to work. Backup codes cover the day it does not: a
lost phone, a locked account, no signal.

**They are made in the web app, not here.** Open the sync panel, choose **Create a new
set**, and approve the request when it arrives in the chat. The codes then appear in
the browser tab that asked for them.

That split is the whole point. A linked browser cannot mint a way in without the
Telegram account agreeing, and the Telegram account never has codes read out to it in
a chat where they would sit in the history.

- **Asking is not creating.** The request lapses after ten minutes, can be answered
  only once, and asking again retires the one before it. That last part matters here:
  buttons in this bot never expire, so without a single use record an old approve
  button could quietly retire the set you are relying on.
- Eight codes per set, shown once, in the browser.
- Only their SHA-256 is stored, so a copy of the table is a list of hashes.
- One code links one browser, then stops working.
- Generating a new set retires whatever was left of the old one.
- When a code is spent, the bot tells you, with a **That was not me** button that
  disconnects every linked browser and cancels the remaining codes.

Keep them somewhere you can read without Telegram: on paper, or in a password manager.

## Installing on Debian 13

Debian 13 ships Python 3.13, which is all this needs.

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip git tmux

git clone https://github.com/augystudios/weather-app.git
cd weather-app/telegram-bot

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
nano .env          # fill in the values, see Configuration below
```

Then create the Supabase tables once, from
[`../main-site/migrations/0001_telegram_link_and_favourites.sql`](../main-site/migrations/0001_telegram_link_and_favourites.sql).
Paste it into the Supabase SQL editor, or:

```bash
supabase db execute --file ../main-site/migrations/0001_telegram_link_and_favourites.sql
```

Skip that step and the bot still runs. Weather, saved places and the daily digest all
work; only syncing with the web app is switched off, and the commands that need it say
so plainly.

Check it starts:

```bash
python bot.py
```

You should see one line naming the bot, whether syncing is on, and where the database
lives. Stop it with ctrl-c.

## Running it in tmux

```bash
tmux new -s weatherbot
cd ~/weather-app/telegram-bot
source .venv/bin/activate
python bot.py
```

Detach with **ctrl-b** then **d**. The bot keeps running.

| To do this | Run this |
| --- | --- |
| Come back to it | `tmux attach -t weatherbot` |
| See what is running | `tmux ls` |
| Read the log without attaching | `tmux capture-pane -pt weatherbot \| tail -50` |
| Stop the bot | attach, then ctrl-c |
| Throw the session away | `tmux kill-session -t weatherbot` |

Two things worth knowing. A tmux session dies with a reboot, so start it again
afterwards, or run `sudo loginctl enable-linger $USER` and add a systemd user unit if
you would rather it came back on its own. And run only one copy of the bot at a time:
two processes on one token fight over updates and neither behaves.

To keep a log you can read later:

```bash
python bot.py 2>&1 | tee -a ~/weatherbot.log
```

## Configuration

Everything is read from the environment. A `.env` file next to `bot.py` is read at
startup as a convenience, and never overrides a variable already exported in the shell.

| Variable | Required | What it is |
| --- | --- | --- |
| `TELEGRAM_API_ID` | yes | From [my.telegram.org/apps](https://my.telegram.org/apps) |
| `TELEGRAM_API_HASH` | yes | From the same page |
| `TELEGRAM_BOT_TOKEN` | yes | From BotFather |
| `SUPABASE_URL` | for syncing | Your project URL |
| `SUPABASE_SERVICE_KEY` | for syncing | The service role key. It bypasses row level security, so it belongs on the VPS and in Vercel, nowhere else |
| `DONATION_URL` | yes | The link behind the coffee button in `/start` |
| `WEB_APP_URL` | no | Defaults to `https://weatherapp.today` |
| `DB_PATH` | no | Defaults to `data/bot.db` next to the code |
| `NOTICE_POLL_SECONDS` | no | How often to look for messages the web app has left, default 3 |
| `SCHEDULER_TICK_SECONDS` | no | How often to look for due digests, default 30 |
| `LOG_LEVEL` | no | `DEBUG`, `INFO`, `WARNING` or `ERROR`, default `INFO` |

`.env`, `data/` and `sessions/` are all in `.gitignore`. The session file authenticates
as the bot, so treat it like the token itself.

The web app needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` too, set in the Vercel
project, plus `TELEGRAM_BOT_USERNAME` if the bot ever moves off `uwuweatherapp_bot`.

## How it is put together

```text
telegram-bot/
├── bot.py             entry point, wiring and background tasks
├── config.py          environment, table names, defaults
├── db.py              SQLite: preferences, favourites, buttons, schedules
├── supabase_rest.py   a small PostgREST client, no supabase-js equivalent needed
├── weather.py         Open-Meteo access and every formatter
├── favourites.py      saved places, local first, synced when linked
├── linking.py         the three link routes and the notice watcher
├── backup_codes.py    single use codes and their hashes
├── commands.py        every command handler
├── callbacks.py       the button router
├── scheduler.py       the SQLite backed timer for the daily digest
└── requirements.txt
```

Three things are worth calling out.

**Buttons are rows, not payloads.** Telegram allows 64 bytes of callback data, which is
usually spent encoding the action. Here the data is only `b:<row id>`, and the action
itself lives in SQLite. That is what lets a button from any point in the past still
work, and it means the answer to a tap cannot be forged by editing callback data.
Identical actions for the same person reuse one row, so the table does not grow with
every message.

**Timers are rows too.** The scheduler holds nothing in memory. It wakes every 30
seconds, asks SQLite what is due, and reschedules before it delivers, so a failure to
send one morning never stops the following mornings.

**The bot polls, it does not listen.** The web app cannot message anyone, so it leaves
a note in Supabase and the bot picks it up, which is how you hear that a backup code
was spent. Nothing has to reach the VPS from outside, so the firewall stays closed.

Weather calls go straight to Open-Meteo rather than through the site's `/api` proxies,
with a small cache that copies the lifetimes those proxies advertise: ten minutes for a
forecast, a day for a geocode.

## Updating

```bash
tmux attach -t weatherbot     # ctrl-c to stop
git pull
source .venv/bin/activate
pip install -r requirements.txt
python bot.py
```

The SQLite schema is created with `CREATE TABLE IF NOT EXISTS` on every start, so a new
table needs no migration step. Changes to the Supabase side arrive as a new file in
`../main-site/migrations/`.

## Troubleshooting

**It exits saying something is missing.** The three Telegram variables are required.
Check `.env` is next to `bot.py` and has no quotes around the values.

**Nothing happens when you message it.** Only one process may hold the token. Run
`tmux ls` and make sure a second copy is not already running.

**Commands work but `/link` says syncing is off.** `SUPABASE_URL` or
`SUPABASE_SERVICE_KEY` is unset, or the migration has not been run.

**The backup code alarm never arrives.** The bot can only message someone who has
messaged it first, which linking guarantees, but a blocked bot cannot deliver anything.
Unblock it and send `/start` once.

**Buttons say they are no longer available.** That message means the SQLite file was
replaced or deleted. Restore `data/bot.db` from a backup, or send the command again to
get fresh buttons.

**The daily digest arrives at the wrong hour.** The time follows the local clock at the
place the digest covers, not your own. Re-run `/sub` with the place you meant.

**A digest did not arrive at all.** If the bot was not running at the scheduled minute
it has 15 minutes of grace, and past that the run is skipped rather than delivered
late. The next morning is unaffected.

## What is kept

The bot keeps your Telegram id, your unit choice, your saved places, your digest time,
and the buttons it has sent you. It does not keep message text, and it stores nothing
about the people you talk to. When you link, your Telegram id and your saved places are
also written to Supabase so the web app can read the same list.

`/settings` lists all of it and carries **Erase everything about me**, which deletes
every trace, locally and in the shared copy.

---

Part of [UwU Weather](../README.md). Weather data by [Open-Meteo](https://open-meteo.com/).
