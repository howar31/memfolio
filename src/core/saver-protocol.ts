// Messages from a platform page to the background script that saves files
// through the browser's download handling.

export type SaverRequest =
  /**
   * Saves `url` as `<path>/<name>` inside the download folder. `quiet` takes
   * the finished file out of the browser's download list; the file stays.
   */
  | { type: 'memfolio:saver-save'; token: string; url: string; path: string; name: string; quiet: boolean }
  | { type: 'memfolio:saver-cancel'; token: string }
  /** Sent while a save is under way, so the background script is not put to sleep. */
  | { type: 'memfolio:saver-ping' };

export type SaverReply = { ok: true; value: unknown } | { ok: false; error: string; aborted: boolean };

export const SAVER_PREFIX = 'memfolio:saver-';
