import { describe, expect, it } from 'vitest';
import { buildFileIndex } from '../../src/core/file-index';
import { needsFullScan, runAccountDownload, type RunDeps, type RunProgress } from '../../src/core/run';
import { StopError, type ListingPage, type ListingSource, type MediaItem } from '../../src/core/types';
import { FakeDir, asDir } from '../helpers/fake-fs';

const OWNER = '42';

function media(n: number, over: Partial<MediaItem> = {}): MediaItem {
  const pk = String(100000000000 + n);
  return {
    id: `${pk}_${OWNER}`,
    pk,
    ownerId: OWNER,
    ownerUsername: 'acct',
    takenAt: 1600000000 + n,
    kind: 'image',
    url: `https://cdn.test/${pk}.jpg`,
    shortcode: `S${n}`,
    ...over,
  };
}

/** Newest-first pages; page size 3. `newest` is the highest media number. */
function pagesOf(newest: number, pageSize = 3): ListingPage[] {
  const pages: ListingPage[] = [];
  for (let n = newest; n >= 1; n -= pageSize) {
    const items: MediaItem[] = [];
    for (let k = n; k > n - pageSize && k >= 1; k--) items.push(media(k));
    pages.push({ items, postCount: items.length, nextCursor: n - pageSize >= 1 ? `c${n - pageSize}` : null });
  }
  return pages;
}

function sourceOf(pages: ListingPage[], failAt?: { page: number; error: Error }): ListingSource & { fetched: number } {
  const src = {
    fetched: 0,
    async fetchPage(cursor: string | null): Promise<ListingPage> {
      const i = cursor === null ? 0 : pages.findIndex((p, idx) => idx > 0 && pages[idx - 1]!.nextCursor === cursor);
      if (failAt && i === failAt.page) throw failAt.error;
      src.fetched += 1;
      return pages[i]!;
    },
  };
  return src;
}

function nameOfMedia(n: number): string {
  return `acct_${1600000000 + n}_${100000000000 + n}_${OWNER}.jpg`;
}

async function setup(opts: {
  dir?: FakeDir;
  pages: ListingPage[];
  mode?: 'incremental' | 'full';
  failAt?: { page: number; error: Error };
  fetchMedia?: RunDeps['fetchMedia'];
  resolve?: RunDeps['resolve'];
  controller?: AbortController;
  onProgress?: (p: RunProgress) => void;
}) {
  const dir = opts.dir ?? new FakeDir('acct');
  const source = sourceOf(opts.pages, opts.failAt);
  const order: string[] = [];
  const deps: RunDeps = {
    source,
    dir: asDir(dir),
    index: await buildFileIndex(asDir(dir)),
    mode: opts.mode ?? 'incremental',
    signal: (opts.controller ?? new AbortController()).signal,
    pageDelayMs: () => 0,
    mediaDelayMs: () => 0,
    sleep: async () => {},
    fetchMedia:
      opts.fetchMedia ??
      (async (url) => {
        order.push(url);
        return new Response(new Uint8Array([1, 2, 3, 4]));
      }),
    resolve: opts.resolve,
    onProgress: opts.onProgress ?? (() => {}),
  };
  return { dir, source, deps, order };
}

describe('runAccountDownload', () => {
  it('downloads every listed media into an empty folder', async () => {
    const t = await setup({ pages: pagesOf(7) });
    const r = await runAccountDownload(t.deps);
    expect(r).toMatchObject({ listing: 'complete', posts: 7, media: 7, downloaded: 7, skipped: 0, cancelled: false });
    expect(r.failed).toEqual([]);
    expect(t.dir.fileNames().sort()).toEqual([1, 2, 3, 4, 5, 6, 7].map(nameOfMedia).sort());
    expect(t.dir.sizeOf(nameOfMedia(1))).toBe(4);
  });

  it('downloads oldest first so an interrupted run leaves only the newest missing', async () => {
    const t = await setup({ pages: pagesOf(4) });
    await runAccountDownload(t.deps);
    expect(t.order).toEqual([1, 2, 3, 4].map((n) => `https://cdn.test/${100000000000 + n}.jpg`));
  });

  it('stops paging at the first page that is fully on disk in incremental mode', async () => {
    const dir = new FakeDir('acct');
    for (const n of [1, 2, 3, 4, 5, 6, 7]) dir.put(nameOfMedia(n));
    const t = await setup({ dir, pages: pagesOf(9) }); // 9,8 are new; pages: [9,8,7] [6,5,4] [3,2,1]
    const r = await runAccountDownload(t.deps);
    expect(r.listing).toBe('early-stop');
    expect(t.source.fetched).toBe(2);
    expect(r.downloaded).toBe(2);
    expect(r.skipped).toBe(4);
  });

  it('makes a single request when nothing is new', async () => {
    const dir = new FakeDir('acct');
    for (const n of [1, 2, 3, 4, 5, 6]) dir.put(nameOfMedia(n));
    const t = await setup({ dir, pages: pagesOf(6) });
    const r = await runAccountDownload(t.deps);
    expect(t.source.fetched).toBe(1);
    expect(r).toMatchObject({ listing: 'early-stop', downloaded: 0, skipped: 3 });
  });

  it('walks every page in full mode and fills gaps in older pages', async () => {
    const dir = new FakeDir('acct');
    for (const n of [9, 8, 7, 6, 5, 4, 1]) dir.put(nameOfMedia(n)); // 3 and 2 are missing
    const t = await setup({ dir, pages: pagesOf(9), mode: 'full' });
    const r = await runAccountDownload(t.deps);
    expect(t.source.fetched).toBe(3);
    expect(r).toMatchObject({ listing: 'complete', downloaded: 2, skipped: 7 });
  });

  it('matches existing files by media id even when the stored name differs', async () => {
    const dir = new FakeDir('acct');
    dir.put(`formername_1599999999_${100000000000 + 1}_${OWNER}.jpg`);
    const t = await setup({ dir, pages: pagesOf(1) });
    const r = await runAccountDownload(t.deps);
    expect(r).toMatchObject({ downloaded: 0, skipped: 1 });
    expect(t.dir.fileNames()).toHaveLength(1);
  });

  it('re-downloads into an existing zero-byte file under its existing name', async () => {
    const dir = new FakeDir('acct');
    const leftover = `formername_1599999999_${100000000000 + 1}_${OWNER}.jpg`;
    dir.put(leftover, 0);
    const t = await setup({ dir, pages: pagesOf(1) });
    const r = await runAccountDownload(t.deps);
    expect(r.downloaded).toBe(1);
    expect(t.dir.fileNames()).toEqual([leftover]);
    expect(t.dir.sizeOf(leftover)).toBe(4);
  });

  it('keeps what was listed when the listing stops on an error and downloads it', async () => {
    const t = await setup({
      pages: pagesOf(9),
      failAt: { page: 2, error: new StopError('rate-limited', 'HTTP 429') },
    });
    const r = await runAccountDownload(t.deps);
    expect(r.listing).toBe('stopped');
    expect(r.stop?.reason).toBe('rate-limited');
    expect(r.downloaded).toBe(6);
    expect(needsFullScan(r)).toBe(true);
  });

  it('records a failed media and continues with the rest', async () => {
    const t = await setup({
      pages: pagesOf(3),
      fetchMedia: async (url) =>
        url.includes(String(100000000000 + 2)) ? new Response('gone', { status: 410 }) : new Response(new Uint8Array(2)),
    });
    const r = await runAccountDownload(t.deps);
    expect(r.downloaded).toBe(2);
    expect(r.failed).toEqual([{ id: `${100000000000 + 2}_${OWNER}`, message: 'HTTP 410' }]);
    expect(t.dir.fileNames()).not.toContain(nameOfMedia(2));
    expect(needsFullScan(r)).toBe(true);
  });

  it('removes the file it created when writing fails', async () => {
    const dir = new FakeDir('acct');
    dir.failWrites = true;
    const t = await setup({ dir, pages: pagesOf(1) });
    const r = await runAccountDownload(t.deps);
    expect(r.failed).toHaveLength(1);
    expect(dir.fileNames()).toEqual([]);
  });

  it('does not download anything when cancelled during listing', async () => {
    const controller = new AbortController();
    const t = await setup({
      pages: pagesOf(9),
      controller,
      onProgress: (p) => {
        if (p.phase === 'listing' && p.posts >= 3) controller.abort();
      },
    });
    const r = await runAccountDownload(t.deps);
    expect(r).toMatchObject({ listing: 'cancelled', cancelled: true, downloaded: 0 });
    expect(t.dir.fileNames()).toEqual([]);
    expect(needsFullScan(r)).toBe(true);
  });

  it('stops downloading when cancelled and leaves no partial file', async () => {
    const controller = new AbortController();
    let served = 0;
    const t = await setup({
      pages: pagesOf(5),
      controller,
      fetchMedia: async (_url, signal) => {
        served += 1;
        if (served === 3) {
          controller.abort();
          throw new DOMException('Aborted', 'AbortError');
        }
        void signal;
        return new Response(new Uint8Array(2));
      },
    });
    const r = await runAccountDownload(t.deps);
    expect(r).toMatchObject({ listing: 'complete', cancelled: true, downloaded: 2 });
    expect(t.dir.fileNames().sort()).toEqual([nameOfMedia(1), nameOfMedia(2)].sort());
    expect(needsFullScan(r)).toBe(false);
  });

  it('resolves media that the listing returned without a URL', async () => {
    const pages: ListingPage[] = [{ items: [media(1, { url: null, kind: 'video' })], postCount: 1, nextCursor: null }];
    const t = await setup({
      pages,
      resolve: async (item) => ({ ...item, url: 'https://cdn.test/resolved.mp4' }),
    });
    const r = await runAccountDownload(t.deps);
    expect(r.downloaded).toBe(1);
    expect(t.order).toEqual(['https://cdn.test/resolved.mp4']);
    expect(t.dir.fileNames()).toEqual([`acct_${1600000000 + 1}_${100000000000 + 1}_${OWNER}.mp4`]);
  });

  it('counts unresolvable media as failed', async () => {
    const pages: ListingPage[] = [{ items: [media(1, { url: null })], postCount: 1, nextCursor: null }];
    const t = await setup({ pages, resolve: async () => null });
    const r = await runAccountDownload(t.deps);
    expect(r.failed).toEqual([{ id: `${100000000000 + 1}_${OWNER}`, message: 'no downloadable URL' }]);
  });

  it('stops resolving when the platform tells it to stop', async () => {
    const pages: ListingPage[] = [
      { items: [media(2, { url: null }), media(1, { url: null })], postCount: 2, nextCursor: null },
    ];
    let calls = 0;
    const t = await setup({
      pages,
      resolve: async () => {
        calls += 1;
        throw new StopError('rate-limited', 'HTTP 429');
      },
    });
    const r = await runAccountDownload(t.deps);
    expect(calls).toBe(1);
    expect(r.stop?.reason).toBe('rate-limited');
    expect(r.downloaded).toBe(0);
    expect(needsFullScan(r)).toBe(true);
  });

  it('ends the listing when a cursor repeats media already seen', async () => {
    const page: ListingPage = { items: [media(2), media(1)], postCount: 2, nextCursor: 'loop' };
    const looping: ListingSource & { fetched: number } = {
      fetched: 0,
      async fetchPage() {
        looping.fetched += 1;
        return page;
      },
    };
    const t = await setup({ pages: [page], mode: 'full' });
    const r = await runAccountDownload({ ...t.deps, source: looping });
    expect(looping.fetched).toBe(2);
    expect(r).toMatchObject({ listing: 'complete', media: 2, downloaded: 2 });
  });

  it('reports progress for both phases', async () => {
    const seen: RunProgress[] = [];
    const t = await setup({ pages: pagesOf(4), onProgress: (p) => seen.push({ ...p }) });
    await runAccountDownload(t.deps);
    expect(seen.some((p) => p.phase === 'listing' && p.posts === 4 && p.pending === 4)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ phase: 'downloading', done: 4, total: 4 });
  });
});

describe('needsFullScan', () => {
  it('is false after a clean complete or early-stopped run', () => {
    const base = { posts: 0, media: 0, downloaded: 0, skipped: 0, failed: [], cancelled: false };
    expect(needsFullScan({ ...base, listing: 'complete' })).toBe(false);
    expect(needsFullScan({ ...base, listing: 'early-stop' })).toBe(false);
  });
});
