import { describe, expect, it } from 'vitest';
import { saveByDownload, type DownloadsApi } from '../../src/core/browser-download';

type Delta = { id: number; state?: { current?: string }; error?: { current?: string } };

function fakeApi(opts: { stateAtSearch?: string; failStart?: boolean } = {}) {
  const listeners = new Set<(d: Delta) => void>();
  const calls: string[] = [];
  let asked: Record<string, unknown> | null = null;
  const api: DownloadsApi = {
    async download(o) {
      asked = o;
      calls.push('download');
      if (opts.failStart) throw new Error('illegal filename');
      return 7;
    },
    async search() {
      calls.push('search');
      return [{ id: 7, state: opts.stateAtSearch ?? 'in_progress', filename: '/dl/Memfolio/alice/a.jpg' }];
    },
    async cancel() {
      calls.push('cancel');
    },
    async erase() {
      calls.push('erase');
      return [7];
    },
    onChanged: {
      addListener: (cb) => void listeners.add(cb),
      removeListener: (cb) => void listeners.delete(cb),
    },
  };
  return { api, calls, listeners, asked: () => asked, emit: (d: Delta) => listeners.forEach((l) => l(d)) };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('saveByDownload', () => {
  it('asks for a download without a dialog that writes over a file of the same name', async () => {
    const f = fakeApi({ stateAtSearch: 'complete' });
    await saveByDownload(f.api, 'https://cdn.example/a.jpg', 'Memfolio/alice/a.jpg', new AbortController().signal, { forget: true });
    expect(f.asked()).toEqual({ url: 'https://cdn.example/a.jpg', filename: 'Memfolio/alice/a.jpg', conflictAction: 'overwrite', saveAs: false });
  });

  it('resolves with the path on disk when the download completes', async () => {
    const f = fakeApi();
    const p = saveByDownload(f.api, 'u', 'a.jpg', new AbortController().signal, { forget: false });
    await tick();
    f.emit({ id: 7, state: { current: 'complete' } });
    await expect(p).resolves.toBe('/dl/Memfolio/alice/a.jpg');
    expect(f.listeners.size).toBe(0);
    expect(f.calls).not.toContain('erase');
  });

  it('takes the entry out of the download list when asked to', async () => {
    const f = fakeApi({ stateAtSearch: 'complete' });
    await saveByDownload(f.api, 'u', 'a.jpg', new AbortController().signal, { forget: true });
    expect(f.calls).toContain('erase');
  });

  it('ignores changes of other downloads', async () => {
    const f = fakeApi();
    let done = false;
    const p = saveByDownload(f.api, 'u', 'a.jpg', new AbortController().signal, { forget: false }).then(() => (done = true));
    await tick();
    f.emit({ id: 8, state: { current: 'complete' } });
    await tick();
    expect(done).toBe(false);
    f.emit({ id: 7, state: { current: 'complete' } });
    await p;
  });

  it('fails with the reason of an interrupted download and removes its entry', async () => {
    const f = fakeApi();
    const p = saveByDownload(f.api, 'u', 'a.jpg', new AbortController().signal, { forget: false });
    await tick();
    f.emit({ id: 7, state: { current: 'interrupted' }, error: { current: 'SERVER_FORBIDDEN' } });
    await expect(p).rejects.toThrow('SERVER_FORBIDDEN');
    expect(f.calls).toContain('erase');
  });

  it('fails when the browser refuses to start the download', async () => {
    const f = fakeApi({ failStart: true });
    await expect(saveByDownload(f.api, 'u', 'a.jpg', new AbortController().signal, { forget: false })).rejects.toThrow('illegal filename');
  });

  it('cancels the download when the run is cancelled', async () => {
    const f = fakeApi();
    const c = new AbortController();
    const p = saveByDownload(f.api, 'u', 'a.jpg', c.signal, { forget: false });
    await tick();
    c.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toContain('cancel');
    expect(f.calls).toContain('erase');
  });

  it('starts nothing for a run that is already cancelled', async () => {
    const f = fakeApi();
    const c = new AbortController();
    c.abort();
    await expect(saveByDownload(f.api, 'u', 'a.jpg', c.signal, { forget: false })).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toEqual([]);
  });
});
