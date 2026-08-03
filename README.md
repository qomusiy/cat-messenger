# Cat Messenger

A Telegram web client — a fork of [Telegram Web K](https://github.com/morethanwords/tweb) with
its own branding, a cat-themed chat wallpaper, and a built-in **code console** that lets you
script your own account.

Everything runs in the browser. MTProto is spoken directly from the tab to Telegram's data
centres over WebSocket, so there is no backend of any kind — the whole app is a folder of
static files.

## The code console

Open the ☰ menu → **Code console** (or press <kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>Shift</kbd> +
<kbd>K</kbd>). You get an editor and an output pane; your script runs in a sandboxed Web Worker
with an async `tg` object bound to your live session.

```js
// dump the last 200 posts of a channel to JSON
let all = [], offsetId = 0;
while(all.length < 200) {
  const {messages} = await tg.messages.history('@durov', {limit: 100, offsetId});
  if(!messages.length) break;
  all = all.concat(messages);
  offsetId = messages[messages.length - 1].id;
}
tg.output.json(all, 'durov-history');
```

Available: `tg.me()`, `tg.chats.list()`, `tg.peer.resolve()`, `tg.messages.history()`,
`tg.messages.search()`, `tg.output.json()`, `tg.sleep()`, `console.log()`. Top-level `await`
works. Five worked examples ship in the dropdown.

**It is read-only.** Nothing in the API can send, edit or delete — scripts can only read your
account and emit data. The sandbox also has `fetch`, `XMLHttpRequest`, `WebSocket`,
`indexedDB` and `caches` stripped from its global scope, so a script cannot exfiltrate
anything: the only way out is `tg.*`, which goes through the app's own managers.

## Developing

```bash
pnpm install
pnpm start      # http://localhost:8080
```

Put your own credentials from https://my.telegram.org/apps into `.env.local` (gitignored):

```
VITE_API_ID=…
VITE_API_HASH=…
```

Other commands: `pnpm build` (production), `pnpm test` (vitest), `pnpm lint` (oxlint),
`pnpm typecheck`.

Query params: `?test=1` test DCs · `?debug=1` verbose logging · `?noSharedWorker=1` ·
`?http=1` force HTTP transport. Call `showIconLibrary()` in devtools to preview every SVG icon.

Agent/contributor conventions live in [AGENTS.md](AGENTS.md).

## Deploying

`pnpm build` writes a complete, self-contained site to `dist/` — the Vite bundle plus the
contents of `public/` folded in on top ([scripts/prepare-static.mjs](scripts/prepare-static.mjs)).
Serve that one directory from anything.

[render.yaml](render.yaml) is a Render Blueprint for a **Static Site**: dashboard → New →
Blueprint → pick this repo. Set `VITE_API_ID` and `VITE_API_HASH` when prompted. Static Sites
are CDN-served and never spin down, unlike Render's free Web Services.

Any other static host works the same way — publish `dist/` and serve it over HTTPS (the
service worker and Web Crypto both need a secure context). No SPA rewrite rule is needed:
the app routes in the URL hash, so the path is always `/`.

Locally: `node server.js --dist` or `python3 -m http.server -d dist`.

## Credits & licence

Built on [tweb](https://github.com/morethanwords/tweb) by Eduard Kuzmenko, itself based on
Webogram. Not affiliated with or endorsed by Telegram.

GPL v3 — see [LICENSE](LICENSE). Third-party dependencies and their licences are listed in
[CREDITS.md](CREDITS.md).
