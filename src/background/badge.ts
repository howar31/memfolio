// Marks the toolbar button of a tab whose platform page has nothing to download.
// Only the background script may change the button; content scripts report each page change.

import { PAGE_STATE_MESSAGE } from '../core/messages';

// Amber with dark text: the warning colours of the popup.
const WARN = '#f0b429';
const WARN_TEXT = '#2a1b12';

chrome.runtime.onMessage.addListener((message: unknown, sender) => {
  const m = message as { type?: string; supported?: unknown } | null;
  const tabId = sender.tab?.id;
  if (m?.type !== PAGE_STATE_MESSAGE || tabId === undefined) return false;
  const text = m.supported === false ? '!' : '';
  void chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  if (text) {
    void chrome.action.setBadgeBackgroundColor({ tabId, color: WARN }).catch(() => undefined);
    void chrome.action.setBadgeTextColor({ tabId, color: WARN_TEXT }).catch(() => undefined);
  }
  return false;
});
