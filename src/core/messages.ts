// Signals between the popup and a platform tab.

/** Runtime message asking the content script of an open tab to open the folder import. */
export const IMPORT_MESSAGE = 'memfolio:open-import';

/**
 * Key in extension storage for a request left by the popup when it had to open
 * a new platform tab: the tab's content script takes it when it starts. The
 * request does not ride on the address, which the site may rewrite while loading.
 */
export const PENDING_TOOL_KEY = 'pendingTool';
export interface PendingTool {
  tool: 'import';
  /** When the request was made; an old request is dropped. */
  at: number;
}
export const PENDING_TOOL_MAX_AGE_MS = 60_000;
