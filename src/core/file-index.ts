import { parseFileName } from './naming';

interface Entry {
  name: string;
  handle: FileSystemFileHandle | null;
}

/**
 * What is already on disk in one folder, keyed by media id ("<pk>_<ownerId>").
 * The id, not the full file name, decides whether a media file exists: the
 * username and the timestamp in a name can differ.
 */
export class FileIndex {
  private entries = new Map<string, Entry[]>();
  private present = new Map<string, boolean>();
  private owners = new Map<string, number>();
  matchedCount = 0;
  totalCount = 0;

  add(name: string, handle: FileSystemFileHandle): void {
    this.totalCount += 1;
    const parsed = parseFileName(name);
    if (!parsed) return;
    this.matchedCount += 1;
    this.owners.set(parsed.ownerId, (this.owners.get(parsed.ownerId) ?? 0) + 1);
    const list = this.entries.get(parsed.id);
    if (list) list.push({ name, handle });
    else this.entries.set(parsed.id, [{ name, handle }]);
  }

  /** True when a non-empty file for this media id exists. Sizes are read on first use. */
  async has(id: string): Promise<boolean> {
    const known = this.present.get(id);
    if (known !== undefined) return known;
    let found = false;
    for (const e of this.entries.get(id) ?? []) {
      if (!e.handle) continue;
      try {
        if ((await e.handle.getFile()).size > 0) {
          found = true;
          break;
        }
      } catch {
        // Unreadable entry: treat as missing so it is downloaded again.
      }
    }
    this.present.set(id, found);
    return found;
  }

  /** Name of an existing file for this id (an empty leftover is reused), or null. */
  nameOf(id: string): string | null {
    return this.entries.get(id)?.[0]?.name ?? null;
  }

  markDownloaded(id: string, name: string): void {
    if (!this.entries.has(id)) {
      this.entries.set(id, [{ name, handle: null }]);
      this.matchedCount += 1;
      const parsed = parseFileName(name);
      if (parsed) this.owners.set(parsed.ownerId, (this.owners.get(parsed.ownerId) ?? 0) + 1);
    }
    this.present.set(id, true);
  }

  countForOwner(ownerId: string): number {
    return this.owners.get(ownerId) ?? 0;
  }

  ownerCounts(): ReadonlyMap<string, number> {
    return this.owners;
  }
}

/** Reads the file names of one folder (no recursion). Throws NotFoundError if the folder is gone. */
export async function buildFileIndex(dir: FileSystemDirectoryHandle): Promise<FileIndex> {
  const index = new FileIndex();
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') index.add(name, handle);
  }
  return index;
}
