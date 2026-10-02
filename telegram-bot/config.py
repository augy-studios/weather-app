"""Runtime configuration.

Everything comes from the process environment. A .env file sitting next to this
module is read first as a convenience for VPS deployments, and it never
overrides a variable that is already exported in the shell.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


_load_dotenv(BASE_DIR / ".env")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


# --- Telegram ---
TELEGRAM_API_ID = _int("TELEGRAM_API_ID", 0)
TELEGRAM_API_HASH = os.environ.get("TELEGRAM_API_HASH", "").strip()
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()

# --- Supabase, optional ---
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()

# --- Links ---
DONATION_URL = os.environ.get("DONATION_URL", "").strip() or "https://donate.stripe.com/28o2akeAr3hv0DK6oo"
WEB_APP_URL = (os.environ.get("WEB_APP_URL", "").strip() or "https://weatherapp.today").rstrip("/")

# --- Local storage ---
_db_path = Path(os.environ.get("DB_PATH", "").strip() or "data/bot.db")
DB_PATH = _db_path if _db_path.is_absolute() else BASE_DIR / _db_path
SESSION_PATH = BASE_DIR / "sessions" / "bot"

# --- Behaviour ---
NOTICE_POLL_SECONDS = max(1, _int("NOTICE_POLL_SECONDS", 3))
SCHEDULER_TICK_SECONDS = max(5, _int("SCHEDULER_TICK_SECONDS", 30))
LOG_LEVEL = (os.environ.get("LOG_LEVEL", "").strip() or "INFO").upper()

# Shared with the web app and the API routes. Both sides cap a synced set at
# this many places, so a merge of two full sets stays predictable.
MAX_FAVOURITES = 24

# Table names, kept in one place so the prefix can move without a hunt.
T_LINKS = "uwu_weather_links"
T_TOKENS = "uwu_weather_link_tokens"
T_CODES = "uwu_weather_link_codes"
T_BACKUP = "uwu_weather_backup_codes"
T_BACKUP_REQUESTS = "uwu_weather_backup_requests"
T_NOTICES = "uwu_weather_notices"
T_FAVOURITES = "uwu_weather_favourites"

# How many single use backup codes one batch holds.
BACKUP_CODE_COUNT = 8

SYNC_ENABLED = bool(SUPABASE_URL and SUPABASE_SERVICE_KEY)


def validate() -> list[str]:
    """Return a list of human readable problems, empty when the bot can start."""
    problems = []
    if not TELEGRAM_API_ID:
        problems.append("TELEGRAM_API_ID is missing or not a number.")
    if not TELEGRAM_API_HASH:
        problems.append("TELEGRAM_API_HASH is missing.")
    if not TELEGRAM_BOT_TOKEN:
        problems.append("TELEGRAM_BOT_TOKEN is missing.")
    return problems
