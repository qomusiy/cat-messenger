/*
 * Main-thread half of the script console. Owns the sandbox worker's lifetime,
 * resolves its `tg.*` calls against the `API` allow-list, and guarantees the
 * run can always be stopped (explicit stop, idle timeout, or a failed call).
 *
 * The worker is deliberately kept alive between runs: booting CPython costs a
 * couple of seconds and paying that on every Run press would make the console
 * feel broken. It is only torn down when a run has to be killed — which is also
 * the only way to interrupt Python mid-loop without SharedArrayBuffer, and this
 * app is not cross-origin isolated.
 */

import SandboxWorker from './sandbox.worker.ts?worker';
import {API, ApiContext} from './api';
import type {HostToWorker, WorkerToHost} from './protocol';

/*
 * An *idle* timeout, not a wall clock: it resets on every log line and every
 * `tg.*` call. A 20-minute channel dump that keeps making progress is fine;
 * a `while True: pass` with nothing to show for itself is not.
 */
const IDLE_TIMEOUT = 90_000;

export type RunHandlers = {
  onLog: (level: 'log' | 'warn' | 'error', text: string) => void,
  onStatus: (text: string) => void,
  onOutput: (message: Extract<WorkerToHost, {kind: 'output'}>) => void,
  onAudit: (text: string) => void,
  onDone: (ok: boolean, error?: string) => void
};

export type RunHandle = {
  /** Terminates the worker; onDone fires with the cancellation reason. */
  stop: (reason?: string) => void
};

export type RunOptions = {
  allowWrites: boolean
};

let worker: Worker;
/** Set while a run is in flight; null between runs, when the worker idles. */
let active: {
  handlers: RunHandlers,
  context: ApiContext,
  finish: (ok: boolean, error?: string) => void
};

/** Where the self-hosted Pyodide runtime lives — see scripts/sync-pyodide.mjs. */
function pyodideUrl() {
  return new URL('pyodide/', document.baseURI).href;
}

function disposeWorker() {
  worker?.terminate();
  worker = undefined;
}

function ensureWorker() {
  if(worker) return worker;

  worker = new (SandboxWorker as any)();

  worker.onmessage = async(event: MessageEvent<WorkerToHost>) => {
    const message = event.data;
    const run = active;
    if(!run) return;

    switch(message.kind) {
      case 'log':
        run.context.touch();
        run.handlers.onLog(message.level, message.text);
        break;

      case 'status':
        run.handlers.onStatus(message.text);
        break;

      case 'output':
        run.context.touch();
        run.handlers.onOutput(message);
        break;

      case 'done':
        run.finish(message.ok, message.error);
        break;

      case 'call': {
        run.context.touch();

        const handler = API[message.method];
        if(!handler) {
          send({kind: 'result', id: message.id, ok: false, error: `tg.${message.method} is not available`});
          return;
        }

        try {
          const value = await handler(message.args || [], run.context);
          run.context.assertAlive();
          run.context.touch();
          send({kind: 'result', id: message.id, ok: true, value});
        } catch(err: any) {
          send({kind: 'result', id: message.id, ok: false, error: err?.message || String(err)});
        }
        break;
      }
    }
  };

  worker.onerror = (event) => {
    active?.finish(false, event.message || 'sandbox worker crashed');
    disposeWorker();
  };

  return worker;
}

function send(message: HostToWorker) {
  worker?.postMessage(message);
}

export function runScript(code: string, handlers: RunHandlers, options: RunOptions): RunHandle {
  if(active) {
    handlers.onDone(false, 'A script is already running.');
    return {stop: () => {}};
  }

  let finished = false;
  let timer: number;

  const finish = (ok: boolean, error?: string, kill = false) => {
    if(finished) return;
    finished = true;
    active = undefined;
    clearTimeout(timer);
    // Python cannot be interrupted in place here, so anything that ends a run
    // early has to take the whole interpreter with it.
    if(kill) disposeWorker();
    handlers.onDone(ok, error);
  };

  const touch = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      finish(false, `No activity for ${Math.round(IDLE_TIMEOUT / 1000)}s — script stopped.`, true);
    }, IDLE_TIMEOUT);
  };

  const context: ApiContext = {
    assertAlive: () => {
      if(finished) throw new Error('run cancelled');
    },
    allowWrites: options.allowWrites,
    audit: (text) => handlers.onAudit(text),
    touch
  };

  active = {handlers, context, finish};
  touch();

  ensureWorker();
  send({kind: 'run', code, pyodideUrl: pyodideUrl(), allowWrites: options.allowWrites});

  return {
    stop: (reason = 'Stopped.') => finish(false, reason, true)
  };
}

/** Frees the ~100MB Pyodide heap when the console closes. */
export function shutdownSandbox() {
  active?.finish(false, 'Stopped.');
  disposeWorker();
}
