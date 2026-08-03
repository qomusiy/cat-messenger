import {createSignal, For, onCleanup, onMount, Show} from 'solid-js';
import {runScript, RunHandle} from '@lib/scripting/broker';
import overlayCounter from '@helpers/overlayCounter';
import styles from './scriptConsole.module.scss';

const STORAGE_KEY = 'cat-script-console-draft';

type Entry = {
  type: 'log' | 'json',
  level?: 'log' | 'warn' | 'error' | 'system',
  text?: string,
  label?: string,
  value?: any
};

const EXAMPLES: {name: string, code: string}[] = [
  {
    name: 'Who am I',
    code: `const me = await tg.me();\nconsole.log('Signed in as', me.title, '/ peerId', me.peerId);`
  },
  {
    name: 'List my chats',
    code: `const {chats, count} = await tg.chats.list({limit: 30});\nconsole.log('total dialogs:', count);\nfor(const c of chats) {\n  console.log(\`\${c.type.padEnd(8)} \${String(c.unread).padStart(4)} unread  \${c.title}\`);\n}\ntg.output.json(chats, 'chats');`
  },
  {
    name: 'Dump a channel to JSON',
    code: `// Change this to any channel you follow\nconst channel = '@durov';\n\nlet all = [], offsetId = 0;\nwhile(all.length < 200) {\n  const {messages} = await tg.messages.history(channel, {limit: 100, offsetId});\n  if(!messages.length) break;\n  all = all.concat(messages);\n  offsetId = messages[messages.length - 1].id;\n  console.log('fetched', all.length);\n}\n\nconsole.log('done:', all.length, 'messages');\ntg.output.json(all, channel + '-history');`
  },
  {
    name: 'Search only videos',
    code: `const {messages, count} = await tg.messages.search('@durov', {\n  filter: 'video',\n  limit: 50\n});\nconsole.log('videos found:', count);\ntg.output.json(messages, 'videos');`
  },
  {
    name: 'Channel activity by hour',
    code: `const {messages} = await tg.messages.history('@durov', {limit: 200});\nconst byHour = {};\nfor(const m of messages) {\n  const h = new Date(m.date * 1000).getHours();\n  byHour[h] = (byHour[h] || 0) + 1;\n}\nfor(let h = 0; h < 24; h++) {\n  const n = byHour[h] || 0;\n  console.log(String(h).padStart(2, '0') + ':00 ' + '#'.repeat(n));\n}\ntg.output.json(byHour, 'activity-by-hour');`
  }
];

export default function ScriptConsole(props: {onClose: () => void}) {
  const [code, setCode] = createSignal(
    localStorage.getItem(STORAGE_KEY) ?? EXAMPLES[0].code
  );
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [running, setRunning] = createSignal(false);

  let handle: RunHandle;
  let outputRef: HTMLDivElement;
  let editorRef: HTMLTextAreaElement;

  const push = (entry: Entry) => {
    setEntries((prev) => [...prev, entry]);
    queueMicrotask(() => outputRef && (outputRef.scrollTop = outputRef.scrollHeight));
  };

  const run = () => {
    if(running()) return;
    setEntries([]);
    setRunning(true);
    localStorage.setItem(STORAGE_KEY, code());

    const startedAt = Date.now();
    handle = runScript(code(), {
      onLog: (level, text) => push({type: 'log', level, text}),
      onOutput: (value, label) => push({type: 'json', value, label}),
      onDone: (ok, error) => {
        setRunning(false);
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
        if(ok) push({type: 'log', level: 'system', text: `— finished in ${elapsed}s`});
        else push({type: 'log', level: 'error', text: error || 'failed'});
      }
    });
  };

  const stop = () => handle?.stop('— stopped');

  const download = (entry: Entry) => {
    const blob = new Blob([JSON.stringify(entry.value, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (entry.label || 'output') + '.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if(e.key === 'Escape' && !running()) props.onClose();
    else if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    }
  };

  onMount(() => {
    document.addEventListener('keydown', onKeyDown);

    // Declare ourselves a modal overlay. appImManager's global keydown handler
    // returns early on `overlayCounter.isOverlayActive`; without this it stays
    // live under the panel and keeps competing for keystrokes and shortcuts.
    overlayCounter.isDarkOverlayActive = true;

    // Land the caret in the editor so typing works immediately after opening
    // from the menu, rather than requiring a click first.
    editorRef.focus();
    editorRef.setSelectionRange(editorRef.value.length, editorRef.value.length);
  });

  onCleanup(() => {
    document.removeEventListener('keydown', onKeyDown);
    overlayCounter.isDarkOverlayActive = false;
    handle?.stop();
  });

  const preview = (value: any) => {
    const text = JSON.stringify(value, null, 2) ?? String(value);
    return text.length > 20000 ? text.slice(0, 20000) + '\n… truncated (download for full)' : text;
  };

  return (
    <div class={styles.overlay} onClick={(e) => e.target === e.currentTarget && !running() && props.onClose()}>
      <div class={styles.panel}>
        <div class={styles.header}>
          <div>
            <div class={styles.title}>Script console</div>
            <div class={styles.subtitle}>Read-only sandbox · runs off the main thread</div>
          </div>
          <div class={styles.spacer} />
          <select
            class={styles.select}
            onChange={(e) => {
              const found = EXAMPLES.find((x) => x.name === e.currentTarget.value);
              if(found) setCode(found.code);
            }}
          >
            <For each={EXAMPLES}>{(ex) => <option value={ex.name}>{ex.name}</option>}</For>
          </select>
          <button class={styles.btn} disabled={running()} onClick={run}>Run ⌘↵</button>
          <button class={`${styles.btn} ${styles.btnGhost}`} disabled={!running()} onClick={stop}>Stop</button>
          <button class={`${styles.btn} ${styles.btnGhost}`} onClick={props.onClose}>Close</button>
        </div>

        <div class={styles.body}>
          <div class={styles.pane}>
            <div class={styles.paneHead}>script</div>
            <textarea
              ref={editorRef}
              class={styles.editor}
              spellcheck={false}
              value={code()}
              onInput={(e) => setCode(e.currentTarget.value)}
            />
          </div>

          <div class={styles.pane}>
            <div class={styles.paneHead}>
              output
              <div class={styles.spacer} />
              <Show when={entries().length}>
                <button class={`${styles.btn} ${styles.btnGhost}`} onClick={() => setEntries([])}>clear</button>
              </Show>
            </div>
            <div class={styles.output} ref={outputRef}>
              <For each={entries()}>{(entry) => (
                <Show
                  when={entry.type === 'json'}
                  fallback={
                    <div
                      class={`${styles.line} ${
                        entry.level === 'warn' ? styles.levelWarn :
                          entry.level === 'error' ? styles.levelError :
                            entry.level === 'system' ? styles.levelSystem : ''
                      }`}
                    >{entry.text}</div>
                  }
                >
                  <div class={styles.jsonBlock}>
                    <div class={styles.jsonHead}>
                      {entry.label || 'output'}
                      <div class={styles.spacer} />
                      <button class={`${styles.btn} ${styles.btnGhost}`} onClick={() => download(entry)}>download .json</button>
                    </div>
                    <pre class={styles.jsonBody}>{preview(entry.value)}</pre>
                  </div>
                </Show>
              )}</For>
            </div>
          </div>
        </div>

        <div class={styles.hint}>
          Available: <b>tg.me()</b> · <b>tg.chats.list()</b> · <b>tg.peer.resolve()</b> · <b>tg.messages.history()</b> ·{' '}
          <b>tg.messages.search()</b> · <b>tg.output.json()</b> · <b>tg.sleep()</b> · <b>console.log()</b>. Top-level
          await works. Read-only — nothing here can send or delete.
        </div>
      </div>
    </div>
  );
}
