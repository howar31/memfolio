import { buildFileIndex } from '../../core/file-index';
import { n, t, when } from '../../core/i18n';
import { sleep } from '../../core/pacing';
import { adoptPending, findAccountByUsername, getAccount, getDefaultFolderName, getSettings, putAccount, type AccountRecord, type AccountStatus } from '../../core/records';
import { needsFullScan, runAccountDownload, type RunMode, type RunProgress, type RunResult } from '../../core/run';
import { isAbortError, type ListingPage, type ListingSource, type MediaItem } from '../../core/types';
import { h, logoMark } from '../../ui/dom';
import { surface, type ToastHandle } from '../../ui/host';
import { resolveAccountFolder } from './account-folder';
import { fetchPostMedia, isSoftStop, postsSource, reelsSource, resolveUserId, taggedSource } from './api';
import { bridge } from './bridge-client';
import { PLATFORM, describeError, describeStop, fetchMedia, gql, mediaDelay, mediaInfo, pageDelay } from './env';
import type { ProfileTab } from './routes';

interface Target {
  username: string;
  tab: ProfileTab;
}

interface ActiveRun extends Target {
  controller: AbortController;
  status: string;
  /** 0..1, or null while the total is unknown. */
  ratio: number | null;
}

const TAB_LABEL: Record<ProfileTab, Parameters<typeof t>[0]> = { posts: 'tabPosts', reels: 'tabReels', tagged: 'tabTagged' };

let current: Target | null = null;
let active: ActiveRun | null = null;
let lastResult: ToastHandle | null = null;
// The panel starts closed; the state lasts as long as the page does.
let expanded = false;
let renderSeq = 0;
// Used by the test build only.
// eslint-disable-next-line prefer-const
let runsDone = 0;
let tools: { import(): void; check(): void } = { import: () => {}, check: () => {} };

function withFirstPage(source: ListingSource, first: ListingPage): ListingSource {
  return { fetchPage: (cursor, signal) => (cursor === null ? Promise.resolve(first) : source.fetchPage(cursor, signal)) };
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function statusOf(result: RunResult): AccountStatus {
  if (result.cancelled) return 'cancelled';
  if (result.stop || result.listing === 'stopped') return 'stopped';
  return result.failed.length > 0 ? 'partial' : 'ok';
}

/**
 * The result message says how much of the tab was looked at, so that the
 * counts of a run that stopped early are not read as the size of the account
 * or of the folder.
 */
function summarize(result: RunResult, tab: ProfileTab, where: string, folderFiles: number): { text: string; warn: boolean } {
  const lines: string[] = [];
  if (result.cancelled) lines.push(t('resultCancelled'));
  const label = t(TAB_LABEL[tab]);
  lines.push(result.downloaded > 0 ? t('resultNew', label, n(result.downloaded)) : t('resultNone', label));
  const ended = result.cancelled || result.stop !== undefined ? 'partial' : result.listing;
  if (ended === 'complete') lines.push(t('resultScopeComplete', n(result.posts), n(result.media), n(result.skipped)));
  else if (ended === 'early-stop') lines.push(t('resultScopeEarly', n(result.posts), n(result.media)));
  else lines.push(t('resultScopePartial', n(result.posts), n(result.media), n(result.skipped)));
  lines.push(t('resultFolder', where, n(folderFiles)));
  if (result.failed.length > 0) lines.push(t('resultFailed', n(result.failed.length)));
  if (result.stop) lines.push(describeStop(result.stop));
  if (needsFullScan(result)) lines.push(t('resultWillFullScan'));
  return { text: lines.join('\n'), warn: result.failed.length > 0 || result.stop !== undefined };
}

async function run(target: Target, requested: RunMode, signal: AbortSignal, setStatus: (s: string, ratio?: number | null) => void): Promise<void> {
  const { username, tab } = target;
  setStatus(t('statusResolving'));

  // 1. Which account is this? The numeric id, not the username, is the key.
  const known = await findAccountByUsername(PLATFORM, username);
  let resolved: Awaited<ReturnType<typeof resolveUserId>> = null;
  try {
    resolved = await resolveUserId(username, { fromPage: bridge.findUserId, known: () => known?.id ?? null, gql, signal });
  } catch (e) {
    if (!isSoftStop(e)) throw e;
  }
  let userId = resolved?.id ?? null;

  const posts = postsSource(gql, username);
  let firstPage: ListingPage | null = null;
  if (tab === 'posts' && (!userId || resolved?.source === 'registry')) {
    // The listing itself names the owner; it also catches a username that now belongs to another account.
    firstPage = await posts.fetchPage(null, signal);
    const own = firstPage.items.find((i) => sameName(i.ownerUsername, username));
    if (own) userId = own.ownerId;
  }
  if (!userId) throw new Error(t('noAccountId', username));
  console.info(`[memfolio] ${username}: account id ${userId} (${resolved?.source ?? 'listing'})`);

  // 2. Where do its files go? Checked before any listing request.
  const folder = await resolveAccountFolder(userId, username);
  if (!folder) return;
  // The account now has a record under its id; an entry made from its address alone is done.
  const pasted = await adoptPending(PLATFORM, username, userId);
  if (pasted?.pinned && !folder.record.pinned) await putAccount({ ...folder.record, pinned: true });
  const index = await buildFileIndex(folder.dir);
  if (folder.record.fileCount > 0 && index.matchedCount === 0 && !folder.acceptedEmpty) {
    const go = await surface.dialog({
      title: t('emptyFolderTitle'),
      message: t('emptyFolderMessage', folder.record.relPath ?? folder.dir.name, n(folder.record.fileCount)),
      buttons: [
        { label: t('cancel'), value: false },
        { label: t('downloadAnyway'), value: true, primary: true },
      ],
    });
    if (!go) return;
  }

  // 3. List and download.
  const base = tab === 'posts' ? posts : tab === 'reels' ? reelsSource(gql, userId, username) : taggedSource(gql, userId);
  // Stopping at the first page that is already on disk is only valid for a tab
  // that has been listed to its end before. Files of the main grid may predate
  // this record (import); the other tabs start with one complete listing.
  const flagged = folder.record.needsFullScan[tab] === true;
  const listedBefore = folder.record.listed?.[tab] === true;
  const forced = requested !== 'full' && (flagged || (tab !== 'posts' && !listedBefore));
  const mode: RunMode = requested === 'full' || forced ? 'full' : 'incremental';
  if (forced && flagged) surface.toast(t('forcedFullScan'));
  console.info(`[memfolio] ${username}/${tab}: ${mode} run, ${index.matchedCount} files in "${folder.dir.name}"`);

  const result = await runAccountDownload({
    source: firstPage ? withFirstPage(base, firstPage) : base,
    dir: folder.dir,
    index,
    mode,
    signal,
    pageDelayMs: pageDelay,
    mediaDelayMs: mediaDelay,
    sleep,
    fetchMedia,
    // Reel listings come without a video URL; each new reel is looked up once.
    resolve: async (item: MediaItem, s: AbortSignal) => {
      if (!item.shortcode) return null;
      const items = await fetchPostMedia(item.shortcode, { gql, mediaInfo, relayPost: bridge.relayPost, signal: s });
      return items.find((i) => i.pk === item.pk && i.url) ?? null;
    },
    onProgress: (p: RunProgress) => {
      if (p.phase === 'listing') setStatus(t('statusListing', n(p.posts), n(p.pending)));
      else setStatus(t('statusDownloading', n(p.done), n(p.total)), p.total > 0 ? p.done / p.total : null);
    },
  });

  // 4. Record the outcome.
  const complete = result.listing === 'complete' && !result.cancelled && !needsFullScan(result);
  const flag = needsFullScan(result) ? true : complete ? false : flagged;
  // The pin is set in the popup and may have changed while this run was under way.
  const { pinned: _, ...kept } = folder.record;
  const record: AccountRecord = {
    ...kept,
    ...((await getAccount(PLATFORM, userId))?.pinned ? { pinned: true } : {}),
    username,
    fileCount: index.matchedCount,
    lastRunAt: Date.now(),
    lastStatus: statusOf(result),
    needsFullScan: { ...folder.record.needsFullScan, [tab]: flag },
    listed: { ...folder.record.listed, [tab]: listedBefore || complete },
  };
  await putAccount(record);
  if (result.failed.length > 0) console.warn('[memfolio] failed media:', result.failed);

  const summary = summarize(result, tab, record.relPath ?? record.folderName, index.matchedCount);
  lastResult = surface.toast(summary.text, summary.warn ? 'warn' : 'info', null);
}

async function start(target: Target, mode: RunMode): Promise<void> {
  if (active) return;
  // One result at a time: it stays until closed or until the next run starts.
  lastResult?.close();
  lastResult = null;
  const controller = new AbortController();
  const state: ActiveRun = { ...target, controller, status: '', ratio: null };
  active = state;
  const setStatus = (status: string, ratio: number | null = null): void => {
    state.status = status;
    state.ratio = ratio;
    void render();
  };
  try {
    await run(target, mode, controller.signal, setStatus);
  } catch (e) {
    if (isAbortError(e) || controller.signal.aborted) {
      surface.toast(t('resultCancelled'));
    } else {
      console.error('[memfolio]', e);
      lastResult = surface.toast(t('downloadFailed', describeError(e)), 'error', null);
    }
  } finally {
    active = null;
    void render();
    // Test build only: lets the end-to-end suite see that a run has ended, however briefly it lasted.
    E2E: document.documentElement.dataset.memfolioRunsDone = String(++runsDone);
  }
}

function statusNote(record: AccountRecord, tab: ProfileTab): { text: string; error: boolean } | null {
  if (record.lastStatus === 'folder-missing') return { text: t('noteFolderMissing'), error: true };
  if (record.needsFullScan[tab]) return { text: t('noteNeedsFullScan'), error: false };
  if (record.lastStatus === 'stopped') return { text: t('noteStopped'), error: false };
  return null;
}

async function buildCard(): Promise<HTMLElement | null> {
  const target = active ?? current;
  if (!target) return null;
  const ball = h(
    'button',
    {
      class: `ball ${active ? (active.ratio === null ? 'busy unknown' : 'busy') : ''}`,
      title: t('cardToggle'),
      attrs: { 'aria-label': t('cardToggle'), 'aria-expanded': String(expanded) },
      on: { click: () => ((expanded = !expanded), void render()) },
    },
    h('span', { class: 'core' }, logoMark(44)),
  );
  // The ring around the ball follows the run while the panel is closed.
  if (active && active.ratio !== null) ball.style.setProperty('--p', String(Math.round(active.ratio * 100)));
  if (!expanded) return h('div', { class: 'card' }, ball);

  const record = await findAccountByUsername(PLATFORM, target.username);
  const { developerMode } = await getSettings();
  const body = h('div', { class: 'body' }, h('div', { class: 'who', text: `@${target.username}` }));

  if (record) {
    body.append(h('div', { class: 'path', text: record.relPath ?? record.folderName }));
    // Counts and the last status describe the previous run; they are left out while one is in progress.
    if (!active) {
      body.append(
        h('div', { class: 'meta', text: t('cardFiles', n(record.fileCount)) }),
        h('div', { class: 'meta', text: record.lastRunAt ? t('cardLastRun', when(record.lastRunAt)) : t('cardNeverRun') }),
      );
      const note = statusNote(record, target.tab);
      if (note) body.append(h('div', { class: `note ${note.error ? 'error' : ''}`, text: note.text }));
    }
  } else {
    body.append(h('div', { class: 'meta', text: t('cardNotManaged') }));
    const parent = await getDefaultFolderName(PLATFORM);
    if (parent) body.append(h('div', { class: 'meta', text: t('cardDefaultTarget', `${parent}/${target.username}`) }));
  }
  body.append(h('div', { class: 'meta', text: t('cardListing', t(TAB_LABEL[target.tab])) }));

  if (active) {
    const bar = h('div', { class: `bar ${active.ratio === null ? 'unknown' : ''}` }, h('i'));
    if (active.ratio !== null) (bar.firstElementChild as HTMLElement).style.width = `${Math.round(active.ratio * 100)}%`;
    const controller = active.controller;
    body.append(
      h('div', { class: 'meta', text: active.status, attrs: { 'aria-live': 'polite' } }),
      bar,
      h('div', { class: 'actions' }, h('button', { class: 'btn', text: t('cancel'), on: { click: () => controller.abort() } })),
    );
  } else {
    body.append(
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', text: t('downloadAll'), title: t('downloadAllHint'), on: { click: () => void start(target, 'incremental') } }),
        h('button', { class: 'btn', text: t('fullScan'), title: t('fullScanHint'), on: { click: () => void start(target, 'full') } }),
      ),
      h(
        'div',
        { class: 'more' },
        h('button', { class: 'link', text: t('importOpen'), on: { click: () => tools.import() } }),
        developerMode ? h('button', { class: 'link', text: t('checkOpen'), on: { click: () => tools.check() } }) : null,
      ),
    );
  }
  return h('div', { class: 'card' }, body, ball);
}

async function render(): Promise<void> {
  const seq = ++renderSeq;
  const card = await buildCard();
  if (seq === renderSeq) surface.setCard(card, card !== null && !expanded);
}

/** The ball and its account panel on profile pages. They stay while a run is in progress. */
export const profileCard = {
  show(target: Target): void {
    current = target;
    void render();
  },
  hide(): void {
    current = null;
    void render();
  },
  refresh(): void {
    void render();
  },
  onTools(handlers: { import(): void; check(): void }): void {
    tools = handlers;
  },
  get busy(): boolean {
    return active !== null;
  },
};
