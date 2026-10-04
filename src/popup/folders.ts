// The folder rows of the settings view.

import { t } from '../core/i18n';
import { getDefaultFolderName } from '../core/records';
import { PASTE_PLATFORM, text } from './shared';

/** The default location is known by its name only; the folder is chosen and changed on a platform tab. */
export async function renderFolders(): Promise<void> {
  text('default-name', t('optDefault'));
  const name = await getDefaultFolderName(PASTE_PLATFORM);
  text('default-value', name ?? t('optDefaultNone'));
  document.getElementById('default-value')!.title = name ?? '';
  text('default-change', name === null ? t('optDefaultChoose') : t('optDefaultChange'));
}

export function initFolders(hooks: { openDefault(): void; saved(): void }): void {
  document.getElementById('default-change')!.addEventListener('click', hooks.openDefault);
}
