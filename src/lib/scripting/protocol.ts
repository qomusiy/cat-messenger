/*
 * Wire protocol between the script sandbox worker and the main-thread broker.
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

export type ScriptOutput = {
  kind: 'output',
  label?: string,
  value: any
};

export type ScriptDone = {
  kind: 'done',
  ok: boolean,
  error?: string
};

export type WorkerToHost = ScriptCall | ScriptLog | ScriptOutput | ScriptDone;

export type HostToWorker = {
  kind: 'run',
  code: string
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
  outgoing: boolean
};

export type PeerDTO = {
  peerId: PeerId,
  type: 'user' | 'chat' | 'channel',
  title: string,
  username?: string
};
