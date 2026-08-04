/*
 * A full-screen editor for the Python console, laid out the way every code
 * editor is: activity bar → side bar → tabs → editor → output panel → status
 * bar. The chrome is built entirely from Telegram's theme variables, so it
 * follows day/night/tinted/light without a palette of its own.
 */

import {batch, createMemo, createSignal, For, onCleanup, onMount, Show} from 'solid-js';
import {createStore} from 'solid-js/store';
import {runScript, shutdownSandbox, RunHandle} from '@lib/scripting/broker';
import overlayCounter from '@helpers/overlayCounter';
import {IconTsx} from '@components/iconTsx';
import CodeEditor, {EditorApi} from './codeEditor';
import {API_CATALOG, SNIPPETS} from './apiCatalog';
import {createFile, loadWorkspace, saveWorkspace, uniqueName, ScriptFile} from './scripts';
import styles from './scriptConsole.module.scss';

const WRITES_KEY = 'cat-script-console-writes';
const PANEL_KEY = 'cat-console-panel-height';

type SideView = 'explorer' | 'snippets' | 'api';

type Entry = {
  type: 'log',
  level: 'log' | 'warn' | 'error' | 'system' | 'audit',
  text: string
} | {
  type: 'output',
  label?: string,
  value: any,
  format: 'json' | 'table' | 'csv' | 'text' | 'file',
  filename?: string,
  mime?: string
};

/** Union of keys across rows — table/CSV columns. */
function columnsOf(rows: any[]) {
  const columns: string[] = [];
  for(const row of rows) {
    if(!row || typeof row !== 'object') continue;
    for(const key of Object.keys(row)) {
      if(!columns.includes(key)) columns.push(key);
    }
  }
  return columns;
}

function cellText(value: any) {
  if(value === undefined || value === null) return '';
  if(typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toCsv(rows: any[]) {
  const columns = columnsOf(rows);
  const escape = (value: any) => {
    const text = cellText(value);
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };

  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => escape(row?.[column])).join(','))
  ].join('\n');
}

export default function ScriptConsole(props: {onClose: () => void}) {
  // A store, not a signal of plain objects: the editor and the file list read
  // `file.code` / `file.name` directly, and only a store makes those property
  // reads reactive. With a signal they render once and then go stale — edits
  // stop re-highlighting and renames never appear.
  const [files, setFiles] = createStore<ScriptFile[]>(loadWorkspace());
  const [activeId, setActiveId] = createSignal(files[0].id);
  const [openIds, setOpenIds] = createSignal<string[]>([files[0].id], {equals: false});
  const [sideView, setSideView] = createSignal<SideView>('explorer');
  const [sideOpen, setSideOpen] = createSignal(true);
  const [openGroups, setOpenGroups] = createSignal<string[]>(['tg.messages'], {equals: false});

  const [entries, setEntries] = createSignal<Entry[]>([], {equals: false});
  const [running, setRunning] = createSignal(false);
  const [status, setStatus] = createSignal('');
  const [problem, setProblem] = createSignal('');
  const [cursor, setCursor] = createSignal({line: 1, column: 1});
  const [allowWrites, setAllowWrites] = createSignal(localStorage.getItem(WRITES_KEY) === '1');
  const [panelHeight, setPanelHeight] = createSignal(+localStorage.getItem(PANEL_KEY) || 260);

  let handle: RunHandle;
  let editor: EditorApi;
  let outputRef: HTMLDivElement;

  const activeIndex = createMemo(() => files.findIndex((file) => file.id === activeId()));
  const activeFile = createMemo(() => files[activeIndex()]);
  const openFiles = createMemo(() => openIds().map((id) => files.find((file) => file.id === id)).filter(Boolean));

  const persist = () => saveWorkspace(files);

  const updateCode = (code: string) => {
    const index = activeIndex();
    if(index < 0) return;
    setFiles(index, {code, updatedAt: Date.now()});
    persist();
  };

  const openFile = (id: string) => {
    batch(() => {
      setActiveId(id);
      if(!openIds().includes(id)) setOpenIds((prev) => (prev.push(id), prev));
    });
  };

  const closeTab = (id: string) => {
    batch(() => {
      const remaining = openIds().filter((openId) => openId !== id);
      setOpenIds(() => remaining);
      if(activeId() === id && remaining.length) setActiveId(remaining[remaining.length - 1]);
    });
  };

  const addFile = (name: string, code: string) => {
    const file = createFile(uniqueName(files, name), code);
    batch(() => {
      setFiles(files.length, file);
      openFile(file.id);
    });
    persist();
  };

  const renameFile = (file: ScriptFile) => {
    const name = prompt('File name', file.name);
    if(!name) return;

    const index = files.findIndex((other) => other.id === file.id);
    setFiles(index, 'name', uniqueName(files.filter((other) => other.id !== file.id), name));
    persist();
  };

  const deleteFile = (file: ScriptFile) => {
    if(files.length === 1) return;
    if(!confirm(`Delete ${file.name}?`)) return;

    batch(() => {
      setFiles((prev) => prev.filter((other) => other.id !== file.id));
      setOpenIds((prev) => prev.filter((id) => id !== file.id));
      if(!openIds().length) setOpenIds(() => [files[0].id]);
      if(activeId() === file.id) setActiveId(openIds()[0]);
    });
    persist();
  };

  // Mutate-in-place + `equals: false`: a chatty script pushes thousands of
  // lines, and copying the array on each one made output quadratic.
  const push = (entry: Entry) => {
    setEntries((prev) => (prev.push(entry), prev));
    queueMicrotask(() => outputRef && (outputRef.scrollTop = outputRef.scrollHeight));
  };

  const run = () => {
    if(running() || !activeFile()) return;

    batch(() => {
      setEntries(() => [] as Entry[]);
      setProblem('');
      setRunning(true);
      setStatus('');
    });

    const startedAt = Date.now();
    handle = runScript(activeFile().code, {
      onLog: (level, text) => push({type: 'log', level, text}),
      onStatus: (text) => setStatus(text),
      onAudit: (text) => push({type: 'log', level: 'audit', text: '⚡ ' + text}),
      onOutput: (message) => push({
        type: 'output',
        value: message.value,
        label: message.label,
        format: message.format || 'json',
        filename: message.filename,
        mime: message.mime
      }),
      onDone: (ok, error) => {
        batch(() => {
          setRunning(false);
          setStatus('');
          if(!ok) setProblem(error || 'failed');
        });

        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
        if(ok) push({type: 'log', level: 'system', text: `— finished in ${elapsed}s`});
        else push({type: 'log', level: 'error', text: error || 'failed'});
      }
    }, {allowWrites: allowWrites()});
  };

  const stop = () => handle?.stop('— stopped');

  const toggleWrites = () => {
    const next = !allowWrites();
    setAllowWrites(next);
    localStorage.setItem(WRITES_KEY, next ? '1' : '0');
  };

  const toggleGroup = (name: string) => {
    setOpenGroups((prev) => {
      const index = prev.indexOf(name);
      if(index === -1) prev.push(name);
      else prev.splice(index, 1);
      return prev;
    });
  };

  const showSide = (view: SideView) => {
    if(sideView() === view && sideOpen()) setSideOpen(false);
    else batch(() => {
      setSideView(view);
      setSideOpen(true);
    });
  };

  const download = (entry: Extract<Entry, {type: 'output'}>) => {
    const label = entry.label || 'output';
    let blob: Blob;
    let name: string;

    if(entry.format === 'file') {
      blob = new Blob([entry.value], {type: entry.mime || 'application/octet-stream'});
      name = entry.filename || label;
    } else if(entry.format === 'csv' || entry.format === 'table') {
      blob = new Blob([toCsv(entry.value || [])], {type: 'text/csv'});
      name = label + '.csv';
    } else if(entry.format === 'text') {
      blob = new Blob([String(entry.value)], {type: 'text/plain'});
      name = label + '.txt';
    } else {
      blob = new Blob([JSON.stringify(entry.value, null, 2)], {type: 'application/json'});
      name = label + '.json';
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  /** Drag the divider between editor and output. */
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = panelHeight();

    const onMove = (move: PointerEvent) => {
      const next = Math.max(80, Math.min(startHeight + (startY - move.clientY), window.innerHeight - 220));
      setPanelHeight(next);
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      localStorage.setItem(PANEL_KEY, String(panelHeight()));
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if(e.key === 'Escape' && !running()) props.onClose();
    else if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      run();
    } else if(e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); // already persisted on every keystroke; just don't save the page
    }
  };

  onMount(() => {
    document.addEventListener('keydown', onKeyDown);

    // Declare ourselves a modal overlay. appImManager's global keydown handler
    // returns early on `overlayCounter.isOverlayActive`; without this it stays
    // live under the panel and keeps competing for keystrokes and shortcuts.
    overlayCounter.isDarkOverlayActive = true;
  });

  onCleanup(() => {
    document.removeEventListener('keydown', onKeyDown);
    overlayCounter.isDarkOverlayActive = false;
    shutdownSandbox();
  });

  const preview = (value: any) => {
    const text = JSON.stringify(value, null, 2) ?? String(value);
    return text.length > 20000 ? text.slice(0, 20000) + '\n… truncated (download for full)' : text;
  };

  const levelClass = (level: string) => (
    level === 'warn' ? styles.levelWarn :
      level === 'error' ? styles.levelError :
        level === 'system' ? styles.levelSystem :
          level === 'audit' ? styles.levelAudit : ''
  );

  const ActivityButton = (activity: {view: SideView, icon: Icon, title: string}) => (
    <button
      class={`${styles.activityBtn} ${sideOpen() && sideView() === activity.view ? styles.activityBtnActive : ''}`}
      title={activity.title}
      onClick={() => showSide(activity.view)}
    >
      <IconTsx icon={activity.icon} />
    </button>
  );

  return (
    <div class={styles.root}>
      <div class={styles.titleBar}>
        <IconTsx icon="monospace" class={styles.titleIcon} />
        <span class={styles.titleText}>Code console</span>
        <span class={styles.titlePath}>{activeFile()?.name}</span>

        <div class={styles.spacer} />

        <button class={styles.runBtn} disabled={running()} onClick={run} title="Ctrl/Cmd + Enter">
          <IconTsx icon="play" /> Run
        </button>
        <button class={styles.iconBtn} disabled={!running()} onClick={stop} title="Stop">
          <IconTsx icon="stop" />
        </button>
        <button class={styles.iconBtn} onClick={props.onClose} title="Close (Esc)">
          <IconTsx icon="close" />
        </button>
      </div>

      <div class={styles.main}>
        <div class={styles.activityBar}>
          <ActivityButton view="explorer" icon="folder" title="Scripts" />
          <ActivityButton view="snippets" icon="tip" title="Examples" />
          <ActivityButton view="api" icon="search" title="Telegram API" />
        </div>

        <Show when={sideOpen()}>
          <div class={styles.sideBar}>
            <Show when={sideView() === 'explorer'}>
              <div class={styles.sideHead}>
                Scripts
                <div class={styles.spacer} />
                <button class={styles.sideAction} onClick={() => addFile('untitled.py', '')} title="New script">
                  <IconTsx icon="plus" />
                </button>
              </div>
              <div class={styles.sideBody}>
                <For each={files}>{(file) => (
                  <div
                    class={`${styles.fileRow} ${file.id === activeId() ? styles.fileRowActive : ''}`}
                    onClick={() => openFile(file.id)}
                  >
                    <IconTsx icon="monospace" class={styles.fileIcon} />
                    <span class={styles.fileName}>{file.name}</span>
                    <button
                      class={styles.rowAction}
                      title="Rename"
                      onClick={(e) => (e.stopPropagation(), renameFile(file))}
                    ><IconTsx icon="edit" /></button>
                    <button
                      class={styles.rowAction}
                      title="Delete"
                      onClick={(e) => (e.stopPropagation(), deleteFile(file))}
                    ><IconTsx icon="delete" /></button>
                  </div>
                )}</For>
              </div>
            </Show>

            <Show when={sideView() === 'snippets'}>
              <div class={styles.sideHead}>Examples</div>
              <div class={styles.sideBody}>
                <For each={SNIPPETS}>{(snippet) => (
                  <div
                    class={styles.snippetRow}
                    onClick={() => addFile(
                      snippet.name.toLowerCase().replace(/\s+/g, '-') + '.py',
                      snippet.code
                    )}
                  >
                    <IconTsx icon="tip" class={styles.fileIcon} />
                    <span class={styles.fileName}>{snippet.name}</span>
                  </div>
                )}</For>
              </div>
            </Show>

            <Show when={sideView() === 'api'}>
              <div class={styles.sideHead}>Telegram API</div>
              <div class={styles.sideBody}>
                <For each={API_CATALOG}>{(group) => (
                  <>
                    <div class={styles.groupRow} onClick={() => toggleGroup(group.name)}>
                      <IconTsx
                        icon="down"
                        class={`${styles.chevron} ${openGroups().includes(group.name) ? styles.chevronOpen : ''}`}
                      />
                      <IconTsx icon={group.icon} class={styles.fileIcon} />
                      <span class={styles.groupName}>{group.name}</span>
                    </div>

                    <Show when={openGroups().includes(group.name)}>
                      <div class={styles.groupSummary}>{group.summary}</div>
                      <For each={group.methods}>{(method) => (
                        <div
                          class={styles.methodRow}
                          title={method.summary + (method.write ? ' · needs Writes' : '')}
                          onClick={() => editor?.insert(method.signature)}
                        >
                          <code class={styles.methodSig}>{method.signature.replace('|', '')}</code>
                          <Show when={method.write}>
                            <span class={styles.writeTag}>write</span>
                          </Show>
                          <span class={styles.methodSummary}>{method.summary}</span>
                        </div>
                      )}</For>
                    </Show>
                  </>
                )}</For>
              </div>
            </Show>
          </div>
        </Show>

        <div class={styles.editorArea}>
          <div class={styles.tabBar}>
            <For each={openFiles()}>{(file) => (
              <div
                class={`${styles.tab} ${file.id === activeId() ? styles.tabActive : ''}`}
                onClick={() => setActiveId(file.id)}
              >
                <IconTsx icon="monospace" class={styles.tabIcon} />
                <span>{file.name}</span>
                <button
                  class={styles.tabClose}
                  onClick={(e) => (e.stopPropagation(), closeTab(file.id))}
                ><IconTsx icon="close" /></button>
              </div>
            )}</For>
          </div>

          <Show when={activeFile()} keyed>{(file) => (
            <CodeEditor
              value={file.code}
              onInput={updateCode}
              onRun={run}
              onCursor={(line, column) => setCursor({line, column})}
              onReady={(api) => (editor = api)}
            />
          )}</Show>

          <div class={styles.resizer} onPointerDown={startResize} />

          <div class={styles.panel} style={{height: panelHeight() + 'px'}}>
            <div class={styles.panelHead}>
              <span class={styles.panelTab}>Output</span>
              <Show when={problem()}>
                <span class={`${styles.panelTab} ${styles.panelTabProblem}`}>1 problem</span>
              </Show>
              <div class={styles.spacer} />
              <Show when={entries().length}>
                <button class={styles.iconBtn} title="Clear" onClick={() => setEntries(() => [] as Entry[])}>
                  <IconTsx icon="delete" />
                </button>
              </Show>
            </div>

            <div class={styles.output} ref={outputRef}>
              <Show when={!entries().length}>
                <div class={styles.outputEmpty}>
                  Output appears here. <b>Ctrl/Cmd + Enter</b> runs the open file.
                </div>
              </Show>

              <For each={entries()}>{(entry) => (
                <Show
                  when={entry.type === 'output' && entry}
                  fallback={
                    <div class={`${styles.line} ${levelClass((entry as any).level)}`}>{(entry as any).text}</div>
                  }
                >{(output) => (
                    <div class={styles.block}>
                      <div class={styles.blockHead}>
                        <IconTsx icon="download" class={styles.fileIcon} />
                        {output().label || 'output'}
                        <div class={styles.spacer} />
                        <button class={styles.blockAction} onClick={() => download(output())}>
                          download {output().format === 'file' ? '' : '.' + (output().format === 'table' ? 'csv' : output().format)}
                        </button>
                      </div>

                      <Show
                        when={output().format === 'table' && Array.isArray(output().value)}
                        fallback={
                          <pre class={`${styles.blockBody} ${styles.code}`}>
                            {output().format === 'file' ?
                              `${output().filename} · ${(output().value as Uint8Array)?.length ?? 0} bytes` :
                              output().format === 'text' ? String(output().value) : preview(output().value)}
                          </pre>
                        }
                      >
                        <div class={styles.tableWrap}>
                          <table class={styles.table}>
                            <thead>
                              <tr><For each={columnsOf(output().value)}>{(column) => <th>{column}</th>}</For></tr>
                            </thead>
                            <tbody>
                              <For each={(output().value as any[]).slice(0, 200)}>{(row) => (
                                <tr>
                                  <For each={columnsOf(output().value)}>{(column) => <td>{cellText(row?.[column])}</td>}</For>
                                </tr>
                              )}</For>
                            </tbody>
                          </table>
                        </div>
                      </Show>
                    </div>
                  )}</Show>
              )}</For>
            </div>
          </div>
        </div>
      </div>

      <div class={styles.statusBar}>
        <button
          class={`${styles.statusItem} ${allowWrites() ? styles.statusWrites : ''}`}
          onClick={toggleWrites}
          title="Allow scripts to send, edit, delete and administrate"
        >
          <IconTsx icon={allowWrites() ? 'lockoff' : 'lock'} />
          {allowWrites() ? 'Writes on' : 'Writes off'}
        </button>

        <span class={styles.statusItem}>
          {running() ? (status() || 'Running…') : (status() || 'Python 3')}
        </span>

        <div class={styles.spacer} />

        <Show when={problem()}>
          <span class={`${styles.statusItem} ${styles.statusProblem}`}>✕ 1</span>
        </Show>
        <span class={styles.statusItem}>Ln {cursor().line}, Col {cursor().column}</span>
        <span class={styles.statusItem}>Python</span>
      </div>
    </div>
  );
}
