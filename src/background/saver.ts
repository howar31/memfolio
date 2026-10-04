// Background script of the build for browsers without folder access from a
// page: files are saved through the downloads API, below the download folder.

import { saveByDownload, type DownloadsApi } from '../core/browser-download';
import { cleanRelPath, cleanSegment } from '../core/paths';
import { SAVER_PREFIX, type SaverReply, type SaverRequest } from '../core/saver-protocol';
import { isAbortError } from '../core/types';

const downloads = chrome.downloads as unknown as DownloadsApi;
const running = new Map<string, AbortController>();

async function handle(req: SaverRequest): Promise<unknown> {
  switch (req.type) {
    case 'memfolio:saver-save': {
      const controller = new AbortController();
      running.set(req.token, controller);
      try {
        const filename = [cleanRelPath(req.path), cleanSegment(req.name)].filter((s) => s !== '').join('/');
        await saveByDownload(downloads, req.url, filename, controller.signal, { forget: req.quiet });
        return null;
      } finally {
        running.delete(req.token);
      }
    }
    case 'memfolio:saver-cancel':
      running.get(req.token)?.abort();
      return null;
    case 'memfolio:saver-ping':
      return null;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (reply: SaverReply) => void) => {
  const req = message as SaverRequest | null;
  if (typeof req?.type !== 'string' || !req.type.startsWith(SAVER_PREFIX)) return false;
  handle(req).then(
    (value) => sendResponse({ ok: true, value }),
    (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e), aborted: isAbortError(e) }),
  );
  return true;
});
