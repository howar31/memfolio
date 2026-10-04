import { FileIndex } from './file-index';
import { parseFileName } from './naming';

/** A file as a folder input reports it: its path starts with the name of the picked folder. */
export interface ListedFile {
  name: string;
  size: number;
  webkitRelativePath: string;
}

/**
 * What a picked folder holds right now, from the file list of a folder input.
 * Only files directly in the folder count; an empty file counts as missing.
 */
export function indexFromList(files: Iterable<ListedFile>): { root: string; index: FileIndex } {
  const index = new FileIndex();
  let root = '';
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/');
    root ||= parts[0] ?? '';
    if (parts.length !== 2 || file.size === 0) continue;
    const parsed = parseFileName(file.name);
    if (parsed) index.markDownloaded(parsed.id, file.name);
  }
  return { root, index };
}
