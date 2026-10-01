import { parseFileName } from './naming';
import { abortError } from './pacing';

export interface ScanCandidate {
  dir: FileSystemDirectoryHandle;
  /** Folder names from the picked parent down to `dir`; empty for the parent itself. */
  path: string[];
  ownerId: string;
  /** Username on the newest file of this owner. */
  username: string;
  /** Files of this owner in the folder. */
  fileCount: number;
  /** All files in the folder that follow the naming scheme, whoever owns them. */
  totalFiles: number;
  /** Other owner ids that also have files in the folder. */
  otherOwners: number;
}

export interface ScanOptions {
  signal: AbortSignal;
  /** Levels below the picked folder to descend into. */
  maxDepth?: number;
  maxDirs?: number;
  onProgress?(dirsScanned: number): void;
}

export interface ScanResult {
  candidates: ScanCandidate[];
  dirsScanned: number;
  /** True when the folder limit ended the scan early. */
  truncated: boolean;
}

interface OwnerStat {
  count: number;
  newestAt: number;
  newestUsername: string;
}

/**
 * Looks for folders that already hold downloaded media by reading file names
 * only. Each folder yields at most one candidate: the owner id with the most
 * files. Nothing is written.
 */
export async function scanForAccounts(parent: FileSystemDirectoryHandle, opts: ScanOptions): Promise<ScanResult> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxDirs = opts.maxDirs ?? 2000;
  const result: ScanResult = { candidates: [], dirsScanned: 0, truncated: false };
  const queue: Array<{ dir: FileSystemDirectoryHandle; path: string[] }> = [{ dir: parent, path: [] }];

  while (queue.length > 0) {
    if (opts.signal.aborted) throw abortError();
    if (result.dirsScanned >= maxDirs) {
      result.truncated = true;
      break;
    }
    const { dir, path } = queue.shift()!;
    const owners = new Map<string, OwnerStat>();
    let totalFiles = 0;
    const subdirs: Array<{ dir: FileSystemDirectoryHandle; path: string[] }> = [];
    try {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          if (path.length < maxDepth) subdirs.push({ dir: handle, path: [...path, name] });
          continue;
        }
        const parsed = parseFileName(name);
        if (!parsed) continue;
        totalFiles += 1;
        const stat = owners.get(parsed.ownerId);
        if (!stat) {
          owners.set(parsed.ownerId, { count: 1, newestAt: parsed.takenAt, newestUsername: parsed.username });
        } else {
          stat.count += 1;
          if (parsed.takenAt > stat.newestAt) {
            stat.newestAt = parsed.takenAt;
            stat.newestUsername = parsed.username;
          }
        }
      }
    } catch {
      // Unreadable folder (removed, or access refused): skip it.
      continue;
    }
    result.dirsScanned += 1;
    opts.onProgress?.(result.dirsScanned);
    queue.push(...subdirs);

    let top: [string, OwnerStat] | null = null;
    for (const entry of owners) if (!top || entry[1].count > top[1].count) top = entry;
    if (top) {
      result.candidates.push({
        dir,
        path,
        ownerId: top[0],
        username: top[1].newestUsername,
        fileCount: top[1].count,
        totalFiles,
        otherOwners: owners.size - 1,
      });
    }
  }

  result.candidates.sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')));
  return result;
}
