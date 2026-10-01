import { buildFileIndex } from '../../core/file-index';
import { checkFolder, openUnderRoot, relativePath } from '../../core/folders';
import { n, t } from '../../core/i18n';
import { sanitizeFileName } from '../../core/naming';
import { getAccount, putAccount, type AccountRecord } from '../../core/records';
import { surface } from '../../ui/host';
import { PLATFORM, ensurePermission, handles, pickDirectory } from './env';

export interface AccountFolder {
  dir: FileSystemDirectoryHandle;
  record: AccountRecord;
  /** The user was already told this folder holds none of the account's files and chose to use it. */
  acceptedEmpty?: boolean;
}

const CANCEL = { label: '', value: false } as const;

function cancelButton(): { label: string; value: false } {
  return { ...CANCEL, label: t('cancel') };
}

/** Path shown for a folder: relative to a folder the user picked when known, else its own name. */
async function describePath(dir: FileSystemDirectoryHandle): Promise<string | null> {
  const parents = await handles.getParents();
  const root = await handles.getRoot();
  return relativePath(root ? [...parents, root] : parents, dir);
}

async function save(id: string, username: string, dir: FileSystemDirectoryHandle, previous: AccountRecord | null): Promise<AccountFolder> {
  await handles.setAccount(id, dir);
  const record: AccountRecord = {
    platform: PLATFORM,
    id,
    username,
    folderName: dir.name,
    relPath: await describePath(dir),
    fileCount: previous?.fileCount ?? 0,
    lastRunAt: previous?.lastRunAt ?? null,
    lastStatus: previous?.lastStatus ?? 'ok',
    needsFullScan: previous?.needsFullScan ?? {},
    listed: previous?.listed ?? {},
    addedAt: previous?.addedAt ?? Date.now(),
    ...(previous?.pinned ? { pinned: true } : {}),
  };
  await putAccount(record);
  return { dir, record };
}

/**
 * Lets the user pick the folder of an account. When the account already has
 * files on record and the picked folder holds none of them, asks before using it.
 */
async function pickAccountFolder(
  id: string,
  previous: AccountRecord | null,
): Promise<{ dir: FileSystemDirectoryHandle; acceptedEmpty: boolean } | null> {
  for (;;) {
    const picked = await pickDirectory('memfolio-account', (await handles.getRoot()) ?? 'downloads');
    if (!picked) return null;
    if (!previous || previous.fileCount === 0) return { dir: picked, acceptedEmpty: false };
    if ((await buildFileIndex(picked)).countForOwner(id) > 0) return { dir: picked, acceptedEmpty: false };
    const choice = await surface.dialog<'again' | 'use' | null>({
      title: t('wrongFolderTitle'),
      message: t('wrongFolderMessage', picked.name, previous.username, n(previous.fileCount)),
      buttons: [
        { label: t('cancel'), value: null },
        { label: t('useAnyway'), value: 'use' },
        { label: t('chooseAnother'), value: 'again', primary: true },
      ],
    });
    if (choice === 'use') return { dir: picked, acceptedEmpty: true };
    if (choice !== 'again') return null;
  }
}

async function askThenPick(
  id: string,
  previous: AccountRecord | null,
  title: string,
  message: string,
): Promise<{ dir: FileSystemDirectoryHandle; acceptedEmpty: boolean } | null> {
  const go = await surface.dialog({
    title,
    message,
    buttons: [cancelButton(), { label: t('chooseFolder'), value: true, primary: true }],
  });
  return go ? pickAccountFolder(id, previous) : null;
}

async function rootFolder(): Promise<FileSystemDirectoryHandle | null> {
  let root = await handles.getRoot();
  if (root) {
    if (!(await ensurePermission(root))) return null;
    if ((await checkFolder(root)) !== 'missing') return root;
  }
  const go = await surface.dialog({
    title: root ? t('rootMissingTitle') : t('pickRootTitle'),
    message: root ? t('rootMissingMessage', root.name) : t('pickRootMessage'),
    buttons: [cancelButton(), { label: t('chooseFolder'), value: true, primary: true }],
  });
  if (!go) return null;
  root = await pickDirectory('memfolio-root', 'downloads');
  if (!root) return null;
  await handles.setRoot(root);
  return root;
}

/**
 * The folder an account downloads into, together with its summary record.
 * Returns null when the user backs out. Never creates a replacement for a
 * folder that went missing; an account seen for the first time gets
 * `<root>/<username>`.
 */
export async function resolveAccountFolder(id: string, username: string): Promise<AccountFolder | null> {
  const previous = await getAccount(PLATFORM, id);
  const stored = await handles.getAccount(id);

  if (stored) {
    if (!(await ensurePermission(stored))) return null;
    if ((await checkFolder(stored)) === 'ok') return save(id, username, stored, previous);
    if (previous) await putAccount({ ...previous, lastStatus: 'folder-missing' });
    const picked = await askThenPick(
      id,
      previous,
      t('folderMissingTitle'),
      t('folderMissingMessage', username, previous?.relPath ?? previous?.folderName ?? stored.name),
    );
    return picked ? { ...(await save(id, username, picked.dir, previous)), acceptedEmpty: picked.acceptedEmpty } : null;
  }

  if (previous) {
    // The summary survived but the handle did not (site data was cleared).
    const picked = await askThenPick(id, previous, t('relinkTitle'), t('relinkMessage', username, previous.relPath ?? previous.folderName));
    return picked ? { ...(await save(id, username, picked.dir, previous)), acceptedEmpty: picked.acceptedEmpty } : null;
  }

  const root = await rootFolder();
  if (!root) return null;
  const opened = await openUnderRoot(root, sanitizeFileName(username));
  if (opened.state === 'ok') return save(id, username, opened.dir, null);
  if (opened.state === 'root-missing') {
    surface.toast(t('rootMissingMessage', root.name), 'error', null);
    return null;
  }
  const picked = await askThenPick(id, null, t('linkTitle'), t('linkMessage', username, root.name));
  return picked ? save(id, username, picked.dir, null) : null;
}
