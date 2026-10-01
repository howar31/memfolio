import type { MediaItem, MediaKind } from './types';

const INVALID_CHARS = /[<>:"/\\|?*]/g;
// <username>_<takenAt>_<pk>_<ownerId>.<ext>; the username may itself contain "_" and digits.
const FILE_NAME = /^(.+)_(\d{9,10})_(\d{5,})_(\d+)\.([0-9a-z]+)$/i;

export interface ParsedFileName {
  username: string;
  takenAt: number;
  pk: string;
  ownerId: string;
  /** "<pk>_<ownerId>" */
  id: string;
  ext: string;
}

export function extFromUrl(url: string, kind: MediaKind): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not an absolute URL; use the string as given.
  }
  const m = /\.([0-9a-z]+)$/i.exec(path);
  return m?.[1] ? m[1].toLowerCase() : kind === 'video' ? 'mp4' : 'jpg';
}

export function sanitizeFileName(name: string): string {
  return name.replace(INVALID_CHARS, '');
}

export function fileNameFor(item: MediaItem, url: string | null = item.url): string {
  const ext = url ? extFromUrl(url, item.kind) : item.kind === 'video' ? 'mp4' : 'jpg';
  return sanitizeFileName(`${item.ownerUsername}_${item.takenAt}_${item.id}.${ext}`);
}

export function parseFileName(name: string): ParsedFileName | null {
  const m = FILE_NAME.exec(name);
  if (!m) return null;
  const [, username, takenAt, pk, ownerId, ext] = m as unknown as [string, string, string, string, string, string];
  return { username, takenAt: Number(takenAt), pk, ownerId, id: `${pk}_${ownerId}`, ext: ext.toLowerCase() };
}
