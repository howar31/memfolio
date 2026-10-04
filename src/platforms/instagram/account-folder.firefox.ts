// Account folders in a browser that saves through its download handling: a
// folder is a path inside the download folder. The browser gives a page no
// view of it, so before a run the user picks the folder and its file names are
// read then; nothing about saved files is kept.

import { FileIndex } from '../../core/file-index';
import { t } from '../../core/i18n';
import { indexFromList } from '../../core/listed-index';
import { abortError } from '../../core/pacing';
import { cleanRelPath, cleanSegment } from '../../core/paths';
import { getAccount, getSettings, putAccount, type AccountRecord } from '../../core/records';
import { surface } from '../../ui/host';
import type * as Base from './account-folder';
import { PLATFORM } from './env';
import { saverFor } from './saver-client';

export type AccountFolder = Base.AccountFolder;
export type FolderLink = Base.FolderLink;

async function defaultPath(username: string): Promise<string> {
  const { subfolder } = await getSettings();
  return [cleanRelPath(subfolder), cleanSegment(username) || 'account'].filter((s) => s !== '').join('/');
}

/** Opens the browser's folder dialog. The file list is read here and goes nowhere. */
function pickFolderFiles(): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/**
 * What the account's folder holds now, as far as the user shows it: the folder
 * is picked, or the user says to download everything. Throws AbortError when the user backs out.
 */
async function seeFolder(folder: AccountFolder, path: string): Promise<FileIndex> {
  const name = path.slice(path.lastIndexOf('/') + 1);
  for (;;) {
    const choice = await surface.dialog<'pick' | 'all' | null>({
      title: t('linkTitle'),
      message: t('seeFolderMessage', path),
      buttons: [
        { label: t('cancel'), value: null },
        { label: t('seeFolderSkip'), value: 'all' },
        { label: t('chooseFolder'), value: 'pick', primary: true },
      ],
    });
    if (choice === 'all') {
      folder.acceptedEmpty = true;
      folder.unchecked = true;
      return new FileIndex();
    }
    if (choice !== 'pick') throw abortError();
    const files = await pickFolderFiles();
    if (!files) continue;
    const { root, index } = indexFromList(files);
    // The browser tells the picked folder's name only; a different name is most likely a different folder.
    if (root === '' || root.toLowerCase() === name.toLowerCase()) return index;
    const other = await surface.dialog<'again' | 'use' | null>({
      title: t('linkTitle'),
      message: t('seeFolderOther', root, folder.record.username, path),
      buttons: [
        { label: t('cancel'), value: null },
        { label: t('useAnyway'), value: 'use' },
        { label: t('chooseAnother'), value: 'again', primary: true },
      ],
    });
    if (other === 'use') return index;
    if (other !== 'again') throw abortError();
  }
}

function folderOf(record: AccountRecord): AccountFolder {
  const path = record.relPath ?? record.folderName;
  const folder: AccountFolder = {
    record,
    label: path,
    openIndex: () => seeFolder(folder, path),
    save: saverFor(path, true),
  };
  return folder;
}

/**
 * The folder an account saves into, together with its summary record: the
 * path it has on record, or `<folder of the settings>/<username>` for an
 * account seen for the first time.
 */
export async function resolveAccountFolder(id: string, username: string): Promise<AccountFolder | null> {
  const previous = await getAccount(PLATFORM, id);
  const path = previous?.relPath ?? (await defaultPath(username));
  const record: AccountRecord = {
    platform: PLATFORM,
    id,
    username,
    folderName: path.slice(path.lastIndexOf('/') + 1),
    relPath: path,
    fileCount: previous?.fileCount ?? 0,
    lastRunAt: previous?.lastRunAt ?? null,
    lastStatus: previous?.lastStatus ?? 'ok',
    needsFullScan: previous?.needsFullScan ?? {},
    listed: previous?.listed ?? {},
    addedAt: previous?.addedAt ?? Date.now(),
    ...(previous?.pinned ? { pinned: true } : {}),
  };
  await putAccount(record);
  return folderOf(record);
}

/** The folder of the settings is changed in the popup; a page has nothing to offer. */
export async function changeDefault(): Promise<void> {}

export function startFolders(): void {}

export async function defaultTarget(username: string): Promise<string | null> {
  return defaultPath(username);
}

export function folderNames(record: AccountRecord): string[] {
  return (record.relPath ?? record.folderName).split('/').filter((s) => s !== '');
}

export function folderLinks(): FolderLink[] {
  return [];
}

({ resolveAccountFolder, changeDefault, startFolders, defaultTarget, folderNames, folderLinks }) satisfies Pick<
  typeof Base,
  'resolveAccountFolder' | 'changeDefault' | 'startFolders' | 'defaultTarget' | 'folderNames' | 'folderLinks'
>;
