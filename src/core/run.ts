import { downloadToFile, type MediaFetcher } from './download';
import type { FileIndex } from './file-index';
import { fileNameFor } from './naming';
import { StopError, isAbortError, type ListingSource, type MediaItem, type MediaKind } from './types';

export type RunMode = 'incremental' | 'full';

export interface RunProgress {
  phase: 'listing' | 'downloading';
  /** Posts listed so far. */
  posts: number;
  /** Media files listed so far. */
  media: number;
  /** Media files not on disk yet. */
  pending: number;
  /** Download phase: files handled so far, including failures. */
  done: number;
  total: number;
}

export interface RunDeps {
  source: ListingSource;
  dir: FileSystemDirectoryHandle;
  index: FileIndex;
  mode: RunMode;
  signal: AbortSignal;
  pageDelayMs(): number;
  mediaDelayMs(kind: MediaKind): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  fetchMedia: MediaFetcher;
  /** Fills in the URL of an item the listing returned without one. */
  resolve?: (item: MediaItem, signal: AbortSignal) => Promise<MediaItem | null>;
  onProgress(progress: RunProgress): void;
}

export interface RunResult {
  /**
   * complete: reached the last page. early-stop: a page was fully on disk.
   * stopped: the platform or an error ended the listing. cancelled: the user did.
   */
  listing: 'complete' | 'early-stop' | 'stopped' | 'cancelled';
  stop?: StopError;
  posts: number;
  media: number;
  downloaded: number;
  skipped: number;
  failed: Array<{ id: string; message: string }>;
  cancelled: boolean;
}

/**
 * True when the next run must walk every page: older media may be missing and
 * an incremental run would stop before reaching it.
 */
export function needsFullScan(result: RunResult): boolean {
  return (
    result.listing === 'stopped' || result.listing === 'cancelled' || result.failed.length > 0 || result.stop !== undefined
  );
}

/**
 * Lists an account's media newest-first, then downloads what is missing.
 * Downloads run oldest-first: if the run is interrupted, the missing files are
 * the newest ones and the next incremental run finds them on the first pages.
 */
export async function runAccountDownload(deps: RunDeps): Promise<RunResult> {
  const { source, index, signal } = deps;
  const result: RunResult = {
    listing: 'complete',
    posts: 0,
    media: 0,
    downloaded: 0,
    skipped: 0,
    failed: [],
    cancelled: false,
  };
  const pending: MediaItem[] = [];
  const seen = new Set<string>();
  const report = (phase: RunProgress['phase'], done = 0): void =>
    deps.onProgress({
      phase,
      posts: result.posts,
      media: result.media,
      pending: pending.length,
      done,
      total: pending.length,
    });

  let cursor: string | null = null;
  for (;;) {
    if (signal.aborted) {
      result.listing = 'cancelled';
      break;
    }
    let page;
    try {
      page = await source.fetchPage(cursor, signal);
    } catch (e) {
      if (isAbortError(e) || signal.aborted) {
        result.listing = 'cancelled';
      } else {
        result.listing = 'stopped';
        result.stop = e instanceof StopError ? e : new StopError('bad-response', e instanceof Error ? e.message : String(e));
      }
      break;
    }

    let fresh = 0;
    let missing = 0;
    for (const item of page.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      fresh += 1;
      result.media += 1;
      if (await index.has(item.id)) {
        result.skipped += 1;
      } else {
        pending.push(item);
        missing += 1;
      }
    }
    // A page that only repeats known ids means the cursor did not advance.
    if (page.items.length > 0 && fresh === 0) break;
    result.posts += page.postCount;
    report('listing');

    if (!page.nextCursor) break;
    if (deps.mode === 'incremental' && page.items.length > 0 && missing === 0) {
      result.listing = 'early-stop';
      break;
    }
    if (signal.aborted) {
      result.listing = 'cancelled';
      break;
    }
    try {
      await deps.sleep(deps.pageDelayMs(), signal);
    } catch {
      result.listing = 'cancelled';
      break;
    }
    cursor = page.nextCursor;
  }

  if (result.listing === 'cancelled') {
    result.cancelled = true;
    return result;
  }

  const queue = pending.slice().reverse();
  let done = 0;
  for (const listed of queue) {
    if (signal.aborted) {
      result.cancelled = true;
      break;
    }
    try {
      let item: MediaItem | null = listed;
      if (!item.url) item = deps.resolve ? await deps.resolve(listed, signal) : null;
      if (!item?.url) throw new Error('no downloadable URL');
      const existing = index.nameOf(item.id);
      const name = existing ?? fileNameFor(item);
      await downloadToFile(deps.dir, name, item.url, deps.fetchMedia, signal, existing !== null);
      index.markDownloaded(item.id, name);
      result.downloaded += 1;
      done += 1;
      report('downloading', done);
      if (done < queue.length) await deps.sleep(deps.mediaDelayMs(item.kind), signal);
    } catch (e) {
      if (isAbortError(e) || signal.aborted) {
        result.cancelled = true;
        break;
      }
      if (e instanceof StopError) {
        result.stop = e;
        break;
      }
      result.failed.push({ id: listed.id, message: e instanceof Error ? e.message : String(e) });
      done += 1;
      report('downloading', done);
    }
  }
  return result;
}
