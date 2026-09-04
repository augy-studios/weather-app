"""Inline button handling.

Callback data is only ever "b:<row id>". The action itself lives in SQLite, so a
button from any point in the past still resolves after a restart, a redeploy or
a schema change to whatever the button was created to do.
"""

import logging

from telethon import events

import backup_codes
import commands
import db
import favourites
import linking
import ui
import weather
from config import WEB_APP_URL
from supabase_rest import SupabaseError

log = logging.getLogger(__name__)


async def _weather(event, payload):
    place = {"name": payload["n"], "lat": payload["lat"], "lon": payload["lon"]}
    view = payload.get("v", "current")
    message = await commands.weather_view(event.sender_id, place, view)
    await db.set_default_place(event.sender_id, place["name"], place["lat"], place["lon"])
    await event.answer()
    await ui.edit_rich_message(event, owner_id=event.sender_id, **message)


async def _fav_add(event, payload):
    was_new, warning = await favourites.add(event.sender_id, payload["n"],
                                            payload["lat"], payload["lon"])
    await event.answer(warning or ("Saved." if was_new else "Already saved."), alert=bool(warning))
    place = {"name": payload["n"], "lat": payload["lat"], "lon": payload["lon"]}
    message = await commands.weather_view(event.sender_id, place, payload.get("v", "current"))
    await ui.edit_rich_message(event, owner_id=event.sender_id, **message)


async def _fav_del(event, payload):
    removed, warning = await favourites.remove(event.sender_id, payload["k"])
    await event.answer(warning or ("Removed." if removed else "It was not on your list."),
                       alert=bool(warning))
    await _fav_list(event, {})


async def _fav_list(event, _payload):
    places = await favourites.listing(event.sender_id)
    if not places:
        await ui.edit_rich_message(
            event,
            title="No saved places yet",
            body="Look up a city and tap Save this place, or send /save Kyoto.",
            owner_id=event.sender_id)
        return

    rows = []
    for place in places:
        flag = weather.flag_from_label(place["name"])
        rows.append([
            {"label": f"{flag} {place['name']}".strip(), "kind": "weather",
             "payload": {"lat": round(place["lat"], 4), "lon": round(place["lon"], 4),
                         "n": place["name"], "v": "current"}},
            {"label": "Remove", "kind": "fav_del", "payload": {"k": place["place_key"]}},
        ])

    linked = await favourites.is_linked(event.sender_id)
    await ui.edit_rich_message(
        event,
        title="Your saved places",
        body=f"{len(places)} saved. Tap one for its weather.",
        footer=("In sync with the web app." if linked else
                "Only on this bot for now. Send /link to share them with the web app."),
        buttons=rows,
        owner_id=event.sender_id)


async def _units_toggle(event, _payload):
    units = await db.get_units(event.sender_id)
    new = "imperial" if units == "metric" else "metric"
    await db.set_units(event.sender_id, new)
    await event.answer(f"Now in {weather.temp_unit(new)}.")
    await ui.edit_rich_message(
        event,
        title="Units changed",
        body=f"Now showing {weather.temp_unit(new)} and {weather.wind_unit(new)}.",
        footer="Send /settings to see everything else.",
        buttons=[[{"label": "Switch again", "kind": "units_toggle", "payload": {}}]],
        owner_id=event.sender_id)


async def _sub_time(event, payload):
    place = {"name": payload["n"], "lat": payload["lat"], "lon": payload["lon"]}
    title, body, fields = await commands.apply_subscription(
        event.client, event.sender_id, None, place, payload["h"], payload["m"])
    await event.answer("Daily digest set.")
    await ui.edit_rich_message(
        event, title=title, body=body, fields=fields,
        footer="Send /unsub to stop it at any time.",
        owner_id=event.sender_id)


async def _link_help(event, _payload):
    await event.answer()
    await commands.send_link_help(event.client, event.chat_id, event.sender_id)


async def _link_code(event, _payload):
    await event.answer()
    await linking.issue_code(event.client, event)


async def _link_resolve(event, payload, approved):
    try:
        title, body, fields = await linking.resolve_token(event, payload["t"], approved)
    except SupabaseError:
        await event.answer("The sync service is not answering. Try again shortly.", alert=True)
        return
    await event.answer("Linked." if approved else "Rejected.")
    await ui.edit_rich_message(
        event, title=title, body=body, fields=fields,
        buttons=[[{"label": "Open the web app", "url": WEB_APP_URL}]] if approved else None,
        owner_id=event.sender_id)


async def _unlink_ask(event, _payload):
    await event.answer()
    await commands.send_unlink_choice(event.client, event.chat_id, event.sender_id)


async def _unlink_confirm(event, payload):
    """Second of two steps. Nothing has been undone yet, and this names exactly
    what the next tap does before it does it."""
    wipe = bool(payload.get("wipe"))
    count = len(await db.list_links(event.sender_id))
    await event.answer()
    await ui.edit_rich_message(
        event,
        title="Are you sure?",
        body=(f"This disconnects {count} browser{'s' if count != 1 else ''} "
              + ("and deletes the shared copy of your saved places. "
                 if wipe else "and leaves the shared copy where it is. ")
              + "Your places stay here in the bot either way."),
        footer="This cannot be undone, though you can link again at any time.",
        buttons=[[{"label": "Yes, unlink and erase it" if wipe else "Yes, unlink",
                   "kind": "unlink_do", "payload": {"wipe": 1 if wipe else 0}}],
                 [{"label": "No, keep the link", "kind": "unlink_cancel", "payload": {}}]],
        owner_id=event.sender_id)


async def _unlink_cancel(event, _payload):
    await event.answer("Nothing changed.")
    await ui.edit_rich_message(
        event,
        title="The link is still there",
        body="Nothing was disconnected and nothing was erased.",
        footer="Send /unlink again whenever you want to.",
        owner_id=event.sender_id)


async def _unlink_do(event, payload):
    count, warning = await linking.unlink(event.sender_id, bool(payload.get("wipe")))
    await event.answer("Unlinked.")
    await ui.edit_rich_message(
        event,
        title="The link is gone" if count else "Nothing was linked",
        body=(f"{count} browser{'s' if count != 1 else ''} stopped sharing favourites. "
              "Your places are still here."),
        footer=warning or "Send /link whenever you want to start syncing again.",
        owner_id=event.sender_id)


# Backup codes are made in the web app. The bot is the approval channel and
# never sees a code, only the request to allow one set to be created.
_REQUEST_GONE = ("That request is no longer open",
                 "It was already answered, or it ran out of time. Nothing was created "
                 "and your existing codes are untouched. Ask again in the web app.")


async def _backup_approve(event, payload):
    try:
        settled = await backup_codes.resolve_request(payload["r"], event.sender_id, True)
    except SupabaseError:
        await event.answer("The sync service is not answering. Try again shortly.", alert=True)
        return

    if not settled:
        await event.answer(_REQUEST_GONE[0], alert=True)
        await ui.edit_rich_message(event, title=_REQUEST_GONE[0], body=_REQUEST_GONE[1],
                                   owner_id=event.sender_id)
        return

    await event.answer("Approved.")
    await ui.edit_rich_message(
        event,
        title="Approved",
        body="The web app can now create the codes and will show them once, in the tab "
             "that asked. They do not pass through this chat.",
        footer="Any unused codes you had before stop working as soon as the new set "
               "appears. If nothing shows up in the browser, ask again there.",
        buttons=[[{"label": "Open the web app", "url": WEB_APP_URL}]],
        owner_id=event.sender_id)


async def _backup_reject(event, payload):
    try:
        settled = await backup_codes.resolve_request(payload["r"], event.sender_id, False)
    except SupabaseError:
        await event.answer("The sync service is not answering. Try again shortly.", alert=True)
        return

    if not settled:
        await event.answer(_REQUEST_GONE[0], alert=True)
        await ui.edit_rich_message(event, title=_REQUEST_GONE[0], body=_REQUEST_GONE[1],
                                   owner_id=event.sender_id)
        return

    await event.answer("Nothing was created.")
    await ui.edit_rich_message(
        event,
        title="Request rejected",
        body="No codes were created and any you already have still work.",
        footer="If that request was not yours, someone has a browser linked to this "
               "account. Lock it down below.",
        buttons=[[{"label": "Disconnect every browser", "kind": "panic", "payload": {}}]],
        owner_id=event.sender_id)


async def _panic(event, _payload):
    """Someone used a backup code that was not this person. Shut the door."""
    count, _warning = await linking.unlink(event.sender_id, False)
    revoked = await backup_codes.revoke(event.sender_id)
    # Any request waiting for a yes dies with the lockdown.
    await backup_codes.cancel_requests(event.sender_id)
    await event.answer("Locked down.")
    await ui.edit_rich_message(
        event,
        title="Locked down",
        body="Every linked browser was disconnected and the unused backup codes were "
             "cancelled. Your saved places are untouched here.",
        fields=[("Browsers disconnected", str(count)),
                ("Codes cancelled", str(revoked))],
        footer="Make a fresh set of backup codes in the web app, then link again.",
        buttons=[[{"label": "Open the web app", "url": WEB_APP_URL}]],
        owner_id=event.sender_id)


async def _wipe_ask(event, _payload):
    await event.answer()
    await ui.edit_rich_message(
        event,
        title="Erase everything?",
        body="Your saved places, your units, your digest and every link would be deleted "
             "here and in the shared copy. This cannot be undone.",
        buttons=[[{"label": "Yes, erase it all", "kind": "wipe_do", "payload": {}}],
                 [{"label": "Keep my data", "kind": "wipe_cancel", "payload": {}}]],
        owner_id=event.sender_id)


async def _wipe_do(event, _payload):
    try:
        await favourites.forget_remote(event.sender_id)
    except SupabaseError:
        log.warning("Could not erase the shared copy for %s", event.sender_id)
    await db.forget_user(event.sender_id)
    await event.answer("Erased.")
    await ui.edit_rich_message(
        event,
        title="All gone",
        body="Nothing about you is left. Send /start whenever you want to begin again.",
        owner_id=event.sender_id)


async def _wipe_cancel(event, _payload):
    await event.answer("Nothing was deleted.")
    await ui.edit_rich_message(
        event, title="Your data is untouched",
        body="Send /settings again if you change your mind.",
        owner_id=event.sender_id)


ROUTES = {
    "weather": _weather,
    "fav_add": _fav_add,
    "fav_del": _fav_del,
    "fav_list": _fav_list,
    "units_toggle": _units_toggle,
    "sub_time": _sub_time,
    "link_help": _link_help,
    "link_code": _link_code,
    "link_approve": lambda e, p: _link_resolve(e, p, True),
    "link_deny": lambda e, p: _link_resolve(e, p, False),
    "backup_approve": _backup_approve,
    "backup_reject": _backup_reject,
    "panic": _panic,
    "unlink_ask": _unlink_ask,
    "unlink_confirm": _unlink_confirm,
    "unlink_cancel": _unlink_cancel,
    "unlink_do": _unlink_do,
    "wipe_ask": _wipe_ask,
    "wipe_do": _wipe_do,
    "wipe_cancel": _wipe_cancel,
}


async def on_callback(event) -> None:
    button_id = event.data.decode("utf-8", "ignore").split(":", 1)[-1]
    row = await db.get_button(button_id)

    if not row:
        # Only possible if the database was replaced under the bot.
        await event.answer("That button is no longer available. Send /start to begin again.",
                           alert=True)
        return
    if row["owner_id"] != event.sender_id:
        await event.answer("That button belongs to someone else.", alert=True)
        return

    handler = ROUTES.get(row["kind"])
    if handler is None:
        await event.answer("That button does something this version no longer knows about.",
                           alert=True)
        return

    try:
        await handler(event, row["payload"])
    except weather.WeatherError as err:
        await event.answer(str(err), alert=True)
    except Exception:
        log.exception("Callback %s failed", row["kind"])
        await event.answer("That did not work. Please try again in a moment.", alert=True)


def register(client) -> None:
    client.add_event_handler(on_callback, events.CallbackQuery(pattern=b"b:"))
