// The folder rows of the settings view, for a browser that saves through its
// download handling: the place for new accounts is a path typed here.

import { t } from '../core/i18n';
import { cleanRelPath } from '../core/paths';
import { getSettings, setSettings } from '../core/records';
import { h } from '../ui/dom';
import { text } from './shared';
import type * as Base from './folders';

let input: HTMLInputElement | null = null;
let hint: HTMLElement | null = null;

/** Turns the row of the default location into a name, a text box and a hint. */
function build(): HTMLInputElement {
  if (input) return input;
  const value = document.getElementById('default-value')!;
  const row = value.parentElement!;
  row.classList.remove('valued');
  input = h('input', { class: 'gname', attrs: { id: 'subfolder', type: 'text', spellcheck: 'false' } });
  input.style.gridColumn = '1 / -1';
  hint = h('span', { class: 'hint' });
  document.getElementById('default-name')!.style.gridColumn = '1 / -1';
  document.getElementById('default-change')!.remove();
  value.replaceWith(input, hint);
  // No import: a folder outside the browser's reach cannot be seen.
  document.getElementById('import')!.parentElement!.style.display = 'none';
  // The only tool behind developer mode inspects folder access, which this build does not have.
  document.getElementById('group-advanced')!.parentElement!.hidden = true;
  return input;
}

export async function renderFolders(): Promise<void> {
  const box = build();
  text('default-name', t('optSubfolder'));
  box.setAttribute('aria-label', t('optSubfolder'));
  hint!.textContent = t('optSubfolderHint');
  if (document.activeElement !== box) box.value = (await getSettings()).subfolder;
}

export function initFolders(hooks: { openDefault(): void; saved(): void }): void {
  const box = build();
  box.addEventListener('change', async () => {
    box.value = cleanRelPath(box.value);
    await setSettings({ subfolder: box.value });
    hooks.saved();
  });
}

({ renderFolders, initFolders }) satisfies Pick<typeof Base, 'renderFolders' | 'initFolders'>;
