import { n, t } from '../../core/i18n';
import { fileNameFor } from '../../core/naming';
import { sleep } from '../../core/pacing';
import { getAccount, getSettings } from '../../core/records';
import type { MediaItem } from '../../core/types';
import { surface } from '../../ui/host';
import { PLATFORM, describeError, mediaDelay } from './env';
import type * as Base from './save';
import { saverFor } from './saver-client';

const never = new AbortController().signal;

async function saveAll(items: MediaItem[], path: string): Promise<{ done: number; failed: number }> {
  const save = saverFor(path, false);
  const progress = surface.toast(t('savingBrowser', 0, items.length), 'info', null);
  let done = 0;
  let failed = 0;
  for (const item of items) {
    try {
      if (!item.url) throw new Error('no downloadable URL');
      await save(fileNameFor(item), item.url, never, false);
      done += 1;
    } catch (e) {
      failed += 1;
      console.error('[memfolio] download failed', item.id, e);
    }
    progress.update(t('savingBrowser', done + failed, items.length));
    if (done + failed < items.length) await sleep(mediaDelay(item.kind), never);
  }
  progress.close();
  return { done, failed };
}

/** Saves files into the browser's download folder, one after another. */
export async function saveViaBrowser(items: MediaItem[]): Promise<void> {
  const { done, failed } = await saveAll(items, '');
  if (failed > 0) surface.toast(t('savedBrowserFailed', n(done), n(failed)), 'warn', null);
  else surface.toast(t('savedBrowser', n(done)));
}

/**
 * Saves the media of one post into the browser's download folder. With the
 * "account folder" setting, media of a managed account goes into that
 * account's folder instead; a file of the same name there is written over,
 * since the folder cannot be looked into.
 */
export async function savePostItems(items: MediaItem[]): Promise<void> {
  const first = items[0];
  if (!first) return;
  try {
    const intoFolder = (await getSettings()).singleSave === 'folder';
    const record = intoFolder ? await getAccount(PLATFORM, first.ownerId) : null;
    if (!record || !items.every((i) => i.ownerId === first.ownerId)) return await saveViaBrowser(items);
    const where = record.relPath ?? record.folderName;
    const { done, failed } = await saveAll(items, where);
    const lines = [t('savedFolderNew', where, n(done))];
    if (failed > 0) lines.push(t('resultFailed', n(failed)));
    if (failed > 0) surface.toast(lines.join('\n'), 'warn', null);
    else surface.toast(lines.join('\n'));
  } catch (e) {
    console.error('[memfolio]', e);
    surface.toast(t('downloadFailed', describeError(e)), 'error', null);
  }
}

({ saveViaBrowser, savePostItems }) satisfies Pick<typeof Base, 'saveViaBrowser' | 'savePostItems'>;
