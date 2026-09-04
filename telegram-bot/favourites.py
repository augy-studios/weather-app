"""Favourite places, local first and synced when the account is linked.

SQLite is always written, so the bot keeps working when Supabase is down or was
never configured. When a link exists, Supabase holds the shared set that the web
app reads, and the local table is a mirror of it.
"""

import logging
from datetime import datetime, timezone

import db
from config import MAX_FAVOURITES, T_BACKUP, T_FAVOURITES, T_LINKS
from supabase_rest import SupabaseError, supabase

log = logging.getLogger(__name__)


def _round(value) -> float:
    return round(float(value), 4)


async def is_linked(telegram_id: int) -> bool:
    return bool(await db.list_links(telegram_id))


def _as_place(row: dict) -> dict:
    return {"name": row["name"], "lat": float(row["lat"]), "lon": float(row["lon"]),
            "place_key": db.place_key(row["lat"], row["lon"]),
            "created_at": row.get("created_at")}


async def _remote_rows(telegram_id: int) -> list[dict]:
    """Every row, tombstones included. A removal is a deleted_at stamp rather
    than a deleted row, so a device holding a stale copy cannot push a place
    back after someone else removed it."""
    return await supabase.select(T_FAVOURITES, {
        "telegram_id": f"eq.{telegram_id}",
        "select": "name,lat,lon,created_at,deleted_at",
        "order": "created_at.asc",
    })


async def _remote_list(telegram_id: int) -> list[dict]:
    rows = await supabase.select(T_FAVOURITES, {
        "telegram_id": f"eq.{telegram_id}",
        "deleted_at": "is.null",
        "select": "name,lat,lon,created_at",
        "order": "created_at.asc",
    })
    return [_as_place(r) for r in rows]


async def listing(telegram_id: int) -> list[dict]:
    """The set to show. Pulls from Supabase when linked, falling back to local."""
    if supabase.enabled and await is_linked(telegram_id):
        try:
            remote = await _remote_list(telegram_id)
            await db.replace_favourites(telegram_id, remote)
            return await db.list_favourites(telegram_id)
        except SupabaseError as err:
            log.warning("Falling back to the local favourites for %s: %s", telegram_id, err)
    return await db.list_favourites(telegram_id)


async def add(telegram_id: int, name: str, lat: float, lon: float) -> tuple[bool, str | None]:
    """Returns (was_new, warning)."""
    current = await db.list_favourites(telegram_id)
    key = db.place_key(lat, lon)
    if len(current) >= MAX_FAVOURITES and not any(p["place_key"] == key for p in current):
        return False, f"You already have {MAX_FAVOURITES} places saved. Remove one first."

    was_new = await db.add_favourite(telegram_id, name, lat, lon)

    if supabase.enabled and await is_linked(telegram_id):
        try:
            await supabase.insert(T_FAVOURITES, {
                "telegram_id": telegram_id,
                "name": name,
                "lat": _round(lat),
                "lon": _round(lon),
                # Saving a place again brings it back from a tombstone.
                "deleted_at": None,
            }, on_conflict="telegram_id,lat,lon")
        except SupabaseError:
            return was_new, "Saved here, but the web app could not be reached to sync it."
    return was_new, None


async def remove(telegram_id: int, key: str) -> tuple[bool, str | None]:
    places = await db.list_favourites(telegram_id)
    target = next((p for p in places if p["place_key"] == key), None)
    removed = await db.remove_favourite(telegram_id, key)

    if removed and target and supabase.enabled and await is_linked(telegram_id):
        try:
            await supabase.update(T_FAVOURITES, {
                "telegram_id": f"eq.{telegram_id}",
                "lat": f"eq.{_round(target['lat'])}",
                "lon": f"eq.{_round(target['lon'])}",
                "deleted_at": "is.null",
            }, {"deleted_at": datetime.now(timezone.utc).isoformat()})
        except SupabaseError:
            return removed, "Removed here, but the web app could not be reached to sync it."
    return removed, None


async def merge(telegram_id: int) -> dict:
    """Union the local set with the synced set, keeping both sides whole.

    This runs the moment an account is linked, which is the point at which one
    person's phone favourites and browser favourites first meet.
    """
    local = await db.list_favourites(telegram_id)
    if not supabase.enabled:
        return {"total": len(local), "pushed": 0, "pulled": 0}

    rows = await _remote_rows(telegram_id)
    remote = [_as_place(r) for r in rows if not r.get("deleted_at")]
    # Places someone removed elsewhere stay removed. Without this the merge
    # would quietly undo a deletion, which is the one thing it can lose.
    buried = {db.place_key(r["lat"], r["lon"]) for r in rows if r.get("deleted_at")}

    by_key = {db.place_key(p["lat"], p["lon"]): p for p in remote}
    for place in local:  # local wins on the label, it is the newer edit
        key = db.place_key(place["lat"], place["lon"])
        if key in buried:
            continue
        by_key[key] = place

    merged = list(by_key.values())[:MAX_FAVOURITES]
    remote_keys = {db.place_key(p["lat"], p["lon"]) for p in remote}
    local_keys = {p["place_key"] for p in local}

    to_push = [p for p in merged if db.place_key(p["lat"], p["lon"]) not in remote_keys]
    if to_push:
        await supabase.insert(T_FAVOURITES, [
            {
                "telegram_id": telegram_id,
                "name": p["name"],
                "lat": _round(p["lat"]),
                "lon": _round(p["lon"]),
                "deleted_at": None,
            }
            for p in to_push
        ], on_conflict="telegram_id,lat,lon")

    await db.replace_favourites(telegram_id, merged)
    pulled = len([p for p in merged if db.place_key(p["lat"], p["lon"]) not in local_keys])
    return {"total": len(merged), "pushed": len(to_push), "pulled": pulled}


async def forget_remote(telegram_id: int) -> None:
    """Erase the synced copy, the links and the backup codes.

    Behind Erase everything about me, in /settings.
    """
    if not supabase.enabled:
        return
    for table in (T_FAVOURITES, T_LINKS, T_BACKUP):
        await supabase.delete(table, {"telegram_id": f"eq.{telegram_id}"})
