/*
 * Main-thread half of the script console. Owns the sandbox worker's lifetime,
 * resolves its `tg.*` calls against the `API` allow-list, and guarantees the
 * run can always be stopped (explicit stop, hard timeout, or a failed call).
 */

import SandboxWorker from './sandbox.worker.ts?worker';
import {API, ApiContext} from './api';
import type {HostToWorker, WorkerToHost} from './protocol';

const DEFAULT_TIMEOUT = 60_000;

export type RunHandlers = {
  onLog: (level: 'log' | 'warn' | 'error', text: string) => void,
  onOutput: (value: any, label?: string) => void,
  onDone: (ok: boolean, error?: string) => void
};

export type RunHandle = {
  /** Terminates the worker; onDone fires with the cancellation reason. */
  stop: (reason?: string) => void
};

export function runScript(code: string, handlers: RunHandlers, timeout = DEFAULT_TIMEOUT): RunHandle {
  const worker: Worker = new (SandboxWorker as any)();
  let finished = false;

  const context: ApiContext = {
    assertAlive: () => {
      if(finished) throw new Error('run cancelled');
    }
  };

  const finish = (ok: boolean, error?: string) => {
    if(finished) return;
    finished = true;
    clearTimeout(timer);
    worker.terminate();
    handlers.onDone(ok, error);
  };

  const timer = setTimeout(() => {
    finish(false, `Script exceeded the ${Math.round(timeout / 1000)}s time limit and was stopped.`);
  }, timeout);

  const send = (message: HostToWorker) => {
    if(!finished) worker.postMessage(message);
  };

  worker.onmessage = async(event: MessageEvent<WorkerToHost>) => {
    const message = event.data;
    if(finished) return;

    switch(message.kind) {
      case 'log':
        handlers.onLog(message.level, message.text);
        break;

      case 'output':
        handlers.onOutput(message.value, message.label);
        break;

      case 'done':
        finish(message.ok, message.error);
        break;

      case 'call': {
        const handler = API[message.method];
        if(!handler) {
          send({kind: 'result', id: message.id, ok: false, error: `tg.${message.method} is not available`});
          return;
        }

        try {
          const value = await handler(message.args || [], context);
          context.assertAlive();
          send({kind: 'result', id: message.id, ok: true, value});
        } catch(err: any) {
          send({kind: 'result', id: message.id, ok: false, error: err?.message || String(err)});
        }
        break;
      }
    }
  };

  worker.onerror = (event) => {
    finish(false, event.message || 'sandbox worker crashed');
  };

  send({kind: 'run', code});

  return {
    stop: (reason = 'Stopped.') => finish(false, reason)
  };
}
