/*
 * Data behind the API panel — the console's answer to an extensions sidebar.
 *
 * Hand-maintained rather than generated: runtime.py lives inside the Pyodide
 * worker and only exists once Python has booted, so introspecting it would mean
 * the panel is empty until then. Keep this in sync when adding methods there.
 */

export type ApiMethod = {
  /** What gets inserted, `|` marking where the caret lands. */
  signature: string,
  summary: string,
  /** Requires the Writes switch. */
  write?: boolean
};

export type ApiGroup = {
  name: string,
  icon: Icon,
  summary: string,
  methods: ApiMethod[]
};

export const API_CATALOG: ApiGroup[] = [
  {
    name: 'tg',
    icon: 'newprivate',
    summary: 'Account, timing and the raw escape hatch',
    methods: [
      {signature: 'await tg.me()', summary: 'The signed-in account'},
      {signature: 'await tg.sleep(|1)', summary: 'Pause without blocking the runtime'},
      {signature: `await tg.raw('|method', param=value)`, summary: 'Any MTProto method by name', write: true},
      {signature: `await tg.input_peer('|@user')`, summary: 'InputPeer for a raw call'},
      {signature: `await tg.input_channel('|@channel')`, summary: 'InputChannel for a raw call'},
      {signature: `await tg.input_user('|@user')`, summary: 'InputUser for a raw call'}
    ]
  },
  {
    name: 'tg.messages',
    icon: 'message',
    summary: 'Read, send, edit and delete messages',
    methods: [
      {signature: `await tg.messages.history('|me', limit=50)`, summary: 'One page of history, newest first'},
      {signature: `async for m in tg.messages.iterate('|me', limit=500):`, summary: 'Whole history, paged for you'},
      {signature: `await tg.messages.search('|me', query='', filter='all')`, summary: 'Search in a chat — omit the peer to go global'},
      {signature: `async for m in tg.messages.iterate_search('|me', query=''):`, summary: 'Paged search'},
      {signature: `await tg.messages.get('|me', [123])`, summary: 'Fetch messages by id'},
      {signature: `await tg.messages.download('|me', 123)`, summary: 'Download a message\'s media as bytes'},
      {signature: `await tg.messages.send('|me', 'text')`, summary: 'Send a text message', write: true},
      {signature: `await tg.messages.send_file('|me', data, name='f.bin')`, summary: 'Send bytes as a file', write: true},
      {signature: `await tg.messages.edit('|me', 123, 'new text')`, summary: 'Edit a message', write: true},
      {signature: `await tg.messages.delete('|me', [123])`, summary: 'Delete messages', write: true},
      {signature: `await tg.messages.forward('|to', 'from', [123])`, summary: 'Forward messages', write: true},
      {signature: `await tg.messages.pin('|me', 123)`, summary: 'Pin a message', write: true},
      {signature: `await tg.messages.unpin('|me', 123)`, summary: 'Unpin a message', write: true},
      {signature: `await tg.messages.unpin_all('|me')`, summary: 'Unpin everything', write: true},
      {signature: `await tg.messages.read('|me')`, summary: 'Mark read up to a message', write: true},
      {signature: `await tg.messages.read_all('|me')`, summary: 'Mark the whole chat read', write: true},
      {signature: `await tg.messages.react('|me', 123, '👍')`, summary: 'React to a message', write: true},
      {signature: `await tg.messages.vote('|me', 123, [0])`, summary: 'Vote in a poll', write: true}
    ]
  },
  {
    name: 'tg.chats',
    icon: 'group',
    summary: 'Groups, channels, members and admin actions',
    methods: [
      {signature: 'await tg.chats.list(|limit=50)', summary: 'Your dialog list'},
      {signature: 'async for c in tg.chats.iterate(|):', summary: 'Every dialog, paged'},
      {signature: `await tg.chats.participants('|@chat', filter='all')`, summary: 'Members — all/admins/bots/banned/contacts'},
      {signature: `async for p in tg.chats.iterate_participants('|@chat'):`, summary: 'Every member, paged'},
      {signature: `await tg.chats.invite_link('|@chat')`, summary: 'The primary invite link'},
      {signature: `await tg.chats.create('|Title', megagroup=True)`, summary: 'New group, supergroup or channel', write: true},
      {signature: `await tg.chats.join('|@chat')`, summary: 'Join a chat', write: true},
      {signature: `await tg.chats.leave('|@chat')`, summary: 'Leave a chat', write: true},
      {signature: `await tg.chats.invite('|@chat', ['@user'])`, summary: 'Add members', write: true},
      {signature: `await tg.chats.kick('|@chat', '@user')`, summary: 'Remove a member', write: true},
      {signature: `await tg.chats.ban('|@chat', '@user')`, summary: 'Ban a member', write: true},
      {signature: `await tg.chats.unban('|@chat', '@user')`, summary: 'Lift a ban', write: true},
      {signature: `await tg.chats.promote('|@chat', '@user')`, summary: 'Grant admin rights', write: true},
      {signature: `await tg.chats.set_title('|@chat', 'New title')`, summary: 'Rename a chat', write: true},
      {signature: `await tg.chats.set_about('|@chat', 'About')`, summary: 'Set the description', write: true},
      {signature: `await tg.chats.set_username('|@chat', 'name')`, summary: 'Set the public @username', write: true},
      {signature: `await tg.chats.export_invite('|@chat')`, summary: 'Create a new invite link', write: true},
      {signature: `await tg.chats.delete('|@chat')`, summary: 'Delete the chat — no undo', write: true}
    ]
  },
  {
    name: 'tg.dialogs',
    icon: 'archive',
    summary: 'Archive, pin, mute and folders',
    methods: [
      {signature: 'await tg.dialogs.folders()', summary: 'Your chat folders'},
      {signature: `await tg.dialogs.archive('|@chat')`, summary: 'Archive or unarchive', write: true},
      {signature: `await tg.dialogs.pin('|@chat')`, summary: 'Toggle the pin', write: true},
      {signature: `await tg.dialogs.mute('|@chat')`, summary: 'Mute or unmute', write: true},
      {signature: `await tg.dialogs.mark_unread('|@chat')`, summary: 'Mark unread', write: true}
    ]
  },
  {
    name: 'tg.users',
    icon: 'user',
    summary: 'Contacts, blocking and people search',
    methods: [
      {signature: 'await tg.users.contacts()', summary: 'Your contact list'},
      {signature: `await tg.users.search('|query')`, summary: 'Global people search'},
      {signature: `await tg.users.common_chats('|@user')`, summary: 'Groups you share with someone'},
      {signature: 'await tg.users.blocked()', summary: 'Your block list'},
      {signature: `await tg.users.add_contact('|@user', first_name='')`, summary: 'Add a contact', write: true},
      {signature: `await tg.users.delete_contacts(['|@user'])`, summary: 'Remove contacts', write: true},
      {signature: `await tg.users.block('|@user')`, summary: 'Block someone', write: true},
      {signature: `await tg.users.unblock('|@user')`, summary: 'Unblock someone', write: true}
    ]
  },
  {
    name: 'tg.peer',
    icon: 'info',
    summary: 'Resolve usernames and read full profiles',
    methods: [
      {signature: `await tg.peer.resolve('|@durov')`, summary: '@name, t.me link or id → peer info'},
      {signature: `await tg.peer.full('|@durov')`, summary: 'Bio, member count, pinned message'}
    ]
  },
  {
    name: 'tg.drafts',
    icon: 'edit',
    summary: 'Read and write message drafts',
    methods: [
      {signature: `await tg.drafts.get('|@chat')`, summary: 'Read the saved draft'},
      {signature: `await tg.drafts.set('|@chat', 'text')`, summary: 'Set a draft', write: true},
      {signature: `await tg.drafts.clear('|@chat')`, summary: 'Clear a draft', write: true}
    ]
  },
  {
    name: 'tg.account',
    icon: 'settings',
    summary: 'Your own profile',
    methods: [
      {signature: `await tg.account.update_profile(first_name='|')`, summary: 'Change your name or bio', write: true},
      {signature: `await tg.account.update_username('|name')`, summary: 'Change your @username', write: true},
      {signature: 'await tg.account.set_online(|True)', summary: 'Set your online status', write: true}
    ]
  },
  {
    name: 'tg.output',
    icon: 'download',
    summary: 'Render results in the output panel',
    methods: [
      {signature: 'tg.output.json(|value)', summary: 'Pretty-print, downloadable as .json'},
      {signature: 'tg.output.table(|rows)', summary: 'A list of dicts as a real table'},
      {signature: 'tg.output.csv(|rows)', summary: 'Downloadable as .csv'},
      {signature: 'tg.output.text(|value)', summary: 'Plain text block'},
      {signature: `tg.output.file(|data, 'name.bin')`, summary: 'Offer bytes as a download'}
    ]
  }
];

export const SNIPPETS: {name: string, code: string}[] = [
  {
    name: 'Who am I',
    code: `me = await tg.me()
print('Signed in as', me.title, '/ peer_id', me.peerId)`
  },
  {
    name: 'List my chats',
    code: `page = await tg.chats.list(limit=30)
print('total dialogs:', page.count)

for c in page.chats:
    flag = '*' if c.muted else ' '
    print(f'{flag} {c.type:<8} {c.unread:>4} unread  {c.title}')

tg.output.table(page.chats, 'chats')`
  },
  {
    name: 'Dump a channel to JSON',
    code: `channel = '@durov'

messages = []
async for m in tg.messages.iterate(channel, limit=500):
    messages.append(m)
    if len(messages) % 100 == 0:
        print('fetched', len(messages))

print('done:', len(messages), 'messages')
tg.output.json(messages, 'history')`
  },
  {
    name: 'Activity by hour',
    code: `from collections import Counter
from datetime import datetime
import statistics

msgs = [m async for m in tg.messages.iterate('@durov', limit=300)]

by_hour = Counter(datetime.fromtimestamp(m.date).hour for m in msgs)
views = [m.views for m in msgs if m.views]

print('messages :', len(msgs))
print('avg views:', round(statistics.mean(views)) if views else 'n/a')
print()

for hour in range(24):
    print(f'{hour:02d}:00 {"#" * by_hour.get(hour, 0)}')

tg.output.csv(
    [{'hour': h, 'messages': by_hour.get(h, 0)} for h in range(24)],
    'activity-by-hour'
)`
  },
  {
    name: 'Search every chat',
    code: `page = await tg.messages.search(query='invoice', limit=50)
print('hits:', page.count)

for m in page.messages:
    peer = await tg.peer.resolve(m.peerId)
    print(f'{peer.title:<25} {m.text[:60]}')`
  },
  {
    name: 'Export members to CSV',
    code: `chat = '@durov'

people = [p async for p in tg.chats.iterate_participants(chat, limit=500)]
print('members:', len(people))

admins = [p for p in people if p.role in ('creator', 'admin')]
print('admins :', ', '.join(a.title for a in admins))

tg.output.csv(people, 'members')`
  },
  {
    name: 'Send a message',
    code: `# Needs the Writes switch.
await tg.messages.send('me', 'Hello from the console')`
  },
  {
    name: 'Download media',
    code: `page = await tg.messages.search('me', filter='photoVideo', limit=1)

if not page.messages:
    print('nothing to download')
else:
    m = page.messages[0]
    f = await tg.messages.download('me', m.id)
    print('got', f.name, f.size, 'bytes')
    tg.output.file(f.bytes, f.name, f.mime, 'downloaded')`
  },
  {
    name: 'Any MTProto method',
    code: `channel = await tg.input_channel('@durov')
full = await tg.raw('channels.getFullChannel', channel=channel)

info = full['full_chat']
print('subscribers :', info.get('participants_count'))
print('about       :', (info.get('about') or '')[:120])

tg.output.json(full, 'full-channel')`
  }
];
