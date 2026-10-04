import { isAbortError } from './types';

export type MediaFetcher = (url: string, signal: AbortSignal) => Promise<Response>;

/**
 * Stores one media file under `name` in the place an account's files go.
 * `existed`: a file of that name is already there (an empty leftover) and is written over.
 */
export type SaveFile = (name: string, url: string, signal: AbortSignal, existed: boolean) => Promise<void>;

/** Saving into a folder the page holds a handle of. */
export function saveInto(dir: FileSystemDirectoryHandle, fetchMedia: MediaFetcher): SaveFile {
  return (name, url, signal, existed) => downloadToFile(dir, name, url, fetchMedia, signal, existed);
}

/**
 * Streams one media file into `dir/name`. The response is requested before the
 * file is created, so an HTTP failure leaves nothing behind; a file created by
 * this call is removed again if writing fails or is cancelled.
 */
export async function downloadToFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  url: string,
  fetchMedia: MediaFetcher,
  signal: AbortSignal,
  existed: boolean,
): Promise<void> {
  const res = await fetchMedia(url, signal);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (!res.body) throw new Error('empty response body');

  const file = await dir.getFileHandle(name, { create: true });
  let writable: FileSystemWritableFileStream | null = null;
  try {
    writable = await file.createWritable();
    await res.body.pipeTo(writable, { signal });
  } catch (e) {
    try {
      await writable?.abort();
    } catch {
      // The stream is already errored or closed.
    }
    if (!existed) {
      try {
        await dir.removeEntry(name);
      } catch {
        // Nothing to clean up.
      }
    }
    throw isAbortError(e) || signal.aborted ? new DOMException('Aborted', 'AbortError') : e;
  }
}
