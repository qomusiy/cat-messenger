// Folds `public/` into `dist/` so the build output is a complete, self-contained
// static site that any dumb file host (Render Static Site, Netlify, Pages, nginx)
// can serve from a single directory.
//
// Upstream tweb doesn't need this: vite.config.ts sets `copyPublicDir: false`
// because the official deploy serves `dist/` and `public/` as two separate roots
// (see server.js, which mounts express.static twice). We deploy one directory,
// so the two roots have to be merged after the bundle is written.
//
// Files already emitted by Vite ALWAYS win — `public/` still holds a few stale
// hash-named leftovers from an old build (Temml-*.woff2, tlottie-*.wasm, …) and
// a blind copy could clobber fresh bundle output with them.

import {cp, mkdir, readdir, stat, access} from 'fs/promises';
import {constants} from 'fs';
import {join, resolve, dirname} from 'path';
import {fileURLToPath} from 'url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(rootDir, 'public');
const distDir = join(rootDir, 'dist');

const exists = (path) => access(path, constants.F_OK).then(() => true, () => false);

let copied = 0;
let skipped = 0;
let bytes = 0;

async function merge(relative) {
  const from = join(publicDir, relative);
  const to = join(distDir, relative);
  const entry = await stat(from);

  if(entry.isDirectory()) {
    await mkdir(to, {recursive: true});
    for(const name of await readdir(from)) {
      await merge(join(relative, name));
    }

    return;
  }

  if(await exists(to)) { // Vite emitted it — keep the fresh one
    ++skipped;
    return;
  }

  await cp(from, to);
  ++copied;
  bytes += entry.size;
}

if(!await exists(distDir)) {
  console.error('prepare-static: dist/ not found — run `vite build` first');
  process.exit(1);
}

for(const name of await readdir(publicDir)) {
  await merge(name);
}

console.log(
  `prepare-static: copied ${copied} files (${(bytes / 1024 / 1024).toFixed(1)} MB) ` +
  `from public/ into dist/, skipped ${skipped} already emitted by the bundle`
);
