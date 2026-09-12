"""Sending Telegram Rich Messages over MTProto.

Telethon's send_message and edit_message have no way to pass the rich_message
field, so these helpers speak the raw TL requests. Every one of them takes the
same contract, a dict with two keys:

    {"markdown": <Rich Markdown>, "fallback": <plain text saying the same>}

The fallback goes in the required message field. Old clients show it, and it is
what gets sent when Telegram rejects the rich payload, so it is never empty.
No parse_mode anywhere here: the fallback is plain text by design.
"""

import logging

from telethon import types
from telethon.errors import MessageNotModifiedError
from telethon.tl import functions

log = logging.getLogger(__name__)


def _rich_markdown(rich: dict) -> types.InputRichMessageMarkdown:
    return types.InputRichMessageMarkdown(markdown=rich["markdown"])


# Editing without reply_markup keeps the old keyboard; an empty inline
# keyboard is what actually removes it.
_NO_BUTTONS = types.ReplyInlineMarkup(rows=[])


def sent_message_id(result) -> int | None:
    """Id of the message a raw send created (bot sends come back as Updates)."""
    if isinstance(result, (types.Message, types.UpdateShortSentMessage)):
        return result.id
    for update in getattr(result, "updates", []):
        if isinstance(update, types.UpdateMessageID):
            return update.id
        if isinstance(update, (types.UpdateNewMessage, types.UpdateNewChannelMessage)):
            return update.message.id
    return None


async def send_rich_message(client, entity, rich: dict, buttons=None):
    markup = client.build_reply_markup(buttons) if buttons else None
    try:
        return await client(functions.messages.SendMessageRequest(
            peer=entity, message=rich["fallback"],
            rich_message=_rich_markdown(rich), reply_markup=markup))
    except Exception as err:
        log.warning("[send_rich_message] rich send failed, falling back: %s", err)
        return await client.send_message(entity, rich["fallback"], buttons=buttons)


async def edit_rich_message_at(client, peer, msg_id: int, rich: dict, buttons=None):
    """Edit by chat + message id. No buttons => keyboard removed."""
    markup = client.build_reply_markup(buttons) if buttons else _NO_BUTTONS
    try:
        await client(functions.messages.EditMessageRequest(
            peer=peer, id=msg_id, message=rich["fallback"],
            rich_message=_rich_markdown(rich), reply_markup=markup))
    except MessageNotModifiedError:
        return
    except Exception as err:
        log.warning("[edit_rich_message_at] rich edit failed, falling back: %s", err)
        await client.edit_message(peer, msg_id, text=rich["fallback"], buttons=buttons)


async def edit_rich_message(client, event, rich: dict, buttons=None):
    """Edit the message a CallbackQuery came from, in a regular chat or inline mode.

    No buttons => keyboard removed, same as edit_rich_message_at. Every flow in
    this bot that ends on a button-less message (erased, unlinked, cancelled)
    relies on the old keyboard going away with it.
    """
    markup = client.build_reply_markup(buttons) if buttons else _NO_BUTTONS
    is_inline = isinstance(event.query, types.UpdateInlineBotCallbackQuery)
    try:
        if is_inline:
            await client(functions.messages.EditInlineBotMessageRequest(
                id=event.query.msg_id, message=rich["fallback"],
                rich_message=_rich_markdown(rich), reply_markup=markup))
        else:
            await client(functions.messages.EditMessageRequest(
                peer=event.query.peer, id=event.query.msg_id, message=rich["fallback"],
                rich_message=_rich_markdown(rich), reply_markup=markup))
    except MessageNotModifiedError:
        return
    except Exception as err:
        log.warning("[edit_rich_message] rich edit failed, falling back: %s", err)
        if is_inline:
            await client.edit_message(event.query.msg_id, text=rich["fallback"], buttons=buttons)
        else:
            await client.edit_message(event.query.peer, event.query.msg_id,
                                      text=rich["fallback"], buttons=buttons)
