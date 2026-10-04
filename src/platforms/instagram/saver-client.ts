import type { SaveFile } from '../../core/download';
import { abortError } from '../../core/pacing';
import type { SaverReply, SaverRequest } from '../../core/saver-protocol';

const PING_MS = 15_000;

async function call(req: SaverRequest): Promise<unknown> {
  const reply = (await chrome.runtime.sendMessage(req)) as SaverReply | undefined;
  if (!reply) throw new Error('the extension did not answer');
  if (reply.ok) return reply.value;
  throw reply.aborted ? abortError() : new Error(reply.error);
}

/**
 * Saving below `path` inside the browser's download folder. `quiet` keeps the
 * files out of the browser's download list.
 */
export function saverFor(path: string, quiet: boolean): SaveFile {
  return async (name, url, signal) => {
    const token = crypto.randomUUID();
    const onAbort = (): void => void call({ type: 'memfolio:saver-cancel', token }).catch(() => {});
    signal.addEventListener('abort', onAbort);
    const ping = setInterval(() => void call({ type: 'memfolio:saver-ping' }).catch(() => {}), PING_MS);
    try {
      await call({ type: 'memfolio:saver-save', token, url, path, name, quiet });
    } finally {
      clearInterval(ping);
      signal.removeEventListener('abort', onAbort);
    }
  };
}
