/*
 * The allow-list behind `tg.*`. Every entry goes through an app manager — never
 * `apiManager.invokeApi` directly — so caching, `saveApiPeers` and update
 * dispatch all behave exactly as they do for the rest of the app. `raw` is the
 * one method that names an MTProto method directly, and it still goes through
 * `appScriptingManager.invokeRaw` for the same reason.
 *
 * Read methods always run. Write methods (`WRITE_METHODS`) additionally require
 * the console's Writes switch and pass through a token bucket, because the
 * failure mode of a buggy loop here is not a stack trace — it is a few hundred
 * messages sent for real, or a flood-ban on the account.
 */

import rootScope from '@lib/rootScope';
import apiManagerProxy from '@lib/apiManagerProxy';
import {NULL_PEER_ID} from '@appManagers/constants';
import choosePhotoSize from '@appManagers/utils/photos/choosePhotoSize';
import type {Chat, Message, User, Document, Photo} from '@layer';
import type {DialogDTO, MessageDTO, ParticipantDTO, PeerDTO} from './protocol';

const MAX_LIMIT = 200;

/** Friendly filter names -> MTProto InputMessagesFilter constructors. */
const FILTERS: Record<string, string> = {
  all: 'inputMessagesFilterEmpty',
  photo: 'inputMessagesFilterPhotos',
  video: 'inputMessagesFilterVideo',
  photoVideo: 'inputMessagesFilterPhotoVideo',
  document: 'inputMessagesFilterDocument',
  url: 'inputMessagesFilterUrl',
  music: 'inputMessagesFilterMusic',
  voice: 'inputMessagesFilterVoice',
  gif: 'inputMessagesFilterGif',
  roundVideo: 'inputMessagesFilterRoundVideo',
  pinned: 'inputMessagesFilterPinned',
  mention: 'inputMessagesFilterMyMentions',
  contact: 'inputMessagesFilterContacts',
  geo: 'inputMessagesFilterGeo',
  phoneCall: 'inputMessagesFilterPhoneCalls'
};

/** Participant filters for `chats.participants`. */
const PARTICIPANT_FILTERS: Record<string, any> = {
  all: {_: 'channelParticipantsRecent'},
  recent: {_: 'channelParticipantsRecent'},
  admins: {_: 'channelParticipantsAdmins'},
  bots: {_: 'channelParticipantsBots'},
  banned: {_: 'channelParticipantsKicked', q: ''},
  restricted: {_: 'channelParticipantsBanned', q: ''},
  contacts: {_: 'channelParticipantsContacts', q: ''}
};

/*
 * Everything below this line mutates the account. Gated on `context.allowWrites`
 * and rate-limited. Keep this list in sync when adding methods — a write that
 * isn't listed here silently bypasses both protections.
 */
const WRITE_METHODS = new Set([
  'raw', // conservative: a raw call is assumed to write unless proven otherwise
  'messages.send', 'messages.sendFile', 'messages.edit', 'messages.delete',
  'messages.forward', 'messages.pin', 'messages.unpin', 'messages.unpinAll',
  'messages.read', 'messages.readAll', 'messages.react', 'messages.vote',
  'chats.create', 'chats.join', 'chats.leave', 'chats.invite', 'chats.kick',
  'chats.ban', 'chats.unban', 'chats.promote', 'chats.setTitle', 'chats.setAbout',
  'chats.setUsername', 'chats.delete', 'chats.exportInvite',
  'dialogs.archive', 'dialogs.pin', 'dialogs.mute', 'dialogs.markUnread',
  'drafts.set', 'drafts.clear',
  'users.addContact', 'users.deleteContacts', 'users.block', 'users.unblock',
  'account.updateProfile', 'account.updateUsername', 'account.setOnline'
]);

/*
 * Token bucket for writes. Telegram's own flood limits are per-method and
 * undocumented; this is deliberately below all of them so an ordinary script
 * never trips one, and it *waits* rather than throwing so a loop doing 500
 * sends just runs slower instead of dying halfway with partial side effects.
 */
const BUCKET_CAPACITY = 20;
const BUCKET_REFILL_MS = 350;

let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();

async function takeWriteToken() {
  for(;;) {
    const now = Date.now();
    const gained = Math.floor((now - lastRefill) / BUCKET_REFILL_MS);
    if(gained > 0) {
      tokens = Math.min(BUCKET_CAPACITY, tokens + gained);
      lastRefill = now;
    }

    if(tokens > 0) {
      --tokens;
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, BUCKET_REFILL_MS));
  }
}

/** `Peer` / participant record -> PeerId, without a round trip to the worker. */
function peerToPeerId(peer: any): PeerId {
  if(!peer) return undefined;
  if(typeof peer === 'number') return peer as PeerId;
  if(peer.user_id !== undefined) return (peer.user_id as UserId).toPeerId(false);
  if(peer.channel_id !== undefined) return (peer.channel_id as ChatId).toPeerId(true);
  if(peer.chat_id !== undefined) return (peer.chat_id as ChatId).toPeerId(true);
  if(peer.peer) return peerToPeerId(peer.peer);
  return undefined;
}

function peerTitle(peer: User.user | Chat.chat | Chat.channel | any): string {
  if(!peer) return '';
  if(peer._ === 'user') {
    return [peer.first_name, peer.last_name].filter(Boolean).join(' ') || peer.username || String(peer.id);
  }
  return peer.title || String(peer.id);
}

function peerUsername(peer: any): string | undefined {
  return peer?.username || peer?.usernames?.[0]?.username;
}

function toPeerDTO(peerId: PeerId, peer: any): PeerDTO {
  const type = peer?._ === 'user' ? 'user' : peer?._ === 'channel' ? 'channel' : 'chat';
  const dto: PeerDTO = {peerId, type, title: peerTitle(peer), username: peerUsername(peer)};

  if(type === 'user') {
    dto.firstName = peer?.first_name;
    dto.lastName = peer?.last_name;
    dto.phone = peer?.phone;
    dto.bot = !!peer?.pFlags?.bot;
    dto.premium = !!peer?.pFlags?.premium;
    dto.verified = !!peer?.pFlags?.verified;
    dto.contact = !!peer?.pFlags?.contact;
    dto.deleted = !!peer?.pFlags?.deleted;
  } else {
    dto.broadcast = !!peer?.pFlags?.broadcast;
    dto.megagroup = !!peer?.pFlags?.megagroup;
    dto.forum = !!peer?.pFlags?.forum;
    dto.verified = !!peer?.pFlags?.verified;
    dto.participantsCount = peer?.participants_count;
  }

  return dto;
}

function mediaFileInfo(message: any) {
  const media = message?.media;
  const doc: Document.document = media?.document;
  if(doc) {
    const fileNameAttribute: any = doc.attributes?.find((a: any) => a._ === 'documentAttributeFilename');
    return {
      hasFile: true,
      fileName: fileNameAttribute?.file_name || doc.file_name,
      fileSize: +doc.size || undefined,
      mimeType: doc.mime_type
    };
  }

  if(media?.photo) {
    return {hasFile: true, mimeType: 'image/jpeg'};
  }

  return {hasFile: false};
}

function toMessageDTO(message: Message.message | Message.messageService | any): MessageDTO {
  if(!message) return undefined;

  const reactions = message.reactions?.results?.map((r: any) => ({
    reaction: r.reaction?.emoticon || r.reaction?.document_id || '?',
    count: r.count,
    chosen: !!r.pFlags?.chosen || r.chosen_order !== undefined
  }));

  return {
    id: message.mid ?? message.id,
    peerId: message.peerId,
    fromId: message.fromId,
    date: message.date,
    text: message.message || '',
    media: message.media?._ || (message.action?._ ? 'service:' + message.action._ : 'none'),
    views: message.views,
    forwards: message.forwards,
    replyToMsgId: message.reply_to_mid,
    groupedId: message.grouped_id ? String(message.grouped_id) : undefined,
    outgoing: !!message.pFlags?.out,
    editDate: message.edit_date,
    pinned: !!message.pFlags?.pinned,
    reactions: reactions?.length ? reactions : undefined,
    ...mediaFileInfo(message)
  };
}

async function resolvePeerId(peer: string | number): Promise<PeerId> {
  if(peer === undefined || peer === null || peer === '') {
    throw new Error('peer is required');
  }

  if(typeof peer === 'number') return peer as PeerId;

  const raw = String(peer).trim();
  if(/^-?\d+$/.test(raw)) return +raw as PeerId;
  if(raw === 'me' || raw === 'self') return rootScope.myId;

  const username = raw.replace(/^(https?:\/\/)?(t\.me\/)?@?/, '');
  const resolved: any = await rootScope.managers.appUsersManager.resolveUsername(username);
  if(!resolved) throw new Error('Could not resolve peer: ' + raw);

  return resolved._ === 'user' ?
    (resolved.id as UserId).toPeerId(false) :
    (resolved.id as ChatId).toPeerId(true);
}

/** Resolves and asserts the peer is a chat/channel — most admin ops need this. */
async function resolveChatId(peer: string | number): Promise<ChatId> {
  const peerId = await resolvePeerId(peer);
  if(!peerId.isAnyChat()) throw new Error('Expected a group or channel, got a user');
  return peerId.toChatId();
}

async function resolveUserId(peer: string | number): Promise<UserId> {
  const peerId = await resolvePeerId(peer);
  if(!peerId.isUser()) throw new Error('Expected a user, got a group or channel');
  return peerId.toUserId();
}

function clampLimit(limit: any) {
  return Math.max(1, Math.min(+limit || 50, MAX_LIMIT));
}

/** Seconds since epoch — scripts naturally pass JS-style milliseconds. */
function toUnix(value: number) {
  if(!value) return undefined;
  return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
}

async function readHistory(peer: string | number, options: any = {}, search = false) {
  // A search with no peer is a global search across every chat.
  const isGlobal = search && (peer === undefined || peer === null || peer === '');
  const peerId = isGlobal ? NULL_PEER_ID : await resolvePeerId(peer);

  const filterName = options?.filter || 'all';
  const filter = FILTERS[filterName];
  if(!filter) {
    throw new Error(`Unknown filter '${filterName}'. Use one of: ${Object.keys(FILTERS).join(', ')}`);
  }

  const requestOptions: any = {
    peerId,
    limit: clampLimit(options?.limit),
    offsetId: options?.offsetId || 0,
    inputFilter: {_: filter}
  };

  if(options?.threadId) requestOptions.threadId = options.threadId;
  if(options?.addOffset) requestOptions.addOffset = options.addOffset;
  if(options?.offsetDate) requestOptions.offsetDate = toUnix(options.offsetDate);

  if(search) {
    if(options?.query) requestOptions.query = options.query;
    if(options?.minDate) requestOptions.minDate = toUnix(options.minDate);
    if(options?.maxDate) requestOptions.maxDate = toUnix(options.maxDate);
    if(options?.fromPeer) requestOptions.fromPeerId = await resolvePeerId(options.fromPeer);
    if(isGlobal) requestOptions.folderId = options?.folderId ?? 0;
  }

  const result: any = await rootScope.managers.appMessagesManager.getHistory(requestOptions);

  const messages: any[] = result.messages ?
    result.messages :
    (result.history || []).map((mid: number) => apiManagerProxy.getMessageByPeer(peerId, mid));

  return {
    count: result.count,
    messages: messages.filter(Boolean).map(toMessageDTO)
  };
}

/** The cached Message object — needed by reactions, votes and downloads. */
async function getMessage(peer: string | number, messageId: number) {
  const peerId = await resolvePeerId(peer);
  let message: any = apiManagerProxy.getMessageByPeer(peerId, messageId);

  if(!message || message._ === 'messageEmpty') {
    // Not in the local cache — pull the single message through history.
    await rootScope.managers.appMessagesManager.reloadMessages(peerId, [messageId]).catch(() => {});
    message = apiManagerProxy.getMessageByPeer(peerId, messageId);
  }

  if(!message || message._ === 'messageEmpty') {
    throw new Error(`Message ${messageId} not found in ${peerId}`);
  }

  return {peerId, message};
}

export type ApiContext = {
  /** Throws if the run was cancelled — checked before each call resolves. */
  assertAlive: () => void,
  /** Mirrors the console's Writes switch. */
  allowWrites: boolean,
  /** Surfaces a write in the output pane so every mutation leaves a trace. */
  audit: (text: string) => void,
  /** Resets the idle timeout — a script making calls is a script making progress. */
  touch: () => void
};

type Handler = (args: any[], context: ApiContext) => Promise<any>;

const HANDLERS: Record<string, Handler> = {
  'me': async() => {
    const peerId = rootScope.myId;
    const peer = await rootScope.managers.appPeersManager.getPeer(peerId);
    return toPeerDTO(peerId, peer);
  },

  /*
   * The escape hatch: any MTProto method, by name. This is what makes the
   * console genuinely "all of Telegram" rather than whatever got wrapped below.
   */
  'raw': async([method, params]) => {
    if(typeof method !== 'string') throw new Error('raw(method, params): method must be a string');
    return rootScope.managers.appScriptingManager.invokeRaw(method, params || {});
  },

  /** InputPeer/InputChannel/InputUser for a peer, to feed `raw` calls. */
  'inputs': async([peer]) => {
    const peerId = await resolvePeerId(peer);
    return rootScope.managers.appScriptingManager.getInputs(peerId);
  },

  // ---- peers ------------------------------------------------------------

  'peer.resolve': async([peer]) => {
    const peerId = await resolvePeerId(peer);
    const full = await rootScope.managers.appPeersManager.getPeer(peerId);
    return toPeerDTO(peerId, full);
  },

  'peer.full': async([peer]) => {
    const peerId = await resolvePeerId(peer);
    const [base, full] = await Promise.all([
      rootScope.managers.appPeersManager.getPeer(peerId),
      rootScope.managers.appProfileManager.getProfileByPeerId(peerId, true)
    ]);

    const dto: any = toPeerDTO(peerId, base);
    dto.about = (full as any)?.about;
    dto.participantsCount = (full as any)?.participants_count ?? dto.participantsCount;
    dto.onlineCount = (full as any)?.online_count;
    dto.pinnedMsgId = (full as any)?.pinned_msg_id;
    dto.blocked = !!(full as any)?.pFlags?.blocked;
    dto.commonChatsCount = (full as any)?.common_chats_count;
    dto.linkedChatId = (full as any)?.linked_chat_id;
    return dto;
  },

  // ---- chats / dialogs --------------------------------------------------

  'chats.list': async([options]) => {
    const result: any = await rootScope.managers.dialogsStorage.getDialogs({
      limit: clampLimit(options?.limit),
      query: options?.query,
      filterId: options?.folderId
    });

    const dialogs = result?.dialogs || [];
    const out: DialogDTO[] = [];
    for(const dialog of dialogs) {
      const peer = await rootScope.managers.appPeersManager.getPeer(dialog.peerId);
      out.push({
        ...toPeerDTO(dialog.peerId, peer),
        unread: dialog.unread_count || 0,
        topMessageId: dialog.top_message,
        pinned: !!dialog.pFlags?.pinned,
        muted: (dialog.notify_settings?.mute_until || 0) > Date.now() / 1000,
        folderId: dialog.folder_id || 0
      });
    }

    return {count: result?.count ?? out.length, chats: out};
  },

  'chats.participants': async([peer, options]) => {
    const chatId = await resolveChatId(peer);
    const filterName = options?.filter || 'all';
    if(!PARTICIPANT_FILTERS[filterName]) {
      throw new Error(`Unknown participant filter '${filterName}'. Use one of: ${Object.keys(PARTICIPANT_FILTERS).join(', ')}`);
    }

    // Copy — writing `q` onto the shared constant would leak the query into
    // every later call that used the same filter name.
    const filter = {...PARTICIPANT_FILTERS[filterName]};
    if(options?.query && 'q' in filter) filter.q = options.query;

    const result: any = await rootScope.managers.appProfileManager.getParticipants({
      id: chatId,
      filter,
      limit: clampLimit(options?.limit),
      offset: options?.offset || 0
    });

    const participants: any[] = result?.participants || [];
    const out: ParticipantDTO[] = [];
    for(const participant of participants) {
      const peerId = peerToPeerId(participant);
      if(!peerId) continue;

      const full = await rootScope.managers.appPeersManager.getPeer(peerId);

      out.push({
        ...toPeerDTO(peerId, full),
        role: participant._ === 'channelParticipantCreator' || participant._ === 'chatParticipantCreator' ? 'creator' :
          participant._ === 'channelParticipantAdmin' || participant._ === 'chatParticipantAdmin' ? 'admin' :
            participant._ === 'channelParticipantBanned' ? 'banned' :
              participant._ === 'channelParticipantLeft' ? 'left' : 'member',
        joinedDate: participant.date
      });
    }

    return {count: result?.count ?? out.length, participants: out};
  },

  'chats.create': async([title, options], context) => {
    const userIds = await Promise.all((options?.users || []).map(resolveUserId));

    // A plain group can't be created empty; a channel/supergroup can.
    if(options?.broadcast || options?.megagroup) {
      const chatId = await rootScope.managers.appChatsManager.createChannel({
        title,
        about: options?.about || '',
        broadcast: options?.broadcast || undefined,
        megagroup: options?.megagroup || undefined
      } as any);

      if(userIds.length) {
        await rootScope.managers.appChatsManager.inviteToChannel(chatId, userIds);
      }

      context.audit(`created ${options?.broadcast ? 'channel' : 'supergroup'} "${title}"`);
      return {peerId: chatId.toPeerId(true), chatId};
    }

    const {chatId, missingInvitees} = await rootScope.managers.appChatsManager.createChat(title, userIds);
    context.audit(`created group "${title}"`);
    return {peerId: (chatId as ChatId).toPeerId(true), chatId, missing: missingInvitees || []};
  },

  'chats.join': async([peer], context) => {
    const chatId = await resolveChatId(peer);
    await rootScope.managers.appChatsManager.joinChannel(chatId);
    context.audit(`joined ${chatId}`);
    return true;
  },

  'chats.leave': async([peer], context) => {
    const chatId = await resolveChatId(peer);
    await rootScope.managers.appChatsManager.leave(chatId);
    context.audit(`left ${chatId}`);
    return true;
  },

  'chats.invite': async([peer, users], context) => {
    const chatId = await resolveChatId(peer);
    const userIds = await Promise.all((Array.isArray(users) ? users : [users]).map(resolveUserId));
    const missing = await rootScope.managers.appChatsManager.addChatUser(chatId, userIds);
    context.audit(`invited ${userIds.length} user(s) to ${chatId}`);
    return {missing: missing || []};
  },

  'chats.kick': async([peer, user], context) => {
    const chatId = await resolveChatId(peer);
    const userPeerId = await resolvePeerId(user);
    await rootScope.managers.appChatsManager.kickFromChat(chatId, userPeerId);
    context.audit(`kicked ${userPeerId} from ${chatId}`);
    return true;
  },

  'chats.ban': async([peer, user, options], context) => {
    const chatId = await resolveChatId(peer);
    const userPeerId = await resolvePeerId(user);
    await rootScope.managers.appChatsManager.editBanned(chatId, userPeerId, {
      _: 'chatBannedRights',
      until_date: toUnix(options?.until) || 0,
      pFlags: {view_messages: true, send_messages: true, send_media: true}
    } as any);
    context.audit(`banned ${userPeerId} in ${chatId}`);
    return true;
  },

  'chats.unban': async([peer, user], context) => {
    const chatId = await resolveChatId(peer);
    const userPeerId = await resolvePeerId(user);
    await rootScope.managers.appChatsManager.clearChannelParticipantBannedRights(chatId, userPeerId);
    context.audit(`unbanned ${userPeerId} in ${chatId}`);
    return true;
  },

  'chats.promote': async([peer, user, rights], context) => {
    const chatId = await resolveChatId(peer);
    const userId = await resolveUserId(user);
    const flags = rights || {};
    await rootScope.managers.appChatsManager.editAdmin(chatId, userId.toPeerId(false), {
      _: 'chatAdminRights',
      pFlags: {
        change_info: flags.changeInfo ?? true,
        post_messages: flags.postMessages ?? true,
        edit_messages: flags.editMessages ?? true,
        delete_messages: flags.deleteMessages ?? true,
        ban_users: flags.banUsers ?? true,
        invite_users: flags.inviteUsers ?? true,
        pin_messages: flags.pinMessages ?? true,
        manage_call: flags.manageCall ?? true,
        add_admins: flags.addAdmins || undefined,
        anonymous: flags.anonymous || undefined
      }
    } as any, flags.rank || '');
    context.audit(`promoted ${userId} in ${chatId}`);
    return true;
  },

  'chats.setTitle': async([peer, title], context) => {
    const chatId = await resolveChatId(peer);
    await rootScope.managers.appChatsManager.editTitle(chatId, title);
    context.audit(`renamed ${chatId} to "${title}"`);
    return true;
  },

  'chats.setAbout': async([peer, about], context) => {
    const chatId = await resolveChatId(peer);
    await rootScope.managers.appChatsManager.editAbout(chatId, about);
    context.audit(`set description of ${chatId}`);
    return true;
  },

  'chats.setUsername': async([peer, username], context) => {
    const chatId = await resolveChatId(peer);
    await rootScope.managers.appChatsManager.updateUsername(chatId, username);
    context.audit(`set @${username} on ${chatId}`);
    return true;
  },

  'chats.delete': async([peer], context) => {
    const chatId = await resolveChatId(peer);
    await rootScope.managers.appChatsManager.delete(chatId);
    context.audit(`DELETED chat ${chatId}`);
    return true;
  },

  'chats.inviteLink': async([peer]) => {
    const chatId = await resolveChatId(peer);
    return rootScope.managers.appProfileManager.getChatInviteLink(chatId);
  },

  'chats.exportInvite': async([peer, options], context) => {
    const chatId = await resolveChatId(peer);
    const invite: any = await rootScope.managers.appChatInvitesManager.exportChatInvite({
      chatId,
      expireDate: toUnix(options?.expireDate),
      usageLimit: options?.usageLimit,
      title: options?.title,
      requestNeeded: options?.requestNeeded
    } as any);
    context.audit(`exported an invite link for ${chatId}`);
    return invite?.link || invite;
  },

  // ---- messages ---------------------------------------------------------

  'messages.history': async([peer, options]) => readHistory(peer, options, false),

  'messages.search': async([peer, options]) => readHistory(peer, options, true),

  'messages.get': async([peer, ids]) => {
    const peerId = await resolvePeerId(peer);
    const list = Array.isArray(ids) ? ids : [ids];
    await rootScope.managers.appMessagesManager.reloadMessages(peerId, list).catch(() => {});
    return list
    .map((mid) => apiManagerProxy.getMessageByPeer(peerId, mid) as any)
    .filter((m) => m && m._ !== 'messageEmpty')
    .map(toMessageDTO);
  },

  'messages.send': async([peer, text, options], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appMessagesManager.sendText({
      peerId,
      text: String(text ?? ''),
      replyToMsgId: options?.replyTo,
      silent: options?.silent || undefined,
      scheduleDate: toUnix(options?.schedule),
      noWebPage: options?.noWebPage || undefined,
      threadId: options?.threadId,
      clearDraft: true
    });

    const preview = String(text ?? '').replace(/\s+/g, ' ').slice(0, 60);
    context.audit(`sent to ${peerId}: "${preview}"`);
    return true;
  },

  'messages.sendFile': async([peer, file, options], context) => {
    const peerId = await resolvePeerId(peer);
    // Python hands us bytes; turn them into the File the manager expects.
    const bytes: Uint8Array = file?.bytes ?? file;
    const name = file?.name || options?.name || 'file.bin';
    const blob = new File([bytes as any], name, {type: file?.mime || options?.mime || 'application/octet-stream'});

    await rootScope.managers.appMessagesManager.sendFile({
      peerId,
      file: blob,
      caption: options?.caption || undefined,
      isMedia: options?.asMedia ?? true,
      silent: options?.silent || undefined,
      scheduleDate: toUnix(options?.schedule),
      replyToMsgId: options?.replyTo
    } as any);

    context.audit(`sent file "${name}" (${bytes?.length ?? 0} bytes) to ${peerId}`);
    return true;
  },

  'messages.edit': async([peer, messageId, text], context) => {
    const {message} = await getMessage(peer, messageId);
    await rootScope.managers.appMessagesManager.editMessage(message, String(text ?? ''));
    context.audit(`edited message ${messageId}`);
    return true;
  },

  'messages.delete': async([peer, ids, revoke], context) => {
    const peerId = await resolvePeerId(peer);
    const list = Array.isArray(ids) ? ids : [ids];
    await rootScope.managers.appMessagesManager.deleteMessages(peerId, list, revoke ?? true);
    context.audit(`deleted ${list.length} message(s) in ${peerId}`);
    return true;
  },

  'messages.forward': async([toPeer, fromPeer, ids, options], context) => {
    const peerId = await resolvePeerId(toPeer);
    const fromPeerId = await resolvePeerId(fromPeer);
    const list = Array.isArray(ids) ? ids : [ids];

    await rootScope.managers.appMessagesManager.forwardMessages({
      peerId,
      fromPeerId,
      mids: list,
      silent: options?.silent || undefined,
      dropAuthor: options?.dropAuthor || undefined,
      dropCaptions: options?.dropCaptions || undefined,
      scheduleDate: toUnix(options?.schedule)
    } as any);

    context.audit(`forwarded ${list.length} message(s) ${fromPeerId} → ${peerId}`);
    return true;
  },

  'messages.pin': async([peer, messageId, options], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appMessagesManager.updatePinnedMessage(
      peerId, messageId, false, options?.silent ?? true, options?.oneSide || false
    );
    context.audit(`pinned message ${messageId} in ${peerId}`);
    return true;
  },

  'messages.unpin': async([peer, messageId], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appMessagesManager.updatePinnedMessage(peerId, messageId, true, true, false);
    context.audit(`unpinned message ${messageId} in ${peerId}`);
    return true;
  },

  'messages.unpinAll': async([peer], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appMessagesManager.unpinAllMessages(peerId);
    context.audit(`unpinned everything in ${peerId}`);
    return true;
  },

  'messages.read': async([peer, maxId], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appMessagesManager.readHistory({peerId, maxId: maxId || 0, force: true});
    context.audit(`marked ${peerId} read`);
    return true;
  },

  'messages.readAll': async([peer], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appMessagesManager.readAllHistory(peerId, undefined, true);
    context.audit(`marked all of ${peerId} read`);
    return true;
  },

  'messages.react': async([peer, messageId, emoticon], context) => {
    const {message} = await getMessage(peer, messageId);
    await rootScope.managers.appReactionsManager.sendReaction({
      message: message as Message.message,
      reaction: emoticon ? {_: 'reactionEmoji', emoticon} : undefined
    } as any);
    context.audit(`reacted ${emoticon || '(cleared)'} to ${messageId} in ${message.peerId}`);
    return true;
  },

  'messages.vote': async([peer, messageId, optionIndexes], context) => {
    const {message} = await getMessage(peer, messageId);
    const list = Array.isArray(optionIndexes) ? optionIndexes : [optionIndexes];
    await rootScope.managers.appPollsManager.sendVote(message as Message.message, list);
    context.audit(`voted in poll ${messageId}`);
    return true;
  },

  'messages.download': async([peer, messageId]) => {
    const {message} = await getMessage(peer, messageId);
    const media: any = (message as any).media;
    const doc: Document.document = media?.document;
    const photo: Photo.photo = media?.photo;

    if(!doc && !photo) throw new Error(`Message ${messageId} has no downloadable file`);

    const blob: Blob = await rootScope.managers.apiFileManager.downloadMedia({
      media: doc || photo,
      // Photos are only ever fetched at a chosen size; ask for the largest.
      thumb: photo ? choosePhotoSize(photo, 0xffff, 0xffff, true) as any : undefined
    });

    const info = mediaFileInfo(message);
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      name: info.fileName || `${messageId}.${(info.mimeType || 'application/octet-stream').split('/')[1]}`,
      mime: info.mimeType || blob.type,
      size: blob.size
    };
  },

  // ---- dialogs ----------------------------------------------------------

  'dialogs.archive': async([peer, archived], context) => {
    const peerId = await resolvePeerId(peer);
    const folderId = (archived ?? true) ? 1 : 0;
    await rootScope.managers.appMessagesManager.editPeerFolders([peerId], folderId as any);
    context.audit(`${folderId ? 'archived' : 'unarchived'} ${peerId}`);
    return true;
  },

  'dialogs.pin': async([peer], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appMessagesManager.toggleDialogPin({peerId});
    context.audit(`toggled pin on ${peerId}`);
    return true;
  },

  'dialogs.mute': async([peer, muted, until], context) => {
    const peerId = await resolvePeerId(peer);
    const shouldMute = muted ?? true;
    if(until) {
      await rootScope.managers.appMessagesManager.mutePeer({peerId, muteUntil: toUnix(until)} as any);
    } else {
      await rootScope.managers.appMessagesManager.togglePeerMute({peerId, mute: shouldMute});
    }
    context.audit(`${shouldMute ? 'muted' : 'unmuted'} ${peerId}`);
    return true;
  },

  'dialogs.markUnread': async([peer], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appMessagesManager.markDialogUnread({peerId});
    context.audit(`marked ${peerId} unread`);
    return true;
  },

  'dialogs.folders': async() => {
    const filters: any[] = await rootScope.managers.filtersStorage.getDialogFilters();
    return (filters || []).map((filter) => ({
      id: filter.id,
      title: typeof filter.title === 'string' ? filter.title : filter.title?.text,
      type: filter._
    }));
  },

  // ---- drafts -----------------------------------------------------------

  'drafts.get': async([peer]) => {
    const peerId = await resolvePeerId(peer);
    const draft: any = await rootScope.managers.appDraftsManager.getDraft(peerId);
    return draft ? {text: draft.message || '', date: draft.date} : undefined;
  },

  'drafts.set': async([peer, text], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appDraftsManager.setDraft(peerId, undefined, String(text ?? ''));
    context.audit(`set draft on ${peerId}`);
    return true;
  },

  'drafts.clear': async([peer], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appDraftsManager.clearDraft({peerId});
    context.audit(`cleared draft on ${peerId}`);
    return true;
  },

  // ---- users / contacts -------------------------------------------------

  'users.contacts': async([query]) => {
    const userIds: UserId[] = await rootScope.managers.appUsersManager.getContacts(query);
    const out: PeerDTO[] = [];
    for(const userId of userIds) {
      const peerId = userId.toPeerId(false);
      out.push(toPeerDTO(peerId, await rootScope.managers.appPeersManager.getPeer(peerId)));
    }
    return out;
  },

  'users.addContact': async([peer, options], context) => {
    const userId = await resolveUserId(peer);
    await rootScope.managers.appUsersManager.addContact(
      userId, options?.firstName || '', options?.lastName || '', options?.phone || '', options?.showPhone
    );
    context.audit(`added contact ${userId}`);
    return true;
  },

  'users.deleteContacts': async([peers], context) => {
    const list = Array.isArray(peers) ? peers : [peers];
    const userIds = await Promise.all(list.map(resolveUserId));
    await rootScope.managers.appUsersManager.deleteContacts(userIds);
    context.audit(`deleted ${userIds.length} contact(s)`);
    return true;
  },

  'users.block': async([peer], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appUsersManager.toggleBlock(peerId, true);
    context.audit(`blocked ${peerId}`);
    return true;
  },

  'users.unblock': async([peer], context) => {
    const peerId = await resolvePeerId(peer);
    await rootScope.managers.appUsersManager.toggleBlock(peerId, false);
    context.audit(`unblocked ${peerId}`);
    return true;
  },

  'users.blocked': async([options]) => {
    const result: any = await rootScope.managers.appUsersManager.getBlocked(
      options?.offset || 0, clampLimit(options?.limit)
    );
    const peerIds: PeerId[] = result?.peerIds || [];
    const out: PeerDTO[] = [];
    for(const peerId of peerIds) {
      out.push(toPeerDTO(peerId, await rootScope.managers.appPeersManager.getPeer(peerId)));
    }
    return {count: result?.count ?? out.length, peers: out};
  },

  'users.commonChats': async([peer, limit]) => {
    const userId = await resolveUserId(peer);
    const result: any = await rootScope.managers.appUsersManager.getCommonChats(userId, clampLimit(limit));
    const chatIds: ChatId[] = result?.chats?.map((c: any) => c.id) || [];
    const out: PeerDTO[] = [];
    for(const chatId of chatIds) {
      const peerId = chatId.toPeerId(true);
      out.push(toPeerDTO(peerId, await rootScope.managers.appPeersManager.getPeer(peerId)));
    }
    return out;
  },

  'users.search': async([query, limit]) => {
    const result: any = await rootScope.managers.appUsersManager.searchContacts(query, clampLimit(limit));
    const peerIds = [
      ...(result?.my_results || []),
      ...(result?.results || [])
    ].map(peerToPeerId).filter(Boolean);

    const out: PeerDTO[] = [];
    for(const peerId of peerIds) {
      out.push(toPeerDTO(peerId, await rootScope.managers.appPeersManager.getPeer(peerId)));
    }
    return out;
  },

  // ---- own account ------------------------------------------------------

  'account.updateProfile': async([options], context) => {
    await rootScope.managers.appProfileManager.updateProfile(
      options?.firstName, options?.lastName, options?.about
    );
    context.audit('updated own profile');
    return true;
  },

  'account.updateUsername': async([username], context) => {
    await rootScope.managers.appUsersManager.updateUsername(username);
    context.audit(`set own username to @${username}`);
    return true;
  },

  'account.setOnline': async([online], context) => {
    await rootScope.managers.appUsersManager.updateMyOnlineStatus(!online);
    context.audit(`set own status ${online ? 'online' : 'offline'}`);
    return true;
  }
};

export const API: Record<string, Handler> = new Proxy(HANDLERS, {
  get(target, property: string) {
    const handler = target[property];
    if(!handler) return undefined;
    if(!WRITE_METHODS.has(property)) return handler;

    return async(args: any[], context: ApiContext) => {
      if(!context.allowWrites) {
        throw new Error(
          `tg.${property} modifies your account and the console's Writes switch is off. ` +
          'Turn on "Writes" in the header to allow it.'
        );
      }

      await takeWriteToken();
      context.assertAlive();
      return handler(args, context);
    };
  }
}) as any;
