"""Entry point.

Run it inside tmux on the VPS:

    tmux new -s weatherbot
    cd ~/weather-app/telegram-bot && source .venv/bin/activate && python bot.py

Detach with ctrl-b then d. See README.md for the rest.
"""

import asyncio
import logging
import sys

from telethon import TelegramClient

import callbacks
import commands
import config
import db
import linking
import scheduler
import weather
from supabase_rest import supabase

log = logging.getLogger("bot")


def setup_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL, logging.INFO),
        format="%(asctime)s  %(levelname)-7s %(name)s  %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    # Telethon is chatty about network churn that says nothing useful here.
    logging.getLogger("telethon").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)


async def main() -> int:
    setup_logging()

    problems = config.validate()
    if problems:
        for problem in problems:
            log.error(problem)
        log.error("Copy .env.example to .env and fill it in, then start again.")
        return 1

    config.SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)

    await db.connect()
    await weather.start()
    await supabase.start()

    client = TelegramClient(str(config.SESSION_PATH),
                            config.TELEGRAM_API_ID, config.TELEGRAM_API_HASH)
    await client.start(bot_token=config.TELEGRAM_BOT_TOKEN)

    me = await client.get_me()
    commands.register(client)
    callbacks.register(client)

    background = [
        asyncio.create_task(scheduler.run(client), name="scheduler"),
        asyncio.create_task(linking.watch_for_notices(client), name="notices"),
    ]

    log.info("Running as @%s, syncing is %s, database at %s",
             me.username, "on" if supabase.enabled else "off", config.DB_PATH)

    try:
        await client.run_until_disconnected()
    finally:
        for task in background:
            task.cancel()
        await asyncio.gather(*background, return_exceptions=True)
        await client.disconnect()
        await weather.close()
        await supabase.close()
        await db.close()
        log.info("Stopped cleanly.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        sys.exit(0)
