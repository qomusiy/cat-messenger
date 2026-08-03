import {render} from 'solid-js/web';

import ScriptConsole from '@components/scriptConsole/scriptConsole';

let close: (() => void) | undefined;

export function showScriptConsole() {
  if(close) return;

  const div = document.createElement('div');
  document.body.append(div);

  close = () => {
    dispose();
    div.remove();
    close = undefined;
  };

  const dispose = render(() => <ScriptConsole onClose={() => close?.()} />, div);

  (window as any)['closeScriptConsole'] = close;
}
