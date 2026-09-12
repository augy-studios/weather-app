"""Message presentation.

Everything the bot says goes out through send_rich_message, so replies share one
shape: a heading, a short body, an optional list of label and value fields, an
optional table, a quiet footer, and buttons underneath.

Each message is built twice from the same parts: once as Telegram Rich Markdown
(headings, bold, bullet lists, pipe tables) and once as plain text. reply.py
sends the pair as a genuine Rich Message, with the plain text as the fallback
older clients see.

Buttons are described as plain data and stored in SQLite before they are sent.
The callback payload is only the row id, so a button tapped a year from now
still resolves to the action it was created with, restarts included.
"""

import re

from telethon import Button

import db
import reply

MAX_LENGTH = 4000  # Telegram allows 4096, this leaves room for the footer.

_MD_SPECIAL = re.compile(r"([\\*_~`|\[\]#>=])")
# Anything left unescaped after escape_md is markup we authored ourselves, so
# the plain fallback simply drops it and unescapes the rest.
_INLINE_MD = re.compile(r"\\(.)|[*_`]")


def escape_md(text) -> str:
    """Escape user/data text for Telegram's Rich Markdown dialect."""
    return _MD_SPECIAL.sub(r"\\\1", str(text))


def escape_cell(text) -> str:
    """Escape for a GFM table cell; also flattens newlines so the row stays intact."""
    return escape_md(str(text).replace("\n", " "))


def to_plain(markdown: str) -> str:
    """The same words with the inline markup taken back out."""
    return _INLINE_MD.sub(lambda m: m.group(1) or "", markdown)


def _table_md(headers: list[str], rows: list[list]) -> str:
    """A pipe table with a blank first header cell: the first value of every
    row is its label."""
    lines = ["| " + " | ".join(["", *headers]) + " |",
             "| " + " | ".join(["---"] * (len(headers) + 1)) + " |"]
    for row in rows:
        lines.append("| " + " | ".join(escape_cell(v) for v in row) + " |")
    return "\n".join(lines)


def _table_plain(headers: list[str], rows: list[list]) -> str:
    cells = [["", *headers]] + [[str(v).replace("\n", " ") for v in row] for row in rows]
    widths = [max(len(r[i]) if i < len(r) else 0 for r in cells) for i in range(len(cells[0]))]
    lines = []
    for r in cells:
        if not any(r):
            continue
        lines.append("  ".join(v.ljust(widths[i]) for i, v in enumerate(r)).rstrip())
    return "\n".join(lines)


def _trim(text: str, notice: str) -> str:
    if len(text) <= MAX_LENGTH:
        return text
    return text[:MAX_LENGTH].rsplit("\n", 1)[0] + "\n" + notice


def render(title: str | None, body: str | None = None,
           fields: list[tuple[str, str]] | None = None,
           footer: str | None = None,
           table: tuple[list[str], list[list]] | None = None) -> dict:
    """Build one message as {"markdown": ..., "fallback": ...}.

    `title`, `body`, field values and `footer` are Rich Markdown: literal
    markup is kept, dynamic data in them has been through escape_md already.
    `table` is (headers, rows); each row starts with its label and the cells
    are raw values, escaped here.
    """
    md, plain = [], []
    if title:
        md.append(f"# {title}")
        plain.append(to_plain(title))
    if body:
        md.append(body)
        plain.append(to_plain(body))
    if fields:
        md.append("\n".join(f"- **{escape_md(label)}:** {value}" for label, value in fields))
        plain.append("\n".join(f"{label}: {to_plain(value)}" for label, value in fields))
    if table:
        headers, rows = table
        md.append(_table_md(headers, rows))
        plain.append(_table_plain(headers, rows))
    if footer:
        md.append(f"*{footer}*")
        plain.append(to_plain(footer))
    return {
        "markdown": _trim("\n\n".join(md), "*Trimmed to fit one message.*"),
        "fallback": _trim("\n\n".join(plain), "Trimmed to fit one message."),
    }


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
                            footer=None, table=None, buttons=None, owner_id=None):
    """Send one formatted message. `buttons` is the plain data form above."""
    markup = await build_buttons(owner_id if owner_id is not None else _peer_id(entity), buttons)
    return await reply.send_rich_message(
        client, entity, render(title, body, fields, footer, table), markup)


async def edit_rich_message(event, *, title=None, body=None, fields=None,
                            footer=None, table=None, buttons=None, owner_id=None):
    """Replace the message a button lives on, keeping the conversation tidy.
    Tapping a button that leads back to the same view is not an error."""
    markup = await build_buttons(owner_id if owner_id is not None else event.sender_id, buttons)
    return await reply.edit_rich_message(
        event.client, event, render(title, body, fields, footer, table), markup)


def _peer_id(entity) -> int:
    """Buttons are owned by the person they were sent to, so a chat id doubles
    as the owner id in a private chat."""
    if isinstance(entity, int):
        return entity
    return getattr(entity, "id", 0) or 0
