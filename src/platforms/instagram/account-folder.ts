import { saveInto, type SaveFile } from '../../core/download';
import { buildFileIndex, type FileIndex } from '../../core/file-index';
import { checkFolder, openInside, relativePath } from '../../core/folders';
import { n, t } from '../../core/i18n';
import { sanitizeFileName } from '../../core/naming';
import { allAccounts, getAccount, getDefaultFolderName, putAccount, setDefaultFolderName, type AccountRecord } from '../../core/records';
import { surface } from '../../ui/host';
import { PLATFORM, ensurePermission, fetchMedia, handles, pickDirectory } from './env';

/** Where an account's files go, and what is there already. */
export interface AccountFolder {
  record: AccountRecord;
  /** Name of the place, for messages. */
  label: string;
  /** The user was already told this folder holds none of the account's files and chose to use it. */
  acceptedEmpty?: boolean;
  /** The run was started without looking at what the folder holds. */
  unchecked?: boolean;
  /** The files that are there now. */
  openIndex(): Promise<FileIndex>;
  save: SaveFile;
}

/** A link in the account panel that changes something about the account's folder. */
export interface FolderLink {
  label: string;
  run(): Promise<void>;
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

async function save(
  id: string,
  username: string,
  dir: FileSystemDirectoryHandle,
  previous: AccountRecord | null,
  acceptedEmpty = false,
): Promise<AccountFolder> {
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
  return { record, label: dir.name, acceptedEmpty, openIndex: () => buildFileIndex(dir), save: saveInto(dir, fetchMedia) };
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
async function mirrorDefault(): Promise<void> {
  await setDefaultFolderName(PLATFORM, (await handles.getDefault())?.name ?? null);
}

/** Drops folder handles whose account was removed from the list in the popup. */
async function dropOrphanHandles(): Promise<void> {
  const known = new Set((await allAccounts()).filter((a) => a.platform === PLATFORM).map((a) => a.id));
  for (const id of await handles.accountIds()) if (!known.has(id)) await handles.deleteAccount(id);
}

/** Brings what is stored about folders in line with the account list; runs once when the page starts. */
export function startFolders(): void {
  void dropOrphanHandles().catch((e) => console.warn('[memfolio]', e));
  void mirrorDefault().catch((e) => console.warn('[memfolio]', e));
}

/** Where the first download of an account without a folder goes, as far as it can be named. */
export async function defaultTarget(username: string): Promise<string | null> {
  const parent = await getDefaultFolderName(PLATFORM);
  return parent ? `${parent}/${username}` : null;
}

/** The names of a folder line, outermost first. */
export function folderNames(record: AccountRecord): string[] {
  return record.relPath ? record.relPath.split('/') : [record.folderName];
}

/** Links offered for an account that has a folder. */
export function folderLinks(_record: AccountRecord): FolderLink[] {
  return [];
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
 * `<default location>/<username>`, or with `elsewhere` a folder the user picks.
 */
export async function resolveAccountFolder(id: string, username: string, elsewhere = false): Promise<AccountFolder | null> {
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
    return picked ? save(id, username, picked.dir, previous, picked.acceptedEmpty) : null;
  }

  if (previous) {
    // The summary survived but the handle did not (site data was cleared).
    const picked = await askThenPick(id, previous, t('relinkTitle'), t('relinkMessage', username, previous.relPath ?? previous.folderName));
    return picked ? save(id, username, picked.dir, previous, picked.acceptedEmpty) : null;
  }

  if (elsewhere) {
    const chosen = await askThenPick(id, null, t('linkTitle'), t('elsewhereMessage', username));
    return chosen ? save(id, username, chosen.dir, null) : null;
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
