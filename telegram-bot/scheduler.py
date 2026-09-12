"""The scheduler.

Timers live in SQLite rather than in memory, so a restart, a crash or a VPS
reboot loses nothing: the loop simply picks up whatever is due. One tick every
half minute is plenty for a daily digest and costs nothing.
"""

import asyncio
import logging
import time

import db
import ui
import weather
from config import SCHEDULER_TICK_SECONDS, WEB_APP_URL

log = logging.getLogger(__name__)

DAILY_DIGEST = "daily_digest"

# How late a digest may be and still be worth sending.
GRACE_SECONDS = 15 * 60


def next_daily_run(hour: int, minute: int, utc_offset: int, after: float | None = None) -> int:
    """Next moment, in UTC seconds, when the local clock at the saved place
    reads hour:minute. Storing the place's own offset keeps the digest arriving
    at breakfast time even when the person travels."""
    now_utc = after if after is not None else time.time()
    local = now_utc + utc_offset
    day_start = local - (local % 86400)
    target = day_start + hour * 3600 + minute * 60
    if target <= local:
        target += 86400
    return int(target - utc_offset)


async def run(client) -> None:
    while True:
        try:
            for schedule in await db.due_schedules(int(time.time())):
                await _fire(client, schedule)
        except Exception:
            log.exception("Scheduler tick failed")
        await asyncio.sleep(SCHEDULER_TICK_SECONDS)


async def _fire(client, schedule: dict) -> None:
    payload = schedule["payload"]
    telegram_id = schedule["telegram_id"]
    kind = schedule["kind"]

    if kind == DAILY_DIGEST:
        # Reschedule first. A failure to deliver one morning must not stop the
        # following mornings, and it must never leave a row due forever.
        await db.mark_schedule_ran(
            schedule["id"],
            next_daily_run(payload["hour"], payload["minute"], payload.get("offset", 0)),
        )

        # A digest that is hours late is worse than no digest: nobody wants a
        # good morning message in the afternoon because the VPS was down.
        late = time.time() - schedule["next_run_at"]
        if late > GRACE_SECONDS:
            log.info("Skipping a digest for %s, it is %d minutes late",
                     telegram_id, late // 60)
            return

        try:
            await _send_digest(client, telegram_id, payload)
        except Exception:
            log.exception("Could not deliver the digest for %s", telegram_id)
        return

    # A kind this version does not know about is retired rather than left due,
    # which would otherwise have it firing on every tick from now on.
    log.warning("Retiring a schedule of unknown kind %r", kind)
    await db.deactivate_schedule(schedule["id"])


async def _send_digest(client, telegram_id: int, payload: dict) -> None:
    units = await db.get_units(telegram_id)
    data = await weather.forecast(payload["lat"], payload["lon"], units)

    # The place may have moved into or out of daylight saving since it was set.
    offset = data.get("utc_offset_seconds")
    if offset is not None and offset != payload.get("offset"):
        payload = {**payload, "offset": offset}
        await db.upsert_schedule(
            DAILY_DIGEST, telegram_id, payload,
            next_daily_run(payload["hour"], payload["minute"], offset))

    title, body, fields, table = weather.format_digest(data, ui.escape_md(payload["name"]), units)
    await ui.send_rich_message(
        client, telegram_id,
        title=title, body=body, fields=fields, table=table,
        footer="Sent by your daily digest. Send /unsub to stop it.",
        buttons=[[
            {"label": "Next 24 hours", "kind": "weather",
             "payload": {"v": "hourly", "lat": payload["lat"], "lon": payload["lon"],
                         "n": payload["name"]}},
            {"label": "Two hour rain", "kind": "weather",
             "payload": {"v": "nowcast", "lat": payload["lat"], "lon": payload["lon"],
                         "n": payload["name"]}},
        ], [
            {"label": "Open the web app", "url": WEB_APP_URL},
        ]],
        owner_id=telegram_id)
