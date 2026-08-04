/*
 * Wire protocol between the script sandbox worker (Python/Pyodide) and the
 * main-thread broker.
 *
 * The worker can only reach the account through `call` messages, which the
 * broker resolves against a hard-coded allow-list of manager-backed methods
 * (see `api.ts`). Nothing here carries an auth key or raw MTProto payload.
 */

export type ScriptCall = {
  kind: 'call',
  id: number,
  method: string,
  args: any[]
};

export type ScriptLog = {
  kind: 'log',
  level: 'log' | 'warn' | 'error',
  text: string
};

/** Runtime lifecycle chatter — Pyodide boot, package installs. */
export type ScriptStatus = {
  kind: 'status',
  text: string
};

export type ScriptOutput = {
  kind: 'output',
  label?: string,
  value: any,
  /** How the console should render it. `file` additionally offers a download. */
  format?: 'json' | 'table' | 'csv' | 'text' | 'file',
  /** For `file`: the suggested download name and MIME type. */
  filename?: string,
  mime?: string
};

export type ScriptDone = {
  kind: 'done',
  ok: boolean,
  error?: string
};

export type WorkerToHost = ScriptCall | ScriptLog | ScriptStatus | ScriptOutput | ScriptDone;

export type HostToWorker = {
  kind: 'run',
  code: string,
  /** Where the self-hosted Pyodide runtime lives; resolved by the main thread. */
  pyodideUrl: string,
  /** Mirrors the console's Writes switch — see `WRITE_METHODS` in api.ts. */
  allowWrites: boolean
} | {
  kind: 'result',
  id: number,
  ok: boolean,
  value?: any,
  error?: string
};

/** Shape handed to scripts for each message — a stable subset of MyMessage. */
export type MessageDTO = {
  id: number,
  peerId: PeerId,
  fromId: PeerId,
  date: number,
  text: string,
  media: string,
  views?: number,
  forwards?: number,
  replyToMsgId?: number,
  groupedId?: string,
  outgoing: boolean,
  /** Present when the message carries a downloadable document/photo. */
  hasFile?: boolean,
  fileName?: string,
  fileSize?: number,
  mimeType?: string,
  editDate?: number,
  pinned?: boolean,
  /** `[{reaction, count, chosen}]` when anyone has reacted. */
  reactions?: {reaction: string, count: number, chosen: boolean}[]
};

export type PeerDTO = {
  peerId: PeerId,
  type: 'user' | 'chat' | 'channel',
  title: string,
  username?: string,
  /** Users only. */
  firstName?: string,
  lastName?: string,
  phone?: string,
  bot?: boolean,
  premium?: boolean,
  verified?: boolean,
  contact?: boolean,
  deleted?: boolean,
  /** Chats/channels only. */
  broadcast?: boolean,
  megagroup?: boolean,
  forum?: boolean,
  participantsCount?: number
};

export type DialogDTO = PeerDTO & {
  unread: number,
  topMessageId: number,
  pinned: boolean,
  muted: boolean,
  folderId: number
};

export type ParticipantDTO = PeerDTO & {
  /** 'creator' | 'admin' | 'member' | 'banned' | 'left' */
  role: string,
  joinedDate?: number
};
