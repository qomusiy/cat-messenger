/*
 * The editor surface: a transparent <textarea> sitting exactly on top of a
 * Prism-highlighted <pre>, with a line-number gutter tracking both.
 *
 * Why not contenteditable: a textarea keeps native undo/redo, IME composition,
 * spellcheck control and mobile keyboards for free, all of which are painful to
 * rebuild. The cost is that the two layers must agree on metrics down to the
 * pixel — hence the shared `.code` typography below, and why padding/font/
 * line-height live in one place in the stylesheet rather than on each layer.
 */

import {createEffect, createSignal, on, onMount} from 'solid-js';
import {importPrism} from '@/codeLanguages';
import styles from './scriptConsole.module.scss';

const INDENT = '    ';

/** Lines that should indent the next one. */
const OPENS_BLOCK = /:\s*(#.*)?$/;

export type EditorApi = {
  /** Inserts at the caret. A `|` in the text marks where the caret lands. */
  insert: (text: string) => void,
  focus: () => void
};

export default function CodeEditor(props: {
  value: string,
  onInput: (value: string) => void,
  onRun: () => void,
  onCursor?: (line: number, column: number) => void,
  onReady?: (api: EditorApi) => void
}) {
  const [html, setHtml] = createSignal('');
  const [prism, setPrism] = createSignal<any>();

  let textarea: HTMLTextAreaElement;
  let pre: HTMLPreElement;
  let gutter: HTMLDivElement;

  onMount(() => {
    // Shared with message code blocks, so this chunk is usually already warm.
    Promise.resolve(importPrism('python')).then((imported) => imported && setPrism(imported));

    props.onReady?.({
      insert: (text) => {
        const caretOffset = text.indexOf('|');
        const clean = caretOffset === -1 ? text : text.replace('|', '');
        const start = textarea.selectionStart;

        // Land a statement on its own line rather than glued to whatever the
        // caret happened to be sitting next to.
        const atLineStart = start === 0 || textarea.value[start - 1] === '\n';
        const prefix = atLineStart ? '' : '\n';
        const body = prefix + clean;

        textarea.focus();
        textarea.setRangeText(body, start, textarea.selectionEnd, 'end');
        const caret = start + prefix.length + (caretOffset === -1 ? clean.length : caretOffset);
        textarea.selectionStart = textarea.selectionEnd = caret;
        props.onInput(textarea.value);
        reportCursor();
      },
      focus: () => textarea.focus()
    });
  });

  // Re-highlight whenever the text changes or Prism finishes loading. Until it
  // lands the <pre> stays empty and the textarea shows its own (visible) text —
  // see `.editorLoading` — so the editor is usable during the import.
  createEffect(on([() => props.value, prism], ([value, imported]) => {
    if(!imported) return;

    const {prism: Prism, language} = imported;
    // Trailing newline keeps the last (empty) line from collapsing, which would
    // otherwise drift the highlight layer up relative to the textarea.
    setHtml(Prism.highlight(value + '\n', Prism.languages[language], language));
  }));

  /*
   * Reconcile the DOM from props rather than binding `value` in JSX. Solid
   * would re-assign `textarea.value` on every keystroke — the caret survives
   * assigning an identical string, but not the reflow when a stale value wins a
   * race. Writing only on a genuine mismatch keeps typing untouched while still
   * picking up external changes (file switch, insert from the API panel).
   */
  createEffect(() => {
    const next = props.value;
    if(textarea && textarea.value !== next) textarea.value = next;
  });

  const lineCount = () => props.value.split('\n').length;

  const syncScroll = () => {
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
    gutter.scrollTop = textarea.scrollTop;
  };

  const reportCursor = () => {
    if(!props.onCursor) return;
    const upto = textarea.value.slice(0, textarea.selectionStart);
    const line = upto.split('\n');
    props.onCursor(line.length, line[line.length - 1].length + 1);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const {selectionStart: start, selectionEnd: end, value} = textarea;

    const replace = (from: number, to: number, text: string, caret: number) => {
      textarea.setRangeText(text, from, to, 'end');
      textarea.selectionStart = textarea.selectionEnd = caret;
      props.onInput(textarea.value);
      reportCursor();
    };

    if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      props.onRun();
      return;
    }

    if(e.key === 'Tab') {
      e.preventDefault();
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;

      if(e.shiftKey) {
        const indent = value.slice(lineStart, start).match(/^ {1,4}/);
        if(indent) replace(lineStart, lineStart + indent[0].length, '', start - indent[0].length);
        return;
      }

      replace(start, end, INDENT, start + INDENT.length);
      return;
    }

    // Python is whitespace-significant, so carrying the indent forward is not a
    // nicety — without it every block has to be re-indented by hand.
    if(e.key === 'Enter') {
      e.preventDefault();
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const line = value.slice(lineStart, start);
      const indent = (line.match(/^[ \t]*/) || [''])[0];
      const insert = '\n' + indent + (OPENS_BLOCK.test(line) ? INDENT : '');
      replace(start, end, insert, start + insert.length);
      return;
    }

    // Backspace at the head of an indent removes a whole level, not one space.
    if(e.key === 'Backspace' && start === end) {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const before = value.slice(lineStart, start);
      if(before.length && before.length % INDENT.length === 0 && /^ +$/.test(before)) {
        e.preventDefault();
        replace(start - INDENT.length, start, '', start - INDENT.length);
      }
    }
  };

  return (
    <div class={styles.editorWrap}>
      <div class={`${styles.gutter} ${styles.code}`} ref={gutter}>
        {Array.from({length: lineCount()}, (_, index) => <div>{index + 1}</div>)}
      </div>

      <div class={styles.editorLayers}>
        <pre
          class={`${styles.highlight} ${styles.code}`}
          ref={pre}
          aria-hidden="true"
          innerHTML={html()}
        />
        <textarea
          ref={textarea}
          class={`${styles.editor} ${styles.code} ${prism() ? '' : styles.editorLoading}`}
          spellcheck={false}
          autocapitalize="off"
          autocomplete="off"
          onInput={(e) => {
            props.onInput(e.currentTarget.value);
            reportCursor();
          }}
          onKeyDown={onKeyDown}
          onScroll={syncScroll}
          onClick={reportCursor}
          onKeyUp={reportCursor}
        />
      </div>
    </div>
  );
}
