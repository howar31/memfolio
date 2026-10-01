// Content script for instagram.com (isolated world). Everything that talks to
// the platform or to the disk runs here; the popup only reads summaries.

import { initI18n, uiLanguage } from '../../core/i18n';
import { IMPORT_MESSAGE, PENDING_TOOL_KEY, PENDING_TOOL_MAX_AGE_MS, type PendingTool } from '../../core/messages';
import { allAccounts, getSettings, onStorageChange } from '../../core/records';
import { surface } from '../../ui/host';
import { PLATFORM, handles } from './env';
import { runFolderCheck } from './folder-check';
import { runImport } from './import';
import { downloadPost, scanPage, watchHover } from './page-buttons';
import { profileCard } from './profile';
import { parseRoute, type Route } from './routes';
import { downloadCurrentReel, downloadStory, floatingButtonsFor } from './viewer';


let lastHref = '';
let route: Route = { kind: 'other' };

function applyRoute(): void {
  if (location.href === lastHref) return;
  lastHref = location.href;
  route = parseRoute(location.href);
  if (route.kind === 'profile') profileCard.show({ username: route.username, tab: route.tab });
  else profileCard.hide();
  surface.setFloatingButtons(floatingButtonsFor(route));
  surface.syncTheme();
  scanPage();
}

/** The site is a single-page app: watch address changes without touching its history functions. */
function watchRoute(): void {
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener('navigatesuccess', applyRoute);
  window.addEventListener('popstate', applyRoute);
  setInterval(applyRoute, 1000);
  applyRoute();
}

function watchDom(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scanPage, 300);
  }).observe(document.body, { childList: true, subtree: true });
}

function watchHotkey(): void {
  // Ctrl/Cmd + Shift + D saves what the current page shows.
  document.addEventListener('keydown', (ev) => {
    if (ev.key.toLowerCase() !== 'd' || !ev.shiftKey || !(ev.ctrlKey || ev.metaKey)) return;
    const r = parseRoute(location.href);
    if (r.kind !== 'post' && r.kind !== 'story' && r.kind !== 'highlight' && r.kind !== 'reels-feed') return;
    ev.preventDefault();
    ev.stopPropagation();
    if (r.kind === 'post') void downloadPost(r.shortcode);
    else if (r.kind === 'reels-feed') void downloadCurrentReel();
    else void downloadStory(false);
  });
}

/** Drops folder handles whose account was removed from the list in the popup. */
async function dropOrphanHandles(): Promise<void> {
  const known = new Set((await allAccounts()).filter((a) => a.platform === PLATFORM).map((a) => a.id));
  for (const id of await handles.accountIds()) if (!known.has(id)) await handles.deleteAccount(id);
}

/** The folder check is a developer tool: it opens only while developer mode is on. */
async function openFolderCheck(): Promise<void> {
  if ((await getSettings()).developerMode) await runFolderCheck();
}

/** The popup opens the import by message, or leaves a request in storage when it had to open the tab first. */
async function openToolIfAsked(): Promise<void> {
  const pending = (await chrome.storage.local.get(PENDING_TOOL_KEY))[PENDING_TOOL_KEY] as PendingTool | undefined;
  if (!pending) return;
  await chrome.storage.local.remove(PENDING_TOOL_KEY);
  if (pending.tool === 'import' && Date.now() - pending.at < PENDING_TOOL_MAX_AGE_MS) void runImport();
}

/** Settings or accounts changed elsewhere; a language change redraws what is on screen. */
async function onStoredChange(): Promise<void> {
  const before = uiLanguage();
  await initI18n();
  if (uiLanguage() !== before) {
    lastHref = '';
    applyRoute();
  }
  profileCard.refresh();
}

function main(): void {
  profileCard.onTools({ import: () => void runImport(), check: () => void openFolderCheck() });
  chrome.runtime.onMessage.addListener((message: unknown) => {
    const type = (message as { type?: string } | null)?.type;
    if (type === IMPORT_MESSAGE) void runImport();
  });
  onStorageChange(() => void onStoredChange());
  void dropOrphanHandles().catch((e) => console.warn('[memfolio]', e));
  watchRoute();
  watchDom();
  watchHover();
  watchHotkey();
  void openToolIfAsked().catch((e) => console.warn('[memfolio]', e));
}

async function start(): Promise<void> {
  await initI18n().catch((e) => console.warn('[memfolio]', e));
  main();
}

if (document.body) void start();
else document.addEventListener('DOMContentLoaded', () => void start(), { once: true });
