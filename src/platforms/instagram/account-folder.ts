import { buildFileIndex } from '../../core/file-index';
import { checkFolder, openInside, relativePath } from '../../core/folders';
import { n, t } from '../../core/i18n';
import { sanitizeFileName } from '../../core/naming';
import { getAccount, putAccount, setDefaultFolderName, type AccountRecord } from '../../core/records';
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
  const fallback = await handles.getDefault();
  return relativePath(fallback ? [...parents, fallback] : parents, dir);
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
    const picked = await pickDirectory('memfolio-account', (await handles.getDefault()) ?? 'pictures');
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

async function setDefault(dir: FileSystemDirectoryHandle): Promise<void> {
  await handles.setDefault(dir);
  await setDefaultFolderName(PLATFORM, dir.name);
}

/** Keeps the name of the default location where the popup can read it. */
export async function mirrorDefault(): Promise<void> {
  await setDefaultFolderName(PLATFORM, (await handles.getDefault())?.name ?? null);
}

/** The folder new accounts get their own folder in; asked for once, and again when it went missing. */
async function defaultFolder(): Promise<FileSystemDirectoryHandle | null> {
  const known = await handles.getDefault();
  if (known) {
    if (!(await ensurePermission(known))) return null;
    if ((await checkFolder(known)) !== 'missing') return known;
  }
  const go = await surface.dialog({
    title: known ? t('defaultMissingTitle') : t('defaultPickTitle'),
    message: known ? t('defaultMissingMessage', known.name) : t('defaultPickMessage'),
    buttons: [cancelButton(), { label: t('chooseFolder'), value: true, primary: true }],
  });
  if (!go) return null;
  const picked = await pickDirectory('memfolio-default', known ? undefined : 'pictures');
  if (!picked) return null;
  await setDefault(picked);
  return picked;
}

/** Lets the user choose another default location. Nothing is moved and no account changes its folder. */
export async function changeDefault(): Promise<void> {
  const known = await handles.getDefault();
  const go = await surface.dialog({
    title: t('defaultChangeTitle'),
    message: `${known ? t('defaultCurrent', known.name) : t('optDefaultNone')}\n${t('defaultChangeNote')}`,
    buttons: [cancelButton(), { label: t('chooseFolder'), value: true, primary: true }],
  });
  if (!go) return;
  const picked = await pickDirectory('memfolio-default', known ? undefined : 'pictures');
  if (!picked || !(await ensurePermission(picked))) return;
  await setDefault(picked);
  surface.toast(t('defaultChanged', picked.name));
}

/**
 * The folder an account downloads into, together with its summary record.
 * Returns null when the user backs out. Never creates a replacement for a
 * folder that went missing; an account seen for the first time gets
 * `<default location>/<username>`.
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

  const parent = await defaultFolder();
  if (!parent) return null;
  const opened = await openInside(parent, sanitizeFileName(username));
  if (opened.state === 'ok') return save(id, username, opened.dir, null);
  if (opened.state === 'parent-missing') {
    surface.toast(t('defaultMissingMessage', parent.name), 'error', null);
    return null;
  }
  const picked = await askThenPick(id, null, t('linkTitle'), t('linkMessage', username, parent.name));
  return picked ? save(id, username, picked.dir, null) : null;
}
