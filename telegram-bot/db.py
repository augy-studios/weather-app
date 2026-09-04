"""SQLite storage.

Holds four things:

* per user preferences and a mirror of their favourite places,
* the button registry, so an inline button keeps working forever, including
  across restarts and redeploys,
* the schedule queue that drives the daily digest,
* small key value scratch space for poll cursors.

One connection for the whole process, in WAL mode, guarded by a lock because
Telethon dispatches handlers concurrently.
"""

import asyncio
import json
import secrets
import time

import aiosqlite

from config import DB_PATH

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    telegram_id   INTEGER PRIMARY KEY,
    units         TEXT    NOT NULL DEFAULT 'metric',
    default_name  TEXT,
    default_lat   REAL,
    default_lon   REAL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS favourites (
    telegram_id INTEGER NOT NULL,
    place_key   TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    lat         REAL    NOT NULL,
    lon         REAL    NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (telegram_id, place_key)
);

-- Mirror of the remote link rows. A person may sync several browsers, so one
-- Telegram account can own several portal ids.
CREATE TABLE IF NOT EXISTS links (
    portal_id   TEXT    PRIMARY KEY,
    telegram_id INTEGER NOT NULL,
    label       TEXT,
    linked_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS links_telegram_id ON links (telegram_id);

-- Every inline button ever sent. Rows are never deleted, which is what keeps
-- an old message's buttons answerable after a restart.
CREATE TABLE IF NOT EXISTS buttons (
    id         TEXT    PRIMARY KEY,
    owner_id   INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    payload    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS buttons_dedupe ON buttons (owner_id, kind, payload);

CREATE TABLE IF NOT EXISTS schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT    NOT NULL,
    telegram_id INTEGER NOT NULL,
    payload     TEXT    NOT NULL,
    next_run_at INTEGER NOT NULL,
    last_run_at INTEGER,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules (active, next_run_at);

CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

_conn: aiosqlite.Connection | None = None
_lock = asyncio.Lock()


def now() -> int:
    return int(time.time())


def place_key(lat: float, lon: float) -> str:
    """Stable identity for a place. Four decimals is about eleven metres, which
    is far tighter than any geocoder disagreement between the bot and the site."""
    return f"{round(float(lat), 4):.4f},{round(float(lon), 4):.4f}"


async def connect() -> None:
    global _conn
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    _conn = await aiosqlite.connect(DB_PATH)
    _conn.row_factory = aiosqlite.Row
    await _conn.executescript(SCHEMA)
    await _conn.commit()


async def close() -> None:
    if _conn is not None:
        await _conn.close()


async def _run(sql: str, args: tuple = ()) -> None:
    async with _lock:
        await _conn.execute(sql, args)
        await _conn.commit()


async def _all(sql: str, args: tuple = ()) -> list[aiosqlite.Row]:
    async with _lock:
        cur = await _conn.execute(sql, args)
        rows = await cur.fetchall()
        await cur.close()
        return rows


async def _one(sql: str, args: tuple = ()) -> aiosqlite.Row | None:
    rows = await _all(sql, args)
    return rows[0] if rows else None


# --- users -----------------------------------------------------------------

async def ensure_user(telegram_id: int) -> aiosqlite.Row:
    await _run(
        "INSERT INTO users (telegram_id, created_at, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT (telegram_id) DO NOTHING",
        (telegram_id, now(), now()),
    )
    return await _one("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,))


async def get_units(telegram_id: int) -> str:
    row = await ensure_user(telegram_id)
    return row["units"] or "metric"


async def set_units(telegram_id: int, units: str) -> None:
    await ensure_user(telegram_id)
    await _run(
        "UPDATE users SET units = ?, updated_at = ? WHERE telegram_id = ?",
        (units, now(), telegram_id),
    )


async def get_default_place(telegram_id: int) -> dict | None:
    row = await ensure_user(telegram_id)
    if row["default_lat"] is None:
        return None
    return {"name": row["default_name"], "lat": row["default_lat"], "lon": row["default_lon"]}


async def set_default_place(telegram_id: int, name: str, lat: float, lon: float) -> None:
    await ensure_user(telegram_id)
    await _run(
        "UPDATE users SET default_name = ?, default_lat = ?, default_lon = ?, updated_at = ? "
        "WHERE telegram_id = ?",
        (name, lat, lon, now(), telegram_id),
    )


# --- favourites ------------------------------------------------------------

async def list_favourites(telegram_id: int) -> list[dict]:
    rows = await _all(
        "SELECT name, lat, lon, place_key, created_at FROM favourites "
        "WHERE telegram_id = ? ORDER BY created_at ASC",
        (telegram_id,),
    )
    return [dict(r) for r in rows]


async def add_favourite(telegram_id: int, name: str, lat: float, lon: float,
                        created_at: int | None = None) -> bool:
    """True when the place was new to this account."""
    existing = await _one(
        "SELECT 1 FROM favourites WHERE telegram_id = ? AND place_key = ?",
        (telegram_id, place_key(lat, lon)),
    )
    await _run(
        "INSERT INTO favourites (telegram_id, place_key, name, lat, lon, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?) "
        "ON CONFLICT (telegram_id, place_key) DO UPDATE SET name = excluded.name",
        (telegram_id, place_key(lat, lon), name, float(lat), float(lon), created_at or now()),
    )
    return existing is None


async def remove_favourite(telegram_id: int, key: str) -> bool:
    async with _lock:
        cur = await _conn.execute(
            "DELETE FROM favourites WHERE telegram_id = ? AND place_key = ?",
            (telegram_id, key),
        )
        await _conn.commit()
        return cur.rowcount > 0


async def replace_favourites(telegram_id: int, places: list[dict]) -> None:
    """Overwrite the local mirror with the authoritative synced set.

    Order comes from the list itself, not from any timestamp the caller happens
    to be carrying. The mirror's one job is to reproduce the order the account
    gave back, and the rows arriving from Supabase carry ISO strings rather than
    the epoch seconds this column holds.
    """
    base = now()
    async with _lock:
        await _conn.execute("DELETE FROM favourites WHERE telegram_id = ?", (telegram_id,))
        await _conn.executemany(
            "INSERT OR REPLACE INTO favourites "
            "(telegram_id, place_key, name, lat, lon, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            [
                (
                    telegram_id,
                    place_key(p["lat"], p["lon"]),
                    p["name"],
                    float(p["lat"]),
                    float(p["lon"]),
                    base + index,
                )
                for index, p in enumerate(places)
            ],
        )
        await _conn.commit()


# --- links -----------------------------------------------------------------

async def add_link(portal_id: str, telegram_id: int, label: str | None) -> None:
    await _run(
        "INSERT INTO links (portal_id, telegram_id, label, linked_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT (portal_id) DO UPDATE SET telegram_id = excluded.telegram_id, "
        "label = excluded.label, linked_at = excluded.linked_at",
        (portal_id, telegram_id, label, now()),
    )


async def list_links(telegram_id: int) -> list[dict]:
    rows = await _all(
        "SELECT portal_id, label, linked_at FROM links WHERE telegram_id = ? ORDER BY linked_at DESC",
        (telegram_id,),
    )
    return [dict(r) for r in rows]


async def clear_links(telegram_id: int) -> int:
    async with _lock:
        cur = await _conn.execute("DELETE FROM links WHERE telegram_id = ?", (telegram_id,))
        await _conn.commit()
        return cur.rowcount


# --- buttons ---------------------------------------------------------------

async def register_button(owner_id: int, kind: str, payload: dict) -> str:
    """Store a button action and return its short id.

    Identical actions for the same person reuse a row, so a chatty user does
    not grow the table without bound, and an old message keeps resolving to the
    same action it was sent with.
    """
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    row = await _one(
        "SELECT id FROM buttons WHERE owner_id = ? AND kind = ? AND payload = ?",
        (owner_id, kind, blob),
    )
    if row:
        return row["id"]
    button_id = secrets.token_hex(8)
    await _run(
        "INSERT INTO buttons (id, owner_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
        (button_id, owner_id, kind, blob, now()),
    )
    return button_id


async def get_button(button_id: str) -> dict | None:
    row = await _one("SELECT * FROM buttons WHERE id = ?", (button_id,))
    if not row:
        return None
    return {
        "id": row["id"],
        "owner_id": row["owner_id"],
        "kind": row["kind"],
        "payload": json.loads(row["payload"]),
    }


# --- schedules -------------------------------------------------------------

async def upsert_schedule(kind: str, telegram_id: int, payload: dict, next_run_at: int) -> None:
    """One schedule of a given kind per person. Setting a new time replaces the
    old one rather than stacking a second digest."""
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    row = await _one(
        "SELECT id FROM schedules WHERE kind = ? AND telegram_id = ?", (kind, telegram_id)
    )
    if row:
        await _run(
            "UPDATE schedules SET payload = ?, next_run_at = ?, active = 1 WHERE id = ?",
            (blob, next_run_at, row["id"]),
        )
        return
    await _run(
        "INSERT INTO schedules (kind, telegram_id, payload, next_run_at, active, created_at) "
        "VALUES (?, ?, ?, ?, 1, ?)",
        (kind, telegram_id, blob, next_run_at, now()),
    )


async def deactivate_schedule(schedule_id: int) -> None:
    await _run("UPDATE schedules SET active = 0, last_run_at = ? WHERE id = ?",
               (now(), schedule_id))


async def get_schedule(kind: str, telegram_id: int) -> dict | None:
    row = await _one(
        "SELECT * FROM schedules WHERE kind = ? AND telegram_id = ? AND active = 1",
        (kind, telegram_id),
    )
    if not row:
        return None
    return {**dict(row), "payload": json.loads(row["payload"])}


async def cancel_schedule(kind: str, telegram_id: int) -> bool:
    async with _lock:
        cur = await _conn.execute(
            "UPDATE schedules SET active = 0 WHERE kind = ? AND telegram_id = ? AND active = 1",
            (kind, telegram_id),
        )
        await _conn.commit()
        return cur.rowcount > 0


async def due_schedules(at: int) -> list[dict]:
    rows = await _all(
        "SELECT * FROM schedules WHERE active = 1 AND next_run_at <= ? ORDER BY next_run_at ASC",
        (at,),
    )
    return [{**dict(r), "payload": json.loads(r["payload"])} for r in rows]


async def mark_schedule_ran(schedule_id: int, next_run_at: int) -> None:
    await _run(
        "UPDATE schedules SET last_run_at = ?, next_run_at = ? WHERE id = ?",
        (now(), next_run_at, schedule_id),
    )


# --- key value -------------------------------------------------------------

async def kv_get(key: str, default: str | None = None) -> str | None:
    row = await _one("SELECT value FROM kv WHERE key = ?", (key,))
    return row["value"] if row else default


async def kv_set(key: str, value: str) -> None:
    await _run(
        "INSERT INTO kv (key, value) VALUES (?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


async def forget_user(telegram_id: int) -> None:
    """Erase every local trace of one person, used by the privacy command."""
    async with _lock:
        for sql in (
            "DELETE FROM favourites WHERE telegram_id = ?",
            "DELETE FROM links WHERE telegram_id = ?",
            "DELETE FROM schedules WHERE telegram_id = ?",
            "DELETE FROM buttons WHERE owner_id = ?",
            "DELETE FROM users WHERE telegram_id = ?",
        ):
            await _conn.execute(sql, (telegram_id,))
        await _conn.commit()
