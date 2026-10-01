import { downloadToFile } from '../../core/download';
import { buildFileIndex } from '../../core/file-index';
import { checkFolder } from '../../core/folders';
import { n, t } from '../../core/i18n';
import { fileNameFor } from '../../core/naming';
import { sleep } from '../../core/pacing';
import { getAccount, getSettings, putAccount } from '../../core/records';
import type { MediaItem } from '../../core/types';
import { surface } from '../../ui/host';
import { PLATFORM, describeError, ensurePermission, fetchMedia, handles, mediaDelay } from './env';

const never = new AbortController().signal;

/** Hands one file to the browser's own download handling (default download folder). */
async function browserDownload(item: MediaItem): Promise<void> {
  if (!item.url) throw new Error('no downloadable URL');
  const res = await fetchMedia(item.url, never);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const href = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = href;
  a.download = fileNameFor(item);
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** Saves files through the browser's download handling, one after another. */
export async function saveViaBrowser(items: MediaItem[]): Promise<void> {
  const progress = surface.toast(t('savingBrowser', 0, items.length), 'info', null);
  let done = 0;
  let failed = 0;
  for (const item of items) {
    try {
      await browserDownload(item);
      done += 1;
    } catch (e) {
      failed += 1;
      console.error('[memfolio] download failed', item.id, e);
    }
    progress.update(t('savingBrowser', done + failed, items.length));
    if (done + failed < items.length) await sleep(mediaDelay(item.kind), never);
  }
  progress.close();
  if (failed > 0) surface.toast(t('savedBrowserFailed', n(done), n(failed)), 'warn', null);
  else surface.toast(t('savedBrowser', n(done)));
}

/** Writes files into a managed account folder, skipping media already there. */
async function saveIntoFolder(items: MediaItem[], dir: FileSystemDirectoryHandle, ownerId: string): Promise<void> {
  const index = await buildFileIndex(dir);
  const progress = surface.toast(t('savingFolder', 0, items.length), 'info', null);
  let saved = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of items) {
    try {
      if (await index.has(item.id)) {
        skipped += 1;
      } else {
        if (!item.url) throw new Error('no downloadable URL');
        const existing = index.nameOf(item.id);
        const name = existing ?? fileNameFor(item);
        await downloadToFile(dir, name, item.url, fetchMedia, never, existing !== null);
        index.markDownloaded(item.id, name);
        saved += 1;
      }
    } catch (e) {
      failed += 1;
      console.error('[memfolio] download failed', item.id, e);
    }
    progress.update(t('savingFolder', saved + skipped + failed, items.length));
  }
  progress.close();

  const record = await getAccount(PLATFORM, ownerId);
  if (record) await putAccount({ ...record, fileCount: index.matchedCount, folderName: dir.name });
  const where = record?.relPath ?? dir.name;
  const lines: string[] = [];
  if (saved > 0) lines.push(skipped > 0 ? t('savedFolderSome', where, n(saved), n(skipped)) : t('savedFolderNew', where, n(saved)));
  else if (skipped > 0) lines.push(t('savedFolderNone', where, n(skipped)));
  if (failed > 0) lines.push(t('resultFailed', n(failed)));
  if (failed > 0) surface.toast(lines.join('\n'), 'warn', null);
  else surface.toast(lines.join('\n'));
}

/**
 * Saves the media of one post through the browser's download handling. With
 * the "account folder" setting, media of a managed account goes into that
 * account's folder instead.
 */
export async function savePostItems(items: MediaItem[]): Promise<void> {
  const first = items[0];
  if (!first) return;
  try {
    const intoFolder = (await getSettings()).singleSave === 'folder';
    const dir = intoFolder ? await handles.getAccount(first.ownerId) : null;
    if (dir && items.every((i) => i.ownerId === first.ownerId)) {
      if (await ensurePermission(dir)) {
        const state = await checkFolder(dir);
        if (state === 'ok') return await saveIntoFolder(items, dir, first.ownerId);
        const record = await getAccount(PLATFORM, first.ownerId);
        if (record) await putAccount({ ...record, lastStatus: 'folder-missing' });
        const useBrowser = await surface.dialog({
          title: t('folderMissingTitle'),
          message: t('folderMissingSingle', first.ownerUsername, record?.relPath ?? dir.name),
          buttons: [
            { label: t('cancel'), value: false },
            { label: t('useBrowserDownload'), value: true, primary: true },
          ],
        });
        if (!useBrowser) return;
      } else {
        return;
      }
    }
    await saveViaBrowser(items);
  } catch (e) {
    console.error('[memfolio]', e);
    surface.toast(t('downloadFailed', describeError(e)), 'error', null);
  }
}
