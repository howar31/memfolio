// Folder paths typed by the user, kept inside the folder they start in and
// valid on every desktop file system.

const INVALID = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** One folder or file name. Empty when nothing usable is left. */
export function cleanSegment(name: string): string {
  const cleaned = name.replace(INVALID, '').replace(/^[.\s]+|[.\s]+$/g, '');
  return RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** A relative path with "/" between the names; "." and ".." are dropped. */
export function cleanRelPath(path: string): string {
  return path
    .split(/[\\/]/)
    .map(cleanSegment)
    .filter((s) => s !== '')
    .join('/');
}
