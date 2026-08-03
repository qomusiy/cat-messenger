/*
 * The allow-list behind `tg.*`. Every entry goes through an app manager — never
 * `apiManager.invokeApi` directly — so caching, `saveApiPeers` and update
 * dispatch all behave exactly as they do for the rest of the app.
 *
 * Read-only by design: nothing here sends, edits or deletes. Write support is
 * meant to land behind a rate limiter + explicit confirmation, not by widening
 * this table.
 */

import rootScope from '@lib/rootScope';
import apiManagerProxy from '@lib/apiManagerProxy';
import type {Chat, Message, User} from '@layer';
import type {MessageDTO, PeerDTO} from './protocol';

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
  pinned: 'inputMessagesFilterPinned'
};

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
  return {peerId, type, title: peerTitle(peer), username: peerUsername(peer)};
}

function toMessageDTO(message: Message.message | Message.messageService | any): MessageDTO {
  if(!message) return undefined;
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
    outgoing: !!message.pFlags?.out
  };
}

async function resolvePeerId(peer: string | number): Promise<PeerId> {
  if(peer === undefined || peer === null || peer === '') {
    throw new Error('peer is required');
  }

  if(typeof peer === 'number') return peer as PeerId;

  const raw = String(peer).trim();
  if(/^-?\d+$/.test(raw)) return +raw as PeerId;

  const resolved: any = await rootScope.managers.appUsersManager.resolveUsername(raw);
  if(!resolved) throw new Error('Could not resolve peer: ' + raw);

  return resolved._ === 'user' ?
    (resolved.id as UserId).toPeerId(false) :
    (resolved.id as ChatId).toPeerId(true);
}

async function readHistory(peer: string | number, options: any = {}, search = false) {
  const peerId = await resolvePeerId(peer);
  const limit = Math.max(1, Math.min(options?.limit ?? 50, MAX_LIMIT));

  const filterName = options?.filter || 'all';
  const filter = FILTERS[filterName];
  if(!filter) {
    throw new Error(`Unknown filter '${filterName}'. Use one of: ${Object.keys(FILTERS).join(', ')}`);
  }

  const requestOptions: any = {
    peerId,
    limit,
    offsetId: options?.offsetId || 0,
    inputFilter: {_: filter}
  };

  if(search) {
    if(options?.query) requestOptions.query = options.query;
    if(options?.minDate) requestOptions.minDate = Math.floor(options.minDate / 1000) || options.minDate;
    if(options?.maxDate) requestOptions.maxDate = Math.floor(options.maxDate / 1000) || options.maxDate;
    if(options?.fromPeer) requestOptions.fromPeerId = await resolvePeerId(options.fromPeer);
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

export type ApiContext = {
  /** Throws if the run was cancelled — checked before each call resolves. */
  assertAlive: () => void
};

export const API: Record<string, (args: any[], context: ApiContext) => Promise<any>> = {
  'me': async() => {
    const peerId = rootScope.myId;
    const peer = await rootScope.managers.appPeersManager.getPeer(peerId);
    return toPeerDTO(peerId, peer);
  },

  'peer.resolve': async([peer]) => {
    const peerId = await resolvePeerId(peer);
    const full = await rootScope.managers.appPeersManager.getPeer(peerId);
    return toPeerDTO(peerId, full);
  },

  'chats.list': async([options]) => {
    const limit = Math.max(1, Math.min(options?.limit ?? 50, MAX_LIMIT));
    const result: any = await rootScope.managers.dialogsStorage.getDialogs({
      limit,
      query: options?.query
    });

    const dialogs = result?.dialogs || [];
    const out: any[] = [];
    for(const dialog of dialogs) {
      const peer = await rootScope.managers.appPeersManager.getPeer(dialog.peerId);
      out.push({
        ...toPeerDTO(dialog.peerId, peer),
        unread: dialog.unread_count || 0,
        topMessageId: dialog.top_message
      });
    }

    return {count: result?.count ?? out.length, chats: out};
  },

  'messages.history': async([peer, options]) => readHistory(peer, options, false),

  'messages.search': async([peer, options]) => readHistory(peer, options, true)
};
