"""Linking a Telegram account to a browser so favourites follow the person.

There is no password and no account table anywhere. A browser holds a random
portal id in its own storage, and a link row simply says which Telegram account
that browser belongs to. Three routes exist into that state, and every one of
them starts with the person, never with a stranger:

1. Deep link. The web app writes a token and opens t.me/<bot>?start=<token>.
   The person confirms here, the web app polls until the token turns claimed.
2. Pull code. The person sends /code, then types the six digits into the site.
   This is the cross device route: nothing has to travel from the laptop to the
   phone, only six digits the other way.
3. Backup code. Telegram itself is out of reach, so one of the single use codes
   made in the web app is typed into the site instead.

Every route ends in the same place: link_browser, which merges the two sets of
favourites so nothing is lost from either side.

The bot also delivers notices the web app leaves for it, which is how someone
finds out that one of their backup codes has been spent.
"""

import asyncio
import logging
import secrets
from datetime import datetime, timedelta, timezone

import db
import favourites
import ui
from config import (NOTICE_POLL_SECONDS, T_CODES, T_FAVOURITES, T_LINKS, T_NOTICES,
                    T_TOKENS, WEB_APP_URL)
from supabase_rest import SupabaseError, supabase

log = logging.getLogger(__name__)

CODE_TTL_MINUTES = 10


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.isoformat()


def _parse(value: str | None) -> datetime | None:
    if not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _is_live(row: dict) -> bool:
    expires = _parse(row.get("expires_at"))
    return expires is None or expires > _now()


def sync_off_message() -> tuple[str, str]:
    return (
        "Syncing is switched off",
        "This bot is running without its Supabase settings, so favourites cannot "
        "travel between here and the web app yet. Everything else works as normal.",
    )


async def link_browser(telegram_id: int, username: str | None, portal_id: str,
                       label: str | None) -> dict:
    """Record the link, then merge the two favourite sets. Returns merge counts."""
    await supabase.insert(T_LINKS, {
        "portal_id": portal_id,
        "telegram_id": telegram_id,
        "telegram_username": (username or "").lower() or None,
        "label": label,
        "updated_at": _iso(_now()),
    }, on_conflict="portal_id")

    await db.add_link(portal_id, telegram_id, label)
    return await favourites.merge(telegram_id)


async def link_summary_fields(telegram_id: int, merged: dict) -> list[tuple[str, str]]:
    devices = await db.list_links(telegram_id)
    return [
        ("Places in sync", str(merged["total"])),
        ("Sent to the web app", str(merged["pushed"])),
        ("Brought in from the web app", str(merged["pulled"])),
        ("Linked browsers", str(len(devices))),
    ]


# --- 1. deep link ----------------------------------------------------------

async def offer_token(client, event, token: str) -> None:
    """Someone tapped the link the web app produced. Ask before trusting it."""
    if not supabase.enabled:
        title, body = sync_off_message()
        await ui.send_rich_message(client, event.chat_id, title=title, body=body)
        return

    try:
        row = await supabase.select_one(T_TOKENS, {"token": f"eq.{token}", "select": "*"})
    except SupabaseError:
        await ui.send_rich_message(
            client, event.chat_id,
            title="The sync service is not answering",
            body="Please try the link again in a minute.")
        return

    if not row or row.get("status") != "pending" or not _is_live(row):
        await ui.send_rich_message(
            client, event.chat_id,
            title="That sync link has expired",
            body="Open the web app and start the sync again, or send /code to type a "
                 "six digit code into the site instead.",
            buttons=[[{"label": "Open the web app", "url": WEB_APP_URL}]],
            owner_id=event.sender_id)
        return

    requested = _parse(row.get("created_at"))
    label = row.get("label") or "a browser"
    await ui.send_rich_message(
        client, event.chat_id,
        title="Sync request",
        body=f"{ui.escape_md(label)} is asking to share favourites with this account.",
        fields=[("Requested", requested.strftime("%H:%M UTC") if requested else "just now")],
        footer="Approve only if this was you.",
        buttons=[[
            {"label": "Approve", "kind": "link_approve", "payload": {"t": token}},
            {"label": "Reject", "kind": "link_deny", "payload": {"t": token}},
        ]],
        owner_id=event.sender_id)


async def resolve_token(event, token: str, approved: bool) -> tuple[str, str, list]:
    row = await supabase.select_one(T_TOKENS, {"token": f"eq.{token}", "select": "*"})
    if not row or row.get("status") != "pending" or not _is_live(row):
        return "That sync link has expired", "Start the sync again from the web app.", []

    if not approved:
        await supabase.update(T_TOKENS, {"token": f"eq.{token}"}, {
            "status": "denied", "resolved_at": _iso(_now())})
        return ("Sync rejected",
                "Nothing was shared. If this was not you, no action is needed.", [])

    sender = await event.get_sender()
    merged = await link_browser(event.sender_id, getattr(sender, "username", None),
                                row["portal_id"], row.get("label"))
    await supabase.update(T_TOKENS, {"token": f"eq.{token}"}, {
        "status": "claimed",
        "telegram_id": event.sender_id,
        "resolved_at": _iso(_now()),
    })
    return ("Favourites are in sync",
            "The browser is linked to this account. Saving a place on either side now "
            "shows up on the other.",
            await link_summary_fields(event.sender_id, merged))


# --- 2. pull code ----------------------------------------------------------

async def issue_code(client, event) -> None:
    if not supabase.enabled:
        title, body = sync_off_message()
        await ui.send_rich_message(client, event.chat_id, title=title, body=body)
        return

    sender = await event.get_sender()
    code = await _issue_unique_code(event.sender_id, getattr(sender, "username", None))
    if code is None:
        await ui.send_rich_message(
            client, event.chat_id,
            title="The sync service is not answering",
            body="Please try again in a minute.")
        return

    await ui.send_rich_message(
        client, event.chat_id,
        title="Your sync code",
        body=f"`{code[:3]} {code[3:]}`",
        fields=[("Valid for", f"{CODE_TTL_MINUTES} minutes")],
        footer="Type it into the sync panel on the web app. Never share it with anyone.",
        buttons=[[{"label": "Open the web app", "url": WEB_APP_URL}]],
        owner_id=event.sender_id)


async def _issue_unique_code(telegram_id: int, username: str | None) -> str | None:
    """Six digits are short enough to type and long enough for a ten minute life.

    Any earlier code for this person is dropped first so only one is ever live,
    then a free code is claimed. The code column is the primary key, so a clash
    with another person's live code simply fails and is retried.
    """
    expires = _now() + timedelta(minutes=CODE_TTL_MINUTES)
    try:
        await supabase.delete(T_CODES, {"telegram_id": f"eq.{telegram_id}",
                                        "status": "eq.pending"})
    except SupabaseError:
        return None

    for _ in range(6):
        code = f"{secrets.randbelow(1000000):06d}"
        try:
            await supabase.insert(T_CODES, {
                "code": code,
                "telegram_id": telegram_id,
                "telegram_username": (username or "").lower() or None,
                "status": "pending",
                "expires_at": _iso(expires),
            })
            return code
        except SupabaseError:
            continue
    return None


# --- notices the web app leaves behind -------------------------------------

async def watch_for_notices(client) -> None:
    """Deliver messages the web app queued for this bot.

    The web app cannot reach Telegram, so it writes a row and this loop passes
    it on. Polling keeps the bot free of any inbound network surface, which
    matters on a VPS behind a firewall.
    """
    if not supabase.enabled:
        return

    while True:
        try:
            rows = await supabase.select(T_NOTICES, {
                "status": "eq.pending",
                "select": "*",
                "order": "created_at.asc",
                "limit": "20",
            })
            for row in rows:
                await _deliver_notice(client, row)
        except SupabaseError as err:
            log.warning("Notice poll failed: %s", err)
        except Exception:  # keep the loop alive whatever happens
            log.exception("Unexpected error while polling for notices")

        await asyncio.sleep(NOTICE_POLL_SECONDS)


async def _deliver_notice(client, notice: dict) -> None:
    """Chiefly the backup code alarm. Anything unrecognised is delivered as
    plain text so a future notice kind does not need a bot release."""
    data = notice.get("data") or {}
    telegram_id = notice.get("telegram_id")
    buttons = None

    if notice.get("kind") == "backup_request":
        # The web app wants to create a set of backup codes. It cannot until
        # this is approved, and the codes themselves never come through here.
        left = data.get("remaining")
        title = "Approve new backup codes"
        body = (f"{ui.escape_md(data.get('label') or 'A browser')} is asking to create a new set "
                "of backup codes for this account.")
        fields = [("Unused codes right now", str(left) if left else "none"),
                  ("If you approve", "the web app shows the new codes once, in the tab "
                   "that asked" + (", and your current unused codes stop working"
                                   if left else ""))]
        footer = ("This request lapses in ten minutes. Approve only if you asked for it "
                  "just now, in a browser you are looking at.")
        buttons = [[
            {"label": "Approve", "kind": "backup_approve",
             "payload": {"r": data.get("request_id")}},
            {"label": "Reject", "kind": "backup_reject",
             "payload": {"r": data.get("request_id")}},
        ]]
    elif notice.get("kind") == "backup_used":
        left = data.get("remaining")
        title = "A backup code was used"
        body = (f"{ui.escape_md(data.get('label') or 'A browser')} used one of your backup codes "
                "to load your saved places.")
        fields = [("Codes left", str(left) if left is not None else "unknown")]
        footer = ("If that was you, nothing to do. If it was not, lock it down below and "
                  "make a fresh set in the web app.")
        buttons = [[{"label": "That was not me", "kind": "panic", "payload": {}}]]
    else:
        title = ui.escape_md(data.get("title") or "A message about your account")
        body = ui.escape_md(data.get("text") or "")
        fields = []
        footer = None

    try:
        await ui.send_rich_message(client, telegram_id, title=title, body=body,
                                   fields=fields, footer=footer, buttons=buttons,
                                   owner_id=telegram_id)
    except Exception as err:
        log.warning("Could not deliver notice %s to %s: %s", notice["id"], telegram_id, err)
        await supabase.update(T_NOTICES, {"id": f"eq.{notice['id']}"}, {"status": "failed"})
        return

    await supabase.update(T_NOTICES, {"id": f"eq.{notice['id']}"},
                          {"status": "sent", "sent_at": _iso(_now())})


# --- unlinking -------------------------------------------------------------

async def unlink(telegram_id: int, wipe_remote: bool) -> tuple[int, str | None]:
    """Drop every linked browser. Returns (count, warning)."""
    devices = await db.list_links(telegram_id)
    warning = None
    if supabase.enabled:
        try:
            await supabase.delete(T_LINKS, {"telegram_id": f"eq.{telegram_id}"})
            if wipe_remote:
                await supabase.delete(T_FAVOURITES, {"telegram_id": f"eq.{telegram_id}"})
        except SupabaseError:
            warning = "The web app could not be reached, so it may still show the link " \
                      "for a short while."
    await db.clear_links(telegram_id)
    return len(devices), warning
