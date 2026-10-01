// Diagnostics for one picked folder. The File System Access API does not say
// whether a folder is a link (symlink, junction) or a real directory; these
// functions report what can be observed: what the browser lists, whether
// writing works, and whether two handles reach the same files.

import { parseFileName } from './naming';

export interface FolderReport {
  name: string;
  permission: PermissionState;
  readable: boolean;
  files: number;
  folders: number;
  /** Files that follow the download naming scheme. */
  mediaFiles: number;
  /** Account ids found in those file names, most files first. */
  owners: Array<{ id: string; files: number }>;
  /** Name of the error that stopped reading, if any. */
  error: string | null;
}

export type StepResult = { ok: true } | { ok: false; step: 'create' | 'write' | 'read' | 'delete'; error: string };

function errorName(e: unknown): string {
  return (e as { name?: string } | null)?.name || (e instanceof Error ? e.message : String(e));
}

function tempName(): string {
  return `memfolio-check-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
}

async function writeBytes(file: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const writer = (await file.createWritable()).getWriter();
  try {
    await writer.write(bytes);
    await writer.close();
  } catch (e) {
    await writer.abort().catch(() => undefined);
    throw e;
  }
}

/** Reads the folder's entries (names only, no recursion) and summarises them. */
export async function inspectFolder(dir: FileSystemDirectoryHandle): Promise<FolderReport> {
  const report: FolderReport = {
    name: dir.name,
    permission: 'prompt',
    readable: false,
    files: 0,
    folders: 0,
    mediaFiles: 0,
    owners: [],
    error: null,
  };
  try {
    report.permission = await dir.queryPermission({ mode: 'readwrite' });
    if (report.permission !== 'granted') return report;
    const owners = new Map<string, number>();
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'directory') {
        report.folders += 1;
        continue;
      }
      report.files += 1;
      const parsed = parseFileName(name);
      if (!parsed) continue;
      report.mediaFiles += 1;
      owners.set(parsed.ownerId, (owners.get(parsed.ownerId) ?? 0) + 1);
    }
    report.owners = [...owners].map(([id, files]) => ({ id, files })).sort((a, b) => b.files - a.files);
    report.readable = true;
  } catch (e) {
    report.error = errorName(e);
    report.files = report.folders = report.mediaFiles = 0;
  }
  return report;
}

/**
 * Proves that files can be written through this handle: creates a temporary
 * file, writes it, reads its size back and removes it again.
 */
export async function writeTest(dir: FileSystemDirectoryHandle): Promise<StepResult> {
  const name = tempName();
  const bytes = new Uint8Array(16).fill(0x4d);
  let file: FileSystemFileHandle;
  try {
    file = await dir.getFileHandle(name, { create: true });
  } catch (e) {
    return { ok: false, step: 'create', error: errorName(e) };
  }
  let failure: StepResult | null = null;
  try {
    await writeBytes(file, bytes);
  } catch (e) {
    failure = { ok: false, step: 'write', error: errorName(e) };
  }
  if (!failure) {
    try {
      const size = (await file.getFile()).size;
      if (size !== bytes.byteLength) failure = { ok: false, step: 'read', error: `size ${size}` };
    } catch (e) {
      failure = { ok: false, step: 'read', error: errorName(e) };
    }
  }
  try {
    await dir.removeEntry(name);
  } catch (e) {
    failure ??= { ok: false, step: 'delete', error: errorName(e) };
  }
  return failure ?? { ok: true };
}

export interface FolderComparison {
  /** The browser treats both handles as the same entry (same path). */
  sameEntry: boolean;
  /** Both list the same, non-empty set of file names. */
  sameListing: boolean;
  filesA: number;
  filesB: number;
}

async function fileNames(dir: FileSystemDirectoryHandle): Promise<Set<string>> {
  const names = new Set<string>();
  for await (const [name, handle] of dir.entries()) if (handle.kind === 'file') names.add(name);
  return names;
}

/** Compares two handles without writing anything. */
export async function compareFolders(a: FileSystemDirectoryHandle, b: FileSystemDirectoryHandle): Promise<FolderComparison> {
  const [namesA, namesB] = await Promise.all([fileNames(a), fileNames(b)]);
  let same = namesA.size > 0 && namesA.size === namesB.size;
  if (same) for (const n of namesA) if (!namesB.has(n)) same = false;
  return { sameEntry: await a.isSameEntry(b), sameListing: same, filesA: namesA.size, filesB: namesB.size };
}

/**
 * Decides whether two handles reach the same physical folder: a temporary file
 * written through `a` either shows up through `b` or it does not. The file is
 * removed again. This is the only test that tells a link and its target from
 * two separate folders with equal content.
 */
export async function sharesStorage(
  a: FileSystemDirectoryHandle,
  b: FileSystemDirectoryHandle,
): Promise<MarkerResult> {
  const name = tempName();
  let created = false;
  try {
    const file = await a.getFileHandle(name, { create: true });
    created = true;
    await writeBytes(file, new Uint8Array([1]));
    let shared = true;
    try {
      await b.getFileHandle(name);
    } catch (e) {
      if (errorName(e) !== 'NotFoundError') throw e;
      shared = false;
    }
    return { ok: true, shared };
  } catch (e) {
    return { ok: false, error: errorName(e) };
  } finally {
    if (created) await a.removeEntry(name).catch(() => undefined);
  }
}

export type Location =
  /** Reached from the parent through ordinary folders only. */
  | { kind: 'real'; path: string[] }
  /**
   * The folder's path lies inside the parent, yet the parent cannot open the
   * segment `blockedAt`. The browser hides links from a folder's listing, so
   * that segment is a symlink or junction (the folder itself was readable when
   * picked directly).
   */
  | { kind: 'link'; path: string[]; blockedAt: string }
  | { kind: 'same' }
  | { kind: 'outside' };

/**
 * Tells whether `dir` sits below `parent` as a real folder or is reached
 * through a link. Nothing is written. Without a parent that contains the
 * folder there is nothing to compare against and the answer is 'outside'.
 */
export async function locateUnder(parent: FileSystemDirectoryHandle, dir: FileSystemDirectoryHandle): Promise<Location> {
  let path: string[] | null;
  try {
    path = await parent.resolve(dir);
  } catch {
    path = null;
  }
  if (!path) return { kind: 'outside' };
  if (path.length === 0) return { kind: 'same' };
  let current = parent;
  for (const segment of path) {
    try {
      current = await current.getDirectoryHandle(segment);
    } catch (e) {
      if (errorName(e) === 'NotFoundError') return { kind: 'link', path, blockedAt: segment };
      throw e;
    }
  }
  return { kind: 'real', path };
}

export type MarkerResult = { ok: true; shared: boolean } | { ok: false; error: string };

/** Everything one run of the folder check found. */
export interface CheckSnapshot {
  report: FolderReport;
  /** Every folder the picked one was compared against, including those that do not contain it. */
  parents: Array<{ name: string; role: 'download-root' | 'import-parent' | 'picked'; location: Location }>;
  /** Managed accounts whose stored folder is the picked one. */
  accounts: string[];
  write: StepResult | null;
  comparison: { otherName: string; result: FolderComparison; marker: MarkerResult | null } | null;
}

/** The check's results as plain data for a JSON file. It holds folder names and account names, no file contents. */
export function exportCheck(
  snapshot: CheckSnapshot,
  meta: { version: string; userAgent: string; at: Date },
): Record<string, unknown> {
  return {
    tool: 'memfolio-folder-check',
    formatVersion: 1,
    extensionVersion: meta.version,
    generatedAt: meta.at.toISOString(),
    userAgent: meta.userAgent,
    folder: snapshot.report,
    parents: snapshot.parents,
    managedAccounts: snapshot.accounts,
    writeTest: snapshot.write,
    comparison: snapshot.comparison,
  };
}

export function exportFileName(at: Date): string {
  const p = (v: number): string => String(v).padStart(2, '0');
  const date = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}`;
  const time = `${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `memfolio-folder-check-${date}-${time}.json`;
}
