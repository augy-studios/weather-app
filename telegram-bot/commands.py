"""Command handlers.

The bot answers in private chats only. Commands never name the bot, and the
optional @suffix Telegram appends is accepted quietly so a forwarded command
still works.
"""

import logging
import re
import time
from urllib.parse import quote

from telethon import Button, events

import backup_codes
import db
import favourites
import linking
import scheduler
import ui
import weather
from config import BACKUP_CODE_COUNT, DONATION_URL, MAX_FAVOURITES, WEB_APP_URL
from supabase_rest import supabase

log = logging.getLogger(__name__)

DEEP_LINK_TOKEN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
TIME_ARG = re.compile(r"^([01]?\d|2[0-3])[:.]([0-5]\d)$")

VIEW_LABELS = [("Now", "current"), ("24 hours", "hourly"),
               ("5 days", "daily"), ("2 hour rain", "nowcast")]

ABOUT = (
    "Weather for anywhere, in the same words the web app uses. Current "
    "conditions, the next 24 hours, a five day outlook and a two hour rain "
    "nowcast, all from Open-Meteo.\n\n"
    "Send a city name on its own at any time and you get its weather back. "
    "Sharing a location pin works too."
)

COMMAND_LIST = [
    ("/weather", "current conditions, for example /weather Tokyo"),
    ("/forecast", "the next five days"),
    ("/hourly", "the next 24 hours"),
    ("/nowcast", "rain in the next two hours"),
    ("/fav", "your saved places, with a button for each"),
    ("/save", "save the place you last looked up, or /save Osaka"),
    ("/remove", "drop a saved place"),
    ("/units", "switch between Celsius and Fahrenheit"),
    ("/sub", "a daily digest at a time you choose, for example /sub 08:00"),
    ("/unsub", "stop the daily digest"),
    ("/settings", "everything you have set, in one place"),
    ("/link", "share favourites with the web app"),
    ("/code", "a six digit code to type into the web app"),
    ("/unlink", "stop sharing favourites"),
]


def command(name: str):
    """Matcher for one command in a private chat, with or without the @suffix."""
    return events.NewMessage(
        pattern=re.compile(rf"^/{name}(?:@[A-Za-z0-9_]+)?(?:\s+(?P<args>[\s\S]*))?$", re.I),
        func=lambda e: e.is_private,
    )


def args_of(event) -> str:
    try:
        return (event.pattern_match.group("args") or "").strip()
    except (AttributeError, IndexError):
        return ""


# --- shared rendering ------------------------------------------------------

async def weather_view(telegram_id: int, place: dict, view: str, note: str | None = None) -> dict:
    """Build one weather message. Commands send it, buttons edit into it."""
    units = await db.get_units(telegram_id)
    data = await weather.forecast(place["lat"], place["lon"], units)
    name = ui.esc(place["name"])

    if view == "hourly":
        title, body, fields = weather.format_hourly(data, name, units)
    elif view == "daily":
        title, body, fields = weather.format_daily(data, name, units)
    elif view == "nowcast":
        title, body, fields = weather.format_nowcast(data, name)
    else:
        view = "current"
        title, body, fields = weather.format_current(data, name, units)

    saved = {p["place_key"] for p in await db.list_favourites(telegram_id)}
    key = db.place_key(place["lat"], place["lon"])
    short = {"lat": round(float(place["lat"]), 4), "lon": round(float(place["lon"]), 4),
             "n": place["name"]}

    views_row = [
        {"label": label, "kind": "weather", "payload": {**short, "v": value}}
        for label, value in VIEW_LABELS if value != view
    ]
    if key in saved:
        # The place travels with the button so removing it can redraw this same
        # forecast rather than replacing it with the list of saved places.
        action = {"label": "Remove from favourites", "kind": "fav_del",
                  "payload": {"k": key, **short, "v": view}}
    else:
        action = {"label": "Save this place", "kind": "fav_add", "payload": short}

    return {
        "title": title,
        "body": body,
        "fields": fields,
        "footer": note or "Data from Open-Meteo.",
        "buttons": [
            views_row,
            [action, {"label": "Open in the app",
                      "url": f"{WEB_APP_URL}/?q={quote(place['name'])}"}],
        ],
    }


async def resolve_place(event, query: str) -> tuple[dict | None, str | None]:
    """Turn free text into a place. Empty text falls back to the last one used."""
    query = (query or "").strip()
    if not query:
        place = await db.get_default_place(event.sender_id)
        if place:
            return place, None
        return None, ("Tell me where. Send /weather Singapore, or share a location pin, "
                      "or save a place with /save so it becomes your default.")

    results = await weather.search_city(query)
    if not results:
        return None, ("No place matched that. Try a different spelling, or narrow it "
                      "down like <code>Springfield, IL, US</code>.")

    note = None
    if len(results) > 1:
        others = ", ".join(ui.esc(r["name"]) for r in results[1:4])
        note = f"Also matched: {others}. Add a region or country code to pick another."
    return results[0], note


async def send_weather(client, event, place: dict, view: str, note: str | None = None) -> None:
    try:
        payload = await weather_view(event.sender_id, place, view, note)
    except weather.WeatherError as err:
        await ui.send_rich_message(client, event.chat_id, title="No answer from the sky",
                                   body=str(err))
        return
    await db.set_default_place(event.sender_id, place["name"], place["lat"], place["lon"])
    await ui.send_rich_message(client, event.chat_id, owner_id=event.sender_id, **payload)


# --- commands --------------------------------------------------------------

async def on_start(event) -> None:
    client = event.client
    await db.ensure_user(event.sender_id)
    token = args_of(event)

    if token and DEEP_LINK_TOKEN.match(token):
        await linking.offer_token(client, event, token)
        return

    commands = "\n".join(f"{cmd} {desc}" for cmd, desc in COMMAND_LIST)
    await ui.send_rich_message(
        client, event.chat_id,
        title="Weather, in your pocket",
        body=ABOUT,
        fields=[("Commands", "\n" + commands)],
        footer="Made with love in Singapore. Weather data from Open-Meteo.",
        buttons=[
            [{"label": "Open the web app", "url": WEB_APP_URL},
             {"label": "Buy Augy a coffee", "url": DONATION_URL}],
            [{"label": "Sync my favourites", "kind": "link_help", "payload": {}}],
        ],
        owner_id=event.sender_id)


def _weather_command(view: str):
    async def handler(event):
        place, note = await resolve_place(event, args_of(event))
        if not place:
            await ui.send_rich_message(event.client, event.chat_id,
                                       title="Which place?", body=note)
            return
        await send_weather(event.client, event, place, view, note)
    return handler


async def on_location(event) -> None:
    geo = event.message.geo
    label = await weather.reverse_label(geo.lat, geo.long)
    await send_weather(event.client, event, {"name": label, "lat": geo.lat, "lon": geo.long},
                       "current", "Weather for the pin you shared.")


async def on_plain_text(event) -> None:
    """Anything that is not a command is treated as a place name."""
    place, note = await resolve_place(event, event.raw_text)
    if not place:
        await ui.send_rich_message(event.client, event.chat_id,
                                   title="I did not catch a place there", body=note)
        return
    await send_weather(event.client, event, place, "current", note)


async def on_fav(event) -> None:
    places = await favourites.listing(event.sender_id)
    if not places:
        await ui.send_rich_message(
            event.client, event.chat_id,
            title="No saved places yet",
            body="Look up a city and tap Save this place, or send /save Kyoto.",
            footer="Saved places are shared with the web app once you send /link.")
        return

    rows = []
    for place in places:
        short = {"lat": round(place["lat"], 4), "lon": round(place["lon"], 4),
                 "n": place["name"], "v": "current"}
        flag = weather.flag_from_label(place["name"])
        rows.append([
            {"label": f"{flag} {place['name']}".strip(), "kind": "weather", "payload": short},
            {"label": "Remove", "kind": "fav_del", "payload": {"k": place["place_key"]}},
        ])

    linked = await favourites.is_linked(event.sender_id)
    await ui.send_rich_message(
        event.client, event.chat_id,
        title="Your saved places",
        body=f"{len(places)} of {MAX_FAVOURITES} saved. Tap one for its weather.",
        footer=("In sync with the web app." if linked else
                "Only on this bot for now. Send /link to share them with the web app."),
        buttons=rows,
        owner_id=event.sender_id)


async def on_save(event) -> None:
    place, note = await resolve_place(event, args_of(event))
    if not place:
        await ui.send_rich_message(event.client, event.chat_id,
                                   title="Which place should I save?", body=note)
        return

    was_new, warning = await favourites.add(event.sender_id, place["name"],
                                            place["lat"], place["lon"])
    linked = await favourites.is_linked(event.sender_id)
    body = (f"{ui.esc(place['name'])} is saved." if was_new
            else f"{ui.esc(place['name'])} was already on your list.")
    if warning:
        footer = warning
    elif linked:
        footer = "It will show up in the web app as well."
    else:
        footer = "Send /link to have it show up in the web app too."

    await ui.send_rich_message(
        event.client, event.chat_id,
        title="Saved places updated", body=body, footer=footer,
        buttons=[[{"label": "See all saved places", "kind": "fav_list", "payload": {}}]],
        owner_id=event.sender_id)


async def on_remove(event) -> None:
    query = args_of(event)
    places = await favourites.listing(event.sender_id)
    if not places:
        await ui.send_rich_message(event.client, event.chat_id,
                                   title="Nothing to remove",
                                   body="Your list of saved places is empty.")
        return

    if query:
        wanted = query.lower()
        match = next((p for p in places if wanted in p["name"].lower()), None)
        if match:
            await favourites.remove(event.sender_id, match["place_key"])
            await ui.send_rich_message(
                event.client, event.chat_id,
                title="Saved places updated",
                body=f"{ui.esc(match['name'])} is off your list.",
                buttons=[[{"label": "See all saved places", "kind": "fav_list", "payload": {}}]],
                owner_id=event.sender_id)
            return

    await ui.send_rich_message(
        event.client, event.chat_id,
        title="Which one should go?",
        body="Tap a place to remove it.",
        buttons=[[{"label": p["name"], "kind": "fav_del", "payload": {"k": p["place_key"]}}]
                 for p in places],
        owner_id=event.sender_id)


async def on_units(event) -> None:
    current = await db.get_units(event.sender_id)
    wanted = args_of(event).lower()
    if wanted in ("c", "celsius", "metric"):
        new = "metric"
    elif wanted in ("f", "fahrenheit", "imperial"):
        new = "imperial"
    else:
        new = "imperial" if current == "metric" else "metric"

    await db.set_units(event.sender_id, new)
    await ui.send_rich_message(
        event.client, event.chat_id,
        title="Units changed",
        body=f"Now showing {weather.temp_unit(new)} and {weather.wind_unit(new)}.",
        footer="Send /units again to switch back.")


async def on_sub(event) -> None:
    raw = args_of(event)
    parts = raw.split(None, 1)
    time_part = parts[0] if parts else ""
    place_query = parts[1] if len(parts) > 1 else ""

    match = TIME_ARG.match(time_part) if time_part else None
    if time_part and not match:
        # No time given, so the whole argument is a place name.
        place_query, match = raw, None

    place, note = await resolve_place(event, place_query)
    if not place:
        await ui.send_rich_message(event.client, event.chat_id,
                                   title="Which place should the digest cover?", body=note)
        return

    if not match:
        await ui.send_rich_message(
            event.client, event.chat_id,
            title="When should the digest arrive?",
            body=f"Pick a time, or send /sub 08:00 to choose your own. "
                 f"It will cover {ui.esc(place['name'])}.",
            footer="Times follow the local clock at that place.",
            buttons=[[
                {"label": f"{hour:02d}:00", "kind": "sub_time",
                 "payload": {"h": hour, "m": 0, "lat": round(place["lat"], 4),
                             "lon": round(place["lon"], 4), "n": place["name"]}}
                for hour in (6, 7, 8)
            ], [
                {"label": f"{hour:02d}:00", "kind": "sub_time",
                 "payload": {"h": hour, "m": 0, "lat": round(place["lat"], 4),
                             "lon": round(place["lon"], 4), "n": place["name"]}}
                for hour in (12, 18, 21)
            ]],
            owner_id=event.sender_id)
        return

    await apply_subscription(event.client, event.sender_id, event.chat_id, place,
                             int(match.group(1)), int(match.group(2)))


async def apply_subscription(client, telegram_id: int, chat_id, place: dict,
                             hour: int, minute: int) -> tuple[str, str, list]:
    """Save the digest schedule and describe it. Shared by the command and the buttons."""
    try:
        data = await weather.forecast(place["lat"], place["lon"], await db.get_units(telegram_id))
        offset = data.get("utc_offset_seconds") or 0
    except weather.WeatherError:
        offset = 0

    payload = {"hour": hour, "minute": minute, "offset": offset,
               "lat": place["lat"], "lon": place["lon"], "name": place["name"]}
    next_run = scheduler.next_daily_run(hour, minute, offset)
    await db.upsert_schedule(scheduler.DAILY_DIGEST, telegram_id, payload, next_run)

    title = "Daily digest is on"
    body = (f"Every day at {hour:02d}:{minute:02d}, local time in "
            f"{ui.esc(place['name'])}, you get the day ahead.")
    hours_away = max(1, round((next_run - int(time.time())) / 3600))
    fields = [("First one", f"in about {hours_away} hour{'s' if hours_away != 1 else ''}")]
    if chat_id is not None:
        await ui.send_rich_message(client, chat_id, title=title, body=body, fields=fields,
                                   footer="Send /unsub to stop it at any time.")
    return title, body, fields


async def on_unsub(event) -> None:
    stopped = await db.cancel_schedule(scheduler.DAILY_DIGEST, event.sender_id)
    await ui.send_rich_message(
        event.client, event.chat_id,
        title="Daily digest is off" if stopped else "There was no daily digest",
        body=("You will not get the morning message any more."
              if stopped else "Nothing was scheduled, so nothing changed."),
        footer="Send /sub to turn it back on.")


async def on_settings(event) -> None:
    units = await db.get_units(event.sender_id)
    place = await db.get_default_place(event.sender_id)
    digest = await db.get_schedule(scheduler.DAILY_DIGEST, event.sender_id)
    links = await db.list_links(event.sender_id)
    saved = await db.list_favourites(event.sender_id)

    digest_text = "off"
    if digest:
        digest_text = (f"{digest['payload']['hour']:02d}:{digest['payload']['minute']:02d} "
                       f"in {ui.esc(digest['payload']['name'])}")

    fields = [
        ("Units", f"{weather.temp_unit(units)} and {weather.wind_unit(units)}"),
        ("Default place", ui.esc(place["name"]) if place else "not set"),
        ("Saved places", f"{len(saved)} of {MAX_FAVOURITES}"),
        ("Daily digest", digest_text),
        ("Linked browsers", str(len(links)) if links else "none"),
    ]
    if supabase.enabled:
        left = await backup_codes.remaining(event.sender_id)
        fields.append(("Backup codes",
                       f"{left} unused, made in the web app" if left
                       else "none yet, made in the web app"))

    await ui.send_rich_message(
        event.client, event.chat_id,
        title="Your settings",
        fields=fields,
        footer="Everything here is stored against your Telegram id and nothing else. "
               "Message text is never kept.",
        buttons=[[
            {"label": "Switch units", "kind": "units_toggle", "payload": {}},
            {"label": "Saved places", "kind": "fav_list", "payload": {}},
        ], [
            {"label": "Sync my favourites", "kind": "link_help", "payload": {}},
        ], [
            {"label": "Erase everything about me", "kind": "wipe_ask", "payload": {}},
        ]],
        owner_id=event.sender_id)


async def on_link(event) -> None:
    await send_link_help(event.client, event.chat_id, event.sender_id)


async def send_link_help(client, chat_id, telegram_id: int) -> None:
    if not supabase.enabled:
        title, body = linking.sync_off_message()
        await ui.send_rich_message(client, chat_id, title=title, body=body)
        return

    links = await db.list_links(telegram_id)
    body = (
        "Linking lets one set of saved places live in both places at once. "
        "Nothing else is shared, and there is no password anywhere."
    )
    fields = [
        ("From the web app",
         "Open the sync panel and tap the Telegram button. It brings you here and asks "
         "you to confirm."),
        ("From here",
         "Send /code for six digits, then type them into the sync panel. This is the "
         "one to use when the site is on a laptop and Telegram is on your phone."),
        ("Without Telegram at all",
         f"Keep {BACKUP_CODE_COUNT} single use backup codes for a lost phone or a locked "
         "account. You make them in the sync panel on the web app, and approve the "
         "request here."),
    ]
    await ui.send_rich_message(
        client, chat_id,
        title="Sync your favourites" if not links else "Your sync is on",
        body=body if not links else
             f"{len(links)} browser{'s' if len(links) != 1 else ''} share favourites with "
             f"this account. {body}",
        fields=fields,
        footer="The first link merges both lists, so nothing is lost from either side.",
        buttons=[[{"label": "Open the web app", "url": WEB_APP_URL}],
                 [{"label": "Give me a code", "kind": "link_code", "payload": {}}]]
                + ([[{"label": "Unlink everything", "kind": "unlink_ask", "payload": {}}]]
                   if links else []),
        owner_id=telegram_id)


async def on_code(event) -> None:
    await linking.issue_code(event.client, event)


async def on_unlink(event) -> None:
    await send_unlink_choice(event.client, event.chat_id, event.sender_id)


async def send_unlink_choice(client, chat_id, telegram_id: int) -> None:
    """First of two steps. Nothing is undone here, whichever button is tapped:
    each one leads to a confirmation naming exactly what it is about to do."""
    links = await db.list_links(telegram_id)
    if not links:
        await ui.send_rich_message(
            client, chat_id,
            title="Nothing is linked",
            body="No browser is sharing favourites with this account.",
            buttons=[[{"label": "Set up syncing", "kind": "link_help", "payload": {}}]],
            owner_id=telegram_id)
        return

    await ui.send_rich_message(
        client, chat_id,
        title="Remove the link?",
        body=f"{len(links)} browser{'s' if len(links) != 1 else ''} would stop sharing "
             f"favourites with this account. Pick what should happen to the shared copy, "
             f"then confirm on the next message.",
        fields=[("Keep the synced copy",
                 "Your places stay here and stay in the web app, they just stop "
                 "travelling between the two."),
                ("Erase the synced copy",
                 "The shared copy is deleted. Your places stay here in the bot.")],
        buttons=[[{"label": "Unlink, keep the copy", "kind": "unlink_confirm",
                   "payload": {"wipe": 0}}],
                 [{"label": "Unlink and erase it", "kind": "unlink_confirm",
                   "payload": {"wipe": 1}}],
                 [{"label": "Cancel", "kind": "unlink_cancel", "payload": {}}]],
        owner_id=telegram_id)


async def on_group_message(event) -> None:
    """The bot holds per person favourites, so it stays out of group chats."""
    if not (event.raw_text or "").startswith("/"):
        return
    me = await event.client.get_me()
    await event.reply(
        "This one works in a private chat. Tap through and send /start there.",
        buttons=[[Button.url("Open the chat", f"https://t.me/{me.username}")]])


def register(client) -> None:
    handlers = [
        (on_start, command("start")),
        (_weather_command("current"), command("weather")),
        (_weather_command("daily"), command("forecast")),
        (_weather_command("hourly"), command("hourly")),
        (_weather_command("nowcast"), command("nowcast")),
        (on_fav, command("fav")),
        (on_save, command("save")),
        (on_remove, command("remove")),
        (on_units, command("units")),
        (on_sub, command("sub")),
        (on_unsub, command("unsub")),
        (on_settings, command("settings")),
        (on_link, command("link")),
        (on_code, command("code")),
        (on_unlink, command("unlink")),
        (on_location, events.NewMessage(
            func=lambda e: e.is_private and e.message.geo is not None)),
        (on_plain_text, events.NewMessage(
            func=lambda e: (e.is_private and bool(e.raw_text)
                            and not e.raw_text.startswith("/")
                            and e.message.geo is None))),
        (on_group_message, events.NewMessage(func=lambda e: not e.is_private)),
    ]
    for handler, matcher in handlers:
        client.add_event_handler(_guard(handler), matcher)


def _guard(handler):
    """Never leave a command silently dead. Log the detail, say something short."""
    async def wrapped(event):
        try:
            await handler(event)
        except weather.WeatherError as err:
            await ui.send_rich_message(event.client, event.chat_id,
                                       title="No answer from the sky", body=str(err))
        except Exception:
            log.exception("Handler failed for %s", getattr(event, "raw_text", ""))
            await ui.send_rich_message(
                event.client, event.chat_id,
                title="Something went wrong",
                body="That did not work. Please try again in a moment.")
    return wrapped
