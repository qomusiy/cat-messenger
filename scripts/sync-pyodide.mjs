// Mirrors the Pyodide runtime files out of node_modules into `public/pyodide/`,
// which is the only place both halves of the pipeline can see them: Vite serves
// `public/` at the web root in dev, and `scripts/prepare-static.mjs` folds it
// into `dist/` at build time.
//
// They are copied rather than committed — ~13MB of wasm + stdlib has no business
// in git when the exact bytes are already pinned by the pnpm lockfile. Hence
// `public/pyodide/` is gitignored and this runs from vite.config.ts on every
// `pnpm start` / `pnpm build`.
//
// Self-hosted on purpose: the script sandbox strips network access before it
// hands control to user code, so a CDN fetch would be both a privacy leak and
// a hard dependency on jsdelivr being up.

import {copyFileSync, existsSync, mkdirSync, statSync} from 'fs';
import {join, resolve, dirname} from 'path';
import {fileURLToPath} from 'url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(rootDir, 'node_modules', 'pyodide');
const to = join(rootDir, 'public', 'pyodide');

// Everything `loadPyodide({indexURL})` resolves at runtime. `pyodide.mjs` itself
// is NOT here — that one is imported by the worker and bundled by Vite.
const FILES = [
  'pyodide.asm.js',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json'
];

export default function syncPyodide() {
  if(!existsSync(from)) {
    console.warn('sync-pyodide: node_modules/pyodide missing — run `pnpm install`');
    return;
  }

  mkdirSync(to, {recursive: true});

  let copied = 0;
  for(const name of FILES) {
    const source = join(from, name);
    if(!existsSync(source)) continue; // optional across pyodide versions

    const target = join(to, name);
    // Size+mtime is enough to skip the 9.6MB wasm on every dev-server restart.
    if(existsSync(target) && statSync(target).size === statSync(source).size) continue;

    copyFileSync(source, target);
    ++copied;
  }

  if(copied) console.log(`sync-pyodide: copied ${copied} file(s) → public/pyodide/`);
}

// Allow `node scripts/sync-pyodide.mjs` as well as the vite.config.ts import.
if(process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  syncPyodide();
}
