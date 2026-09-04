"""Backup codes, from the bot's side of the fence.

Codes are created in the web app and shown there. This bot never sees one. Its
job is the approval: the web app records a request, the bot delivers it, and a
tap here is what allows the set to be created.

That split is the point. Someone holding a linked browser cannot mint a way in
without the Telegram account agreeing, and someone holding the Telegram account
never has the codes read out to them in a chat.
"""

import logging
from datetime import datetime, timezone

from config import T_BACKUP, T_BACKUP_REQUESTS
from supabase_rest import supabase

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def remaining(telegram_id: int) -> int:
    if not supabase.enabled:
        return 0
    rows = await supabase.select(T_BACKUP, {
        "telegram_id": f"eq.{telegram_id}",
        "used_at": "is.null",
        "select": "id",
    })
    return len(rows)


async def resolve_request(request_id: str, telegram_id: int, approved: bool) -> bool:
    """Answer one request, once. True when this tap is the one that settled it.

    The filter carries the whole rule: the row must still be pending, must
    belong to this account, and must not have lapsed. Postgres applies all of
    that in a single statement, so two taps arriving together cannot both win,
    and an old button cannot revive a request that is long gone.
    """
    rows = await supabase.update(
        T_BACKUP_REQUESTS,
        {
            "id": f"eq.{request_id}",
            "telegram_id": f"eq.{telegram_id}",
            "status": "eq.pending",
            "expires_at": f"gt.{_now_iso()}",
        },
        {
            "status": "approved" if approved else "rejected",
            "resolved_at": _now_iso(),
        },
    )
    return bool(rows)


async def cancel_requests(telegram_id: int) -> int:
    """Reject anything still waiting, used when someone locks their account down."""
    if not supabase.enabled:
        return 0
    rows = await supabase.update(
        T_BACKUP_REQUESTS,
        {"telegram_id": f"eq.{telegram_id}", "status": "eq.pending"},
        {"status": "rejected", "resolved_at": _now_iso()},
    )
    return len(rows)


async def revoke(telegram_id: int) -> int:
    """Drop every unused code, used when a sync goes wrong."""
    if not supabase.enabled:
        return 0
    rows = await supabase.delete(T_BACKUP, {
        "telegram_id": f"eq.{telegram_id}",
        "used_at": "is.null",
    })
    return len(rows)
