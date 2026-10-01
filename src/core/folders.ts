export type FolderState = 'ok' | 'needs-permission' | 'missing';

function errorName(e: unknown): string {
  return (e as { name?: string } | null)?.name ?? '';
}

/**
 * State of a stored folder handle. A handle records a path: after the folder is
 * moved, renamed or deleted, reading it fails with NotFoundError.
 */
export async function checkFolder(dir: FileSystemDirectoryHandle): Promise<FolderState> {
  try {
    if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') return 'needs-permission';
    const it = dir.keys()[Symbol.asyncIterator]();
    await it.next();
    await it.return?.();
    return 'ok';
  } catch (e) {
    const name = errorName(e);
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'needs-permission';
    return 'missing';
  }
}

export type RootOpenResult =
  | { state: 'ok'; dir: FileSystemDirectoryHandle; created: boolean }
  /** The name exists as a symlink or junction; the browser neither follows nor replaces it. */
  | { state: 'link' }
  | { state: 'root-missing' };

/** Opens `<root>/<name>`, creating it when it does not exist. */
export async function openUnderRoot(root: FileSystemDirectoryHandle, name: string): Promise<RootOpenResult> {
  try {
    return { state: 'ok', dir: await root.getDirectoryHandle(name), created: false };
  } catch (e) {
    if (errorName(e) !== 'NotFoundError') throw e;
  }
  // Tell a missing root apart from a name the browser refuses to touch.
  if ((await checkFolder(root)) === 'missing') return { state: 'root-missing' };
  try {
    return { state: 'ok', dir: await root.getDirectoryHandle(name, { create: true }), created: true };
  } catch (e) {
    if (errorName(e) === 'NotFoundError') return { state: 'link' };
    throw e;
  }
}

/**
 * Path of `dir` relative to the first known parent that contains it, as
 * reported by the browser: "<parent name>/<segment>/...". Null when no parent
 * contains it. Absolute paths are not available to web code.
 */
export async function relativePath(
  parents: FileSystemDirectoryHandle[],
  dir: FileSystemDirectoryHandle,
): Promise<string | null> {
  for (const parent of parents) {
    try {
      const path = await parent.resolve(dir);
      if (path) return [parent.name, ...path].join('/');
    } catch {
      // Parent no longer readable.
    }
  }
  return null;
}
