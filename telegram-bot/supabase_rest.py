"""A very small PostgREST client.

The web app already talks to Supabase over plain REST rather than pulling in
supabase-js, so the bot does the same with httpx. Only the handful of verbs the
linking flows need are implemented.

The service key bypasses row level security, so this module must only ever run
on the VPS, never anywhere a browser can reach it.
"""

import logging

import httpx

from config import SUPABASE_SERVICE_KEY, SUPABASE_URL, SYNC_ENABLED

log = logging.getLogger(__name__)


class SupabaseError(RuntimeError):
    pass


class Supabase:
    def __init__(self) -> None:
        self.enabled = SYNC_ENABLED
        self._client: httpx.AsyncClient | None = None

    async def start(self) -> None:
        if not self.enabled:
            log.warning(
                "SUPABASE_URL or SUPABASE_SERVICE_KEY is unset, favourite syncing is off."
            )
            return
        self._client = httpx.AsyncClient(
            base_url=f"{SUPABASE_URL}/rest/v1",
            timeout=httpx.Timeout(15.0),
            headers={
                "apikey": SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "return=representation",
            },
        )

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()

    async def _request(self, method: str, table: str, **kwargs) -> list[dict]:
        if not self.enabled or self._client is None:
            raise SupabaseError("Syncing is not configured on this bot.")
        res = await self._client.request(method, f"/{table}", **kwargs)
        if res.status_code >= 400:
            log.error("Supabase %s %s failed: %s %s", method, table, res.status_code, res.text)
            raise SupabaseError(f"Supabase replied {res.status_code}")
        if not res.content:
            return []
        body = res.json()
        return body if isinstance(body, list) else [body]

    async def select(self, table: str, params: dict) -> list[dict]:
        return await self._request("GET", table, params=params)

    async def select_one(self, table: str, params: dict) -> dict | None:
        rows = await self.select(table, {**params, "limit": "1"})
        return rows[0] if rows else None

    async def insert(self, table: str, rows: dict | list[dict],
                     on_conflict: str | None = None) -> list[dict]:
        headers = {}
        params = {}
        if on_conflict:
            headers["Prefer"] = "return=representation,resolution=merge-duplicates"
            params["on_conflict"] = on_conflict
        return await self._request("POST", table, json=rows, headers=headers, params=params)

    async def update(self, table: str, params: dict, patch: dict) -> list[dict]:
        return await self._request("PATCH", table, params=params, json=patch)

    async def delete(self, table: str, params: dict) -> list[dict]:
        return await self._request("DELETE", table, params=params)


supabase = Supabase()
