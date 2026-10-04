import { abortError } from './pacing';
import { isAbortError } from './types';

interface DownloadDelta {
  id: number;
  state?: { current?: string };
  error?: { current?: string };
}

/** The part of the browser's downloads API that saving a file needs. */
export interface DownloadsApi {
  download(options: { url: string; filename: string; conflictAction: 'overwrite'; saveAs: false }): Promise<number>;
  search(query: { id: number }): Promise<Array<{ id: number; state: string; error?: string; filename: string }>>;
  cancel(id: number): Promise<void>;
  erase(query: { id: number }): Promise<unknown>;
  onChanged: {
    addListener(cb: (delta: DownloadDelta) => void): void;
    removeListener(cb: (delta: DownloadDelta) => void): void;
  };
}

/**
 * Saves `url` as `filename`, a path inside the browser's download folder, and
 * waits until the file is complete. A file of the same name is written over.
 * Returns the file's path on disk. `forget` takes the finished entry out of the
 * browser's download list; the file stays.
 */
export async function saveByDownload(
  api: DownloadsApi,
  url: string,
  filename: string,
  signal: AbortSignal,
  opts: { forget: boolean },
): Promise<string> {
  if (signal.aborted) throw abortError();
  const id = await api.download({ url, filename, conflictAction: 'overwrite', saveAs: false });
  try {
    await new Promise<void>((resolve, reject) => {
      const end = (settle: () => void): void => {
        api.onChanged.removeListener(onChanged);
        signal.removeEventListener('abort', onAbort);
        settle();
      };
      const look = (state: string | undefined, error: string | undefined): void => {
        if (state === 'complete') end(resolve);
        else if (state === 'interrupted') end(() => reject(new Error(error ?? 'download interrupted')));
      };
      const onChanged = (delta: DownloadDelta): void => {
        if (delta.id === id) look(delta.state?.current, delta.error?.current);
      };
      const onAbort = (): void => end(() => reject(abortError()));
      api.onChanged.addListener(onChanged);
      signal.addEventListener('abort', onAbort);
      // The download may have ended before the listener was added.
      api.search({ id }).then(
        ([item]) => item && look(item.state, item.error),
        () => {},
      );
    });
  } catch (e) {
    if (isAbortError(e)) await api.cancel(id).catch(() => {});
    await api.erase({ id }).catch(() => {});
    throw e;
  }
  const [item] = await api.search({ id });
  if (opts.forget) await api.erase({ id }).catch(() => {});
  return item?.filename ?? '';
}
