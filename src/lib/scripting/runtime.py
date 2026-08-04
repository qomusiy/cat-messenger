"""The `tg` object every script in the console gets for free.

This module is loaded into Pyodide by sandbox.worker.ts before the user's code
runs, and it is deliberately thin: every method here is one RPC hop to the
main-thread broker, which resolves it against the allow-list in api.ts and calls
a real app manager. Nothing in this file talks to Telegram — it only translates
between Python ergonomics (keyword args, snake_case, async generators, dicts you
can dot into) and the flat `call(method, args)` protocol.

Anything not wrapped here is still reachable: `await tg.raw('some.method', ...)`
takes any MTProto method by name.
"""

import asyncio
import json

from pyodide.ffi import to_js, JsProxy
import js

# Registered by sandbox.worker.ts before this file is executed. Its two methods
# (`call` and `output`) are the entire surface between Python and the account.
import _tg_bridge as _bridge


# --- plumbing ---------------------------------------------------------------

class Box(dict):
    """A dict you can also dot into, so `m.text` works as well as `m['text']`.

    Results from Telegram are deeply nested and read far better as attributes;
    keeping the dict base means json.dumps() and **kwargs still work on them.
    """

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(
                f"no field {name!r} — available: {', '.join(sorted(self.keys()))}"
            ) from None

    def __setattr__(self, name, value):
        self[name] = value

    def __dir__(self):
        return list(self.keys()) + list(super().__dir__())


def _boxed(value):
    if isinstance(value, dict):
        return Box({k: _boxed(v) for k, v in value.items()})
    if isinstance(value, (list, tuple)):
        return [_boxed(v) for v in value]
    if isinstance(value, memoryview):
        return bytes(value)
    return value


def _to_js(value):
    return to_js(value, dict_converter=js.Object.fromEntries)


def _from_js(value):
    if isinstance(value, JsProxy):
        try:
            value = value.to_py()
        except Exception:
            return value
    return _boxed(value)


async def _call(method, *args):
    return _from_js(await _bridge.call(method, _to_js(list(args))))


def _clean(options):
    """Drop None values so the JS side sees genuine absence, not null."""
    return {k: v for k, v in options.items() if v is not None}


# --- namespaces -------------------------------------------------------------

class _Peers:
    async def resolve(self, peer):
        """'@durov' | 'durov' | 't.me/durov' | peer_id | 'me' -> peer info."""
        return await _call('peer.resolve', peer)

    async def full(self, peer):
        """Full profile: bio, member count, pinned message, blocked flag."""
        return await _call('peer.full', peer)


class _Chats:
    async def list(self, limit=50, query=None, folder_id=None):
        """One page of your dialog list."""
        return await _call('chats.list', _clean(
            {'limit': limit, 'query': query, 'folderId': folder_id}))

    async def iterate(self, limit=None, chunk=100, **kwargs):
        """Every dialog, paged for you. `async for chat in tg.chats.iterate():`"""
        page = await self.list(limit=chunk, **kwargs)
        count = 0
        for chat in page.chats:
            yield chat
            count += 1
            if limit is not None and count >= limit:
                return

    async def participants(self, peer, limit=200, offset=0, filter='all', query=None):
        """Members of a group/channel. filter: all|admins|bots|banned|restricted|contacts."""
        return await _call('chats.participants', peer, _clean(
            {'limit': limit, 'offset': offset, 'filter': filter, 'query': query}))

    async def iterate_participants(self, peer, limit=None, chunk=200, **kwargs):
        """Every member, paged. Large channels only expose the first ~10k."""
        offset, count = 0, 0
        while True:
            page = await self.participants(peer, limit=chunk, offset=offset, **kwargs)
            people = page.participants
            if not people:
                return
            for person in people:
                yield person
                count += 1
                if limit is not None and count >= limit:
                    return
            offset += len(people)

    async def create(self, title, users=(), about=None, megagroup=False, broadcast=False):
        """New group (default), supergroup (megagroup=True) or channel (broadcast=True)."""
        return await _call('chats.create', title, _clean(
            {'users': list(users), 'about': about,
             'megagroup': megagroup, 'broadcast': broadcast}))

    async def join(self, peer):
        return await _call('chats.join', peer)

    async def leave(self, peer):
        return await _call('chats.leave', peer)

    async def invite(self, peer, users):
        """Add one user or a list of users to a group/channel."""
        return await _call('chats.invite', peer, users)

    async def kick(self, peer, user):
        return await _call('chats.kick', peer, user)

    async def ban(self, peer, user, until=None):
        """Ban a user. `until` is a unix timestamp; omit for permanent."""
        return await _call('chats.ban', peer, user, _clean({'until': until}))

    async def unban(self, peer, user):
        return await _call('chats.unban', peer, user)

    async def promote(self, peer, user, rank=None, **rights):
        """Make a user admin. Pass rights like invite_users=False to narrow them."""
        mapped = {
            'changeInfo': rights.get('change_info'),
            'postMessages': rights.get('post_messages'),
            'editMessages': rights.get('edit_messages'),
            'deleteMessages': rights.get('delete_messages'),
            'banUsers': rights.get('ban_users'),
            'inviteUsers': rights.get('invite_users'),
            'pinMessages': rights.get('pin_messages'),
            'manageCall': rights.get('manage_call'),
            'addAdmins': rights.get('add_admins'),
            'anonymous': rights.get('anonymous'),
            'rank': rank
        }
        return await _call('chats.promote', peer, user, _clean(mapped))

    async def set_title(self, peer, title):
        return await _call('chats.setTitle', peer, title)

    async def set_about(self, peer, about):
        return await _call('chats.setAbout', peer, about)

    async def set_username(self, peer, username):
        return await _call('chats.setUsername', peer, username)

    async def delete(self, peer):
        """Delete the chat/channel entirely. There is no undo."""
        return await _call('chats.delete', peer)

    async def invite_link(self, peer):
        return await _call('chats.inviteLink', peer)

    async def export_invite(self, peer, title=None, expire_date=None,
                            usage_limit=None, request_needed=None):
        return await _call('chats.exportInvite', peer, _clean(
            {'title': title, 'expireDate': expire_date,
             'usageLimit': usage_limit, 'requestNeeded': request_needed}))


class _Messages:
    async def history(self, peer, limit=50, offset_id=0, offset_date=None,
                      add_offset=None, thread_id=None, filter='all'):
        """Newest-first page of a chat's history."""
        return await _call('messages.history', peer, _clean(
            {'limit': limit, 'offsetId': offset_id, 'offsetDate': offset_date,
             'addOffset': add_offset, 'threadId': thread_id, 'filter': filter}))

    async def iterate(self, peer, limit=None, chunk=100, **kwargs):
        """Whole history, paged for you — the loop nobody should hand-write.

            async for m in tg.messages.iterate('@durov', limit=5000):
                ...
        """
        offset_id = kwargs.pop('offset_id', 0)
        count = 0
        while True:
            take = chunk if limit is None else min(chunk, limit - count)
            if take <= 0:
                return

            page = await self.history(peer, limit=take, offset_id=offset_id, **kwargs)
            messages = page.messages
            if not messages:
                return

            for message in messages:
                yield message
                count += 1
                if limit is not None and count >= limit:
                    return

            offset_id = messages[-1].id

    async def search(self, peer=None, query=None, filter='all', limit=50,
                     offset_id=0, from_peer=None, min_date=None, max_date=None,
                     folder_id=None):
        """Server-side search. Omit `peer` to search every chat at once.

        filter: all|photo|video|photoVideo|document|url|music|voice|gif|
                roundVideo|pinned|mention|contact|geo|phoneCall
        """
        return await _call('messages.search', peer, _clean(
            {'query': query, 'filter': filter, 'limit': limit, 'offsetId': offset_id,
             'fromPeer': from_peer, 'minDate': min_date, 'maxDate': max_date,
             'folderId': folder_id}))

    async def iterate_search(self, peer=None, limit=None, chunk=100, **kwargs):
        offset_id = kwargs.pop('offset_id', 0)
        count = 0
        while True:
            take = chunk if limit is None else min(chunk, limit - count)
            if take <= 0:
                return

            page = await self.search(peer, limit=take, offset_id=offset_id, **kwargs)
            messages = page.messages
            if not messages:
                return

            for message in messages:
                yield message
                count += 1
                if limit is not None and count >= limit:
                    return

            offset_id = messages[-1].id

    async def get(self, peer, ids):
        """Fetch specific message ids. Accepts one id or a list."""
        return await _call('messages.get', peer, ids)

    async def send(self, peer, text, reply_to=None, silent=False, schedule=None,
                   no_webpage=False, thread_id=None):
        """Send a text message."""
        return await _call('messages.send', peer, text, _clean(
            {'replyTo': reply_to, 'silent': silent, 'schedule': schedule,
             'noWebPage': no_webpage, 'threadId': thread_id}))

    async def send_file(self, peer, data, name='file.bin', mime=None, caption=None,
                        reply_to=None, silent=False, schedule=None, as_media=True):
        """Send bytes as a file. `data` is bytes/bytearray (e.g. from download())."""
        payload = {'bytes': bytes(data), 'name': name, 'mime': mime}
        return await _call('messages.sendFile', peer, _clean(payload), _clean(
            {'caption': caption, 'replyTo': reply_to, 'silent': silent,
             'schedule': schedule, 'asMedia': as_media}))

    async def edit(self, peer, message_id, text):
        return await _call('messages.edit', peer, message_id, text)

    async def delete(self, peer, ids, revoke=True):
        """Delete messages. revoke=True removes them for everyone."""
        return await _call('messages.delete', peer, ids, revoke)

    async def forward(self, to_peer, from_peer, ids, silent=False,
                      drop_author=False, drop_captions=False, schedule=None):
        return await _call('messages.forward', to_peer, from_peer, ids, _clean(
            {'silent': silent, 'dropAuthor': drop_author,
             'dropCaptions': drop_captions, 'schedule': schedule}))

    async def pin(self, peer, message_id, silent=True, one_side=False):
        return await _call('messages.pin', peer, message_id,
                           {'silent': silent, 'oneSide': one_side})

    async def unpin(self, peer, message_id):
        return await _call('messages.unpin', peer, message_id)

    async def unpin_all(self, peer):
        return await _call('messages.unpinAll', peer)

    async def read(self, peer, max_id=0):
        """Mark read up to `max_id` (0 = everything)."""
        return await _call('messages.read', peer, max_id)

    async def read_all(self, peer):
        return await _call('messages.readAll', peer)

    async def react(self, peer, message_id, emoticon):
        """React with an emoji. Pass emoticon=None to remove your reaction."""
        return await _call('messages.react', peer, message_id, emoticon)

    async def vote(self, peer, message_id, options):
        """Vote in a poll. `options` is a 0-based index or list of indexes."""
        return await _call('messages.vote', peer, message_id, options)

    async def download(self, peer, message_id):
        """Download a message's media. Returns a Box with .bytes/.name/.mime/.size."""
        result = await _call('messages.download', peer, message_id)
        result['bytes'] = bytes(result['bytes'])
        return result


class _Dialogs:
    async def archive(self, peer, archived=True):
        return await _call('dialogs.archive', peer, archived)

    async def pin(self, peer):
        """Toggles the pin — Telegram has no absolute set here."""
        return await _call('dialogs.pin', peer)

    async def mute(self, peer, muted=True, until=None):
        return await _call('dialogs.mute', peer, muted, until)

    async def mark_unread(self, peer):
        return await _call('dialogs.markUnread', peer)

    async def folders(self):
        return await _call('dialogs.folders')


class _Drafts:
    async def get(self, peer):
        return await _call('drafts.get', peer)

    async def set(self, peer, text):
        return await _call('drafts.set', peer, text)

    async def clear(self, peer):
        return await _call('drafts.clear', peer)


class _Users:
    async def contacts(self, query=None):
        return await _call('users.contacts', query)

    async def add_contact(self, peer, first_name='', last_name='', phone='', show_phone=False):
        return await _call('users.addContact', peer, {
            'firstName': first_name, 'lastName': last_name,
            'phone': phone, 'showPhone': show_phone})

    async def delete_contacts(self, peers):
        return await _call('users.deleteContacts', peers)

    async def block(self, peer):
        return await _call('users.block', peer)

    async def unblock(self, peer):
        return await _call('users.unblock', peer)

    async def blocked(self, limit=50, offset=0):
        return await _call('users.blocked', {'limit': limit, 'offset': offset})

    async def common_chats(self, peer, limit=100):
        return await _call('users.commonChats', peer, limit)

    async def search(self, query, limit=20):
        """Global user/chat search — finds people you have no dialog with."""
        return await _call('users.search', query, limit)


class _Account:
    async def update_profile(self, first_name=None, last_name=None, about=None):
        return await _call('account.updateProfile', _clean(
            {'firstName': first_name, 'lastName': last_name, 'about': about}))

    async def update_username(self, username):
        return await _call('account.updateUsername', username)

    async def set_online(self, online=True):
        return await _call('account.setOnline', online)


class _Output:
    """Everything here renders a block in the console's output pane."""

    def json(self, value, label=None):
        """Pretty-printed and downloadable as .json."""
        _bridge.output(_to_js(_plain(value)), label, 'json', None, None)

    def table(self, rows, label=None):
        """A list of dicts rendered as a real table."""
        _bridge.output(_to_js(_plain(list(rows))), label, 'table', None, None)

    def csv(self, rows, label=None):
        """A list of dicts, downloadable as .csv."""
        _bridge.output(_to_js(_plain(list(rows))), label, 'csv', None, None)

    def text(self, value, label=None):
        _bridge.output(str(value), label, 'text', None, None)

    def file(self, data, filename='output.bin', mime='application/octet-stream', label=None):
        """Offer arbitrary bytes as a browser download."""
        _bridge.output(_to_js(bytes(data)), label, 'file', filename, mime)


def _plain(value):
    """Strip Box/JsProxy wrappers so the value survives structured cloning."""
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_plain(v) for v in value]
    if isinstance(value, (bytes, bytearray, memoryview)):
        return bytes(value)
    if isinstance(value, JsProxy):
        return _plain(value.to_py())
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    # dataclasses, Counter, datetime, … — best effort, then repr
    try:
        json.dumps(value)
        return value
    except TypeError:
        return repr(value)


class _Tg:
    """The Telegram surface. `tg.<namespace>.<method>` — everything is async."""

    def __init__(self):
        self.peer = _Peers()
        self.chats = _Chats()
        self.messages = _Messages()
        self.dialogs = _Dialogs()
        self.drafts = _Drafts()
        self.users = _Users()
        self.account = _Account()
        self.output = _Output()

    async def me(self):
        """The signed-in account."""
        return await _call('me')

    async def sleep(self, seconds):
        """Pause. Use this rather than time.sleep — that one blocks the runtime."""
        await asyncio.sleep(seconds)

    async def raw(self, method, **params):
        """Call any MTProto method by name — the escape hatch for everything
        this module doesn't wrap.

            peer = await tg.input_peer('@durov')
            await tg.raw('channels.getFullChannel', channel=peer)

        Auth/credential methods (auth.*, password and session management) are
        refused. Counts as a write, so the Writes switch must be on.
        """
        return await _call('raw', method, _clean(params))

    async def inputs(self, peer):
        """InputPeer/InputChannel/InputUser for a peer, to feed `raw` calls."""
        return await _call('inputs', peer)

    async def input_peer(self, peer):
        return (await self.inputs(peer)).inputPeer

    async def input_channel(self, peer):
        return (await self.inputs(peer)).inputChannel

    async def input_user(self, peer):
        return (await self.inputs(peer)).inputUser


tg = _Tg()
