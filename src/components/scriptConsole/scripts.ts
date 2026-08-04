/*
 * The console's "workspace": a set of named Python files kept in localStorage.
 *
 * Deliberately not IndexedDB — these are a few kilobytes of text that must be
 * readable synchronously during the first render, so the editor can paint with
 * real content instead of flashing empty. If scripts ever grow to hold data
 * rather than code, this is the thing to move.
 */

const STORAGE_KEY = 'cat-console-workspace';

export type ScriptFile = {
  id: string,
  name: string,
  code: string,
  updatedAt: number
};

const STARTER = `# Ctrl/Cmd + Enter runs. Reading is always allowed;
# sending and editing need the Writes switch in the status bar.

me = await tg.me()
print('Signed in as', me.title)

page = await tg.chats.list(limit=20)
for c in page.chats:
    print(f'{c.unread:>4} unread  {c.title}')

tg.output.table(page.chats, 'chats')
`;

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function createFile(name = 'untitled.py', code = ''): ScriptFile {
  return {id: makeId(), name, code, updatedAt: Date.now()};
}

export function loadWorkspace(): ScriptFile[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if(Array.isArray(parsed) && parsed.length) return parsed;
  } catch(err) {}

  // First run — carry over the single draft the old console kept, so nobody
  // loses what they had open.
  const legacy = localStorage.getItem('cat-script-console-draft-py');
  return [createFile('main.py', legacy || STARTER)];
}

export function saveWorkspace(files: ScriptFile[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(files));
  } catch(err) {}
}

/** Appends " 2", " 3"… until the name is free — like every file manager. */
export function uniqueName(files: ScriptFile[], name: string) {
  if(!files.some((file) => file.name === name)) return name;

  const dot = name.lastIndexOf('.');
  const base = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? '' : name.slice(dot);

  for(let index = 2; ; ++index) {
    const candidate = `${base} ${index}${extension}`;
    if(!files.some((file) => file.name === candidate)) return candidate;
  }
}
