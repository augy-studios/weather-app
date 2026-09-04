"""Message presentation.

Everything the bot says goes out through send_rich_message, so replies share one
shape: a bold title, a short body, an optional list of label and value fields, a
quiet footer, and buttons underneath.

Buttons are described as plain data and stored in SQLite before they are sent.
The callback payload is only the row id, so a button tapped a year from now
still resolves to the action it was created with, restarts included.
"""

import html

from telethon import Button
from telethon.errors import MessageNotModifiedError

import db

MAX_LENGTH = 4000  # Telegram allows 4096, this leaves room for the footer.


def esc(text) -> str:
    return html.escape(str(text), quote=False)


def render(title: str | None, body: str | None = None,
           fields: list[tuple[str, str]] | None = None,
           footer: str | None = None) -> str:
    parts = []
    if title:
        parts.append(f"<b>{title}</b>")
    if body:
        parts.append(body)
    if fields:
        parts.append("\n".join(f"<b>{esc(label)}:</b> {value}" for label, value in fields))
    if footer:
        parts.append(f"<i>{footer}</i>")
    text = "\n\n".join(parts)
    if len(text) > MAX_LENGTH:
        text = text[:MAX_LENGTH].rsplit("\n", 1)[0] + "\n<i>Trimmed to fit one message.</i>"
    return text


async def build_buttons(owner_id: int, spec: list[list[dict]] | None):
    """Turn rows of plain dicts into Telethon buttons.

    Each dict is either {"label", "url"} for a link, or {"label", "kind",
    "payload"} for an action this bot handles.
    """
    if not spec:
        return None
    rows = []
    for row in spec:
        built = []
        for item in row:
            if not item:
                continue
            if item.get("url"):
                built.append(Button.url(item["label"], item["url"]))
                continue
            button_id = await db.register_button(owner_id, item["kind"], item.get("payload") or {})
            built.append(Button.inline(item["label"], data=f"b:{button_id}".encode()))
        if built:
            rows.append(built)
    return rows or None


async def send_rich_message(client, entity, *, title=None, body=None, fields=None,
                            footer=None, buttons=None, owner_id=None, reply_to=None):
    """Send one formatted message. `buttons` is the plain data form above."""
    markup = await build_buttons(owner_id if owner_id is not None else _peer_id(entity), buttons)
    return await client.send_message(
        entity,
        render(title, body, fields, footer),
        parse_mode="html",
        buttons=markup,
        link_preview=False,
        reply_to=reply_to,
    )


async def edit_rich_message(event, *, title=None, body=None, fields=None,
                            footer=None, buttons=None, owner_id=None):
    """Replace the message a button lives on, keeping the conversation tidy."""
    markup = await build_buttons(owner_id if owner_id is not None else event.sender_id, buttons)
    try:
        return await event.edit(
            render(title, body, fields, footer),
            parse_mode="html",
            buttons=markup,
            link_preview=False,
        )
    except MessageNotModifiedError:
        # Tapping a button that leads back to the same view is not an error.
        return None


def _peer_id(entity) -> int:
    """Buttons are owned by the person they were sent to, so a chat id doubles
    as the owner id in a private chat."""
    if isinstance(entity, int):
        return entity
    return getattr(entity, "id", 0) or 0
