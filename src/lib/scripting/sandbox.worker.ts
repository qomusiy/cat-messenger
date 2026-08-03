/*
 * Script sandbox. Runs user-authored code off the main thread so a runaway
 * loop cannot freeze the UI, and with the network/storage globals stripped so
 * a script's ONLY route to the account is the audited `tg.*` bridge below —
 * which the broker resolves against an allow-list of manager calls.
 *
 * This is a containment boundary, not a security guarantee against code the
 * user deliberately runs: a script can still read anything `tg.*` exposes.
 */

import type {HostToWorker, WorkerToHost} from './protocol';

const ctx = self as any;
const post = (message: WorkerToHost) => ctx.postMessage(message);

// Remove the escape hatches. A script that wants the network must go through
// `tg.*` (and therefore through the app managers) or not at all.
const STRIPPED = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'importScripts',
  'indexedDB',
  'caches',
  'Notification',
  'BroadcastChannel',
  'SharedWorker',
  'Worker'
];

for(const name of STRIPPED) {
  try {
    Object.defineProperty(ctx, name, {value: undefined, configurable: false, writable: false});
  } catch(err) {}
}

let nextCallId = 1;
const pending = new Map<number, {resolve: (value: any) => void, reject: (error: Error) => void}>();

function call(method: string, args: any[]) {
  const id = nextCallId++;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    post({kind: 'call', id, method, args});
  });
}

function stringify(value: any): string {
  if(typeof value === 'string') return value;
  if(value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value, null, 2);
  } catch(err) {
    return String(value);
  }
}

const consoleShim = {
  log: (...parts: any[]) => post({kind: 'log', level: 'log', text: parts.map(stringify).join(' ')}),
  info: (...parts: any[]) => post({kind: 'log', level: 'log', text: parts.map(stringify).join(' ')}),
  warn: (...parts: any[]) => post({kind: 'log', level: 'warn', text: parts.map(stringify).join(' ')}),
  error: (...parts: any[]) => post({kind: 'log', level: 'error', text: parts.map(stringify).join(' ')})
};

const tg = {
  /** The signed-in account. */
  me: () => call('me', []),

  /** Pause. Capped so a script cannot park the worker forever. */
  sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, 60000)))),

  peer: {
    /** '@durov' | 'durov' | numeric peerId -> PeerDTO */
    resolve: (peer: string | number) => call('peer.resolve', [peer])
  },

  chats: {
    /** Your dialog list. {limit = 50, query} */
    list: (options?: {limit?: number, query?: string}) => call('chats.list', [options])
  },

  messages: {
    /** Newest-first history page. {limit = 50, offsetId} */
    history: (
      peer: string | number,
      options?: {limit?: number, offsetId?: number}
    ) => call('messages.history', [peer, options]),

    /**
     * Server-side search inside a peer.
     * {query, filter: 'photo'|'video'|'url'|'document'|'music'|'voice'|'gif'|'roundVideo'|'photoVideo'|'pinned',
     *  limit = 50, offsetId, fromPeer, minDate, maxDate}
     */
    search: (
      peer: string | number,
      options?: {
        query?: string,
        filter?: string,
        limit?: number,
        offsetId?: number,
        fromPeer?: string | number,
        minDate?: number,
        maxDate?: number
      }
    ) => call('messages.search', [peer, options])
  },

  output: {
    /** Render a value in the output pane and make it downloadable as JSON. */
    json: (value: any, label?: string) => {
      post({kind: 'output', value, label});
    }
  }
};

ctx.onmessage = async(event: MessageEvent<HostToWorker>) => {
  const message = event.data;

  if(message.kind === 'result') {
    const entry = pending.get(message.id);
    if(!entry) return;
    pending.delete(message.id);
    if(message.ok) entry.resolve(message.value);
    else entry.reject(new Error(message.error || 'call failed'));
    return;
  }

  if(message.kind === 'run') {
    try {
      // Wrapped in an async IIFE so scripts can use top-level await.
      const fn = new Function('tg', 'console', `return (async () => {\n${message.code}\n})();`);
      await fn(tg, consoleShim);
      post({kind: 'done', ok: true});
    } catch(err: any) {
      post({kind: 'done', ok: false, error: (err && (err.stack || err.message)) || String(err)});
    }
  }
};
