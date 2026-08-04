/*
 * Script sandbox. Boots CPython (Pyodide, WASM) off the main thread so a
 * runaway loop cannot freeze the UI, then hands the user's Python the `tg`
 * object defined in runtime.py — whose only route to the account is the audited
 * bridge below, which the broker resolves against an allow-list of manager
 * calls.
 *
 * Network globals are stripped once Pyodide has finished booting (it needs
 * `fetch` to pull its own wasm + stdlib, so the order matters): after that the
 * only URLs `fetch` will accept are the runtime's own, and a script's sole way
 * out is `tg.*`.
 *
 * This is a containment boundary, not a security guarantee against code the
 * user deliberately runs. Two known gaps, kept honest rather than papered over:
 * a script can read anything `tg.*` exposes, and because the worker is an ES
 * module, `import()` (reachable from Python via the `js` module) is not blocked.
 * Closing the latter needs a CSP `worker-src`/`connect-src` on the document.
 */

import type {HostToWorker, WorkerToHost} from './protocol';
import RUNTIME_SOURCE from './runtime.py?raw';

const ctx = self as any;
const post = (message: WorkerToHost) => ctx.postMessage(message);

let pyodide: any;
let booting: Promise<any>;

// Remove the escape hatches. A script that wants the network must go through
// `tg.*` (and therefore through the app managers) or not at all.
const STRIPPED = [
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

/**
 * `fetch` survives boot in restricted form rather than being deleted outright:
 * Pyodide reaches for it lazily (package loading, stdlib faulting) and dies
 * confusingly if it is gone, so instead it is pinned to the runtime directory.
 */
function lockDownNetwork(pyodideUrl: string) {
  for(const name of STRIPPED) {
    try {
      Object.defineProperty(ctx, name, {value: undefined, configurable: false, writable: false});
    } catch(err) {}
  }

  const realFetch: typeof fetch = ctx.fetch?.bind(ctx);
  const allowedPrefix = new URL(pyodideUrl, ctx.location.href).href;

  const restrictedFetch = (input: any, init?: any) => {
    const raw = typeof input === 'string' ? input : input?.url;
    let href: string;
    try {
      href = new URL(raw, ctx.location.href).href;
    } catch(err) {
      href = '';
    }

    if(!href.startsWith(allowedPrefix)) {
      return Promise.reject(new Error(
        'Network access is blocked inside the script sandbox — use tg.* to reach Telegram.'
      ));
    }

    return realFetch(input, init);
  };

  try {
    Object.defineProperty(ctx, 'fetch', {value: restrictedFetch, configurable: false, writable: false});
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

/*
 * Python hands these two everything already converted by `to_js`, so the values
 * arriving here are ordinary JS arrays/objects/Uint8Arrays — structured
 * cloneable as-is, no marshalling needed on this side.
 */
const bridge = {
  call: (method: string, args: any[]) => call(method, args),

  output: (value: any, label: string, format: string, filename: string, mime: string) => {
    post({
      kind: 'output',
      value,
      label: label || undefined,
      format: (format as any) || 'json',
      filename: filename || undefined,
      mime: mime || undefined
    });
  }
};

async function boot(pyodideUrl: string) {
  post({kind: 'status', text: 'Starting Python…'});

  const {loadPyodide} = await import('pyodide');
  const instance = await loadPyodide({
    indexURL: pyodideUrl,
    stdout: (text: string) => post({kind: 'log', level: 'log', text}),
    stderr: (text: string) => post({kind: 'log', level: 'warn', text})
  });

  lockDownNetwork(pyodideUrl);

  instance.registerJsModule('_tg_bridge', bridge);
  // runtime.py runs in the user's own namespace, so `tg` (and the `Box` helper)
  // are simply there — no import line to remember at the top of every script.
  instance.runPython(RUNTIME_SOURCE);

  post({kind: 'status', text: `Python ${instance.version} ready`});
  return instance;
}

function formatError(error: any) {
  if(!error) return 'failed';

  const text = error.message || String(error);
  // Pyodide prefixes real tracebacks; keep those verbatim, they're the useful bit.
  const traceback = text.indexOf('Traceback (most recent call last):');
  return traceback === -1 ? text : text.slice(traceback);
}

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
      pyodide ??= await (booting ??= boot(message.pyodideUrl));
      // `runPythonAsync` compiles with top-level await enabled, so scripts read
      // like the body of an async function without any wrapper of ours.
      await pyodide.runPythonAsync(message.code);
      post({kind: 'done', ok: true});
    } catch(err: any) {
      post({kind: 'done', ok: false, error: formatError(err)});
    }
  }
};
