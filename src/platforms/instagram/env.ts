import { HandleStore } from '../../core/handles';
import { t } from '../../core/i18n';
import { abortError, jitter, sleep } from '../../core/pacing';
import { budgetStore } from '../../core/records';
import { RequestGate, requestJson, type RetryPolicy } from '../../core/request';
import { StopError, type MediaKind, type StopReason } from '../../core/types';
import { surface } from '../../ui/host';
import { ORIGIN, createGraphql, type SessionInfo } from './api';
import { bridge } from './bridge-client';
import type { PageQueryResult } from './bridge-protocol';
import { pageFetch } from './net';

export const PLATFORM = 'instagram';

/**
 * Pacing of requests to the platform. The thresholds the platform applies are
 * not published and differ per account; these are conservative starting values.
 */
export const CONFIG = {
  /** Wait between two listing pages. */
  pageDelayMs: [1000, 2200] as [number, number],
  /** Minimum spacing between any two API requests. */
  apiGapMs: [900, 1800] as [number, number],
  /** After the platform answered 429 or 5xx in this tab, both waits above are multiplied by this for `slowdownMs`. */
  slowdownFactor: 3,
  slowdownMs: 3_600_000,
  /** Wait after a media file, by kind. */
  mediaDelayMs: { image: [150, 500], video: [400, 1100] } as Record<MediaKind, [number, number]>,
  /** API requests per rolling hour, across tabs. */
  hourlyBudget: 500,
  retry: {
    maxRetries: 6,
    backoff: { baseMs: 30_000, capMs: 600_000, jitterRatio: 0.2 },
    retryAfterCapMs: 900_000,
  } satisfies RetryPolicy,
  importMaxDepth: 3,
  importMaxDirs: 2000,
  /** App id the web client sends; used only when the page does not expose its own. */
  fallbackAppId: '936619743392459',
};

// Blocks labelled E2E exist only in the end-to-end test build; the production
// build removes them (see scripts/build.mjs). Short delays keep that suite fast.
E2E: {
  CONFIG.pageDelayMs = [5, 10];
  CONFIG.apiGapMs = [0, 0];
  CONFIG.mediaDelayMs = { image: [0, 0], video: [0, 0] };
  CONFIG.retry = { maxRetries: 2, backoff: { baseMs: 20, capMs: 40, jitterRatio: 0 }, retryAfterCapMs: 50 };
}

export const handles = new HandleStore(PLATFORM);

let throttledAt = 0;
/** Pacing factor: higher for a while after the platform pushed back in this tab. */
const pace = (): number => (throttledAt && Date.now() - throttledAt < CONFIG.slowdownMs ? CONFIG.slowdownFactor : 1);

export const pageDelay = (): number => jitter(...CONFIG.pageDelayMs) * pace();
/** True while requests in this tab are slowed down after the platform pushed back. */
export const slowedDown = (): boolean => pace() > 1;
export const mediaDelay = (kind: MediaKind): number => jitter(...CONFIG.mediaDelayMs[kind]);

const gate = new RequestGate({ minGapMs: CONFIG.apiGapMs, hourlyBudget: CONFIG.hourlyBudget }, budgetStore(PLATFORM), {
  sleep,
  rng: Math.random,
  now: Date.now,
  scale: pace,
});

const requestHooks = {
  sleep,
  rng: Math.random,
  onRetry(info: { status: number; attempt: number; max: number; delayMs: number }): void {
    throttledAt = Date.now();
    const seconds = Math.round(info.delayMs / 1000);
    console.warn(`[memfolio] HTTP ${info.status}, retry ${info.attempt}/${info.max} in ${seconds}s`);
    surface.toast(t('retryNotice', info.status, seconds, info.attempt, info.max), 'warn', info.delayMs);
  },
};

async function session(): Promise<SessionInfo> {
  const s = await bridge.session();
  return { appId: s.appId ?? CONFIG.fallbackAppId, dtsg: s.dtsg, lsd: s.lsd, wwwClaim: s.wwwClaim };
}

function csrf(): string | null {
  return /(?:^|; )csrftoken=([^;]+)/.exec(document.cookie)?.[1] ?? null;
}

const docIdCache = new Map<string, string>();

async function docId(name: string): Promise<string | null> {
  const cached = docIdCache.get(name);
  if (cached) return cached;
  // Modules load lazily with the page sections that use them, so misses are not cached.
  // Only the name that is needed is looked up: the page records an error for
  // every lookup of a module it has not loaded.
  const id = (await bridge.docIds([name]))[name] ?? null;
  if (id) docIdCache.set(name, id);
  console.info(`[memfolio] query ${name}: id ${id ? 'from page' : 'not on page'}`);
  return id;
}

const flagCache = new Map<string, Record<string, unknown>>();

async function providedVariables(name: string): Promise<Record<string, unknown> | null> {
  const cached = flagCache.get(name);
  if (cached) return cached;
  // Like query ids, definitions load with the page sections that use them; misses are not cached.
  const flags = (await bridge.providedVariables([name]))[name] ?? null;
  if (flags) flagCache.set(name, flags);
  console.info(`[memfolio] query ${name}: flags ${flags ? 'from page' : 'not on page'}`);
  return flags;
}

/** The bridge call, given up on (not cancelled in the page) when the run is stopped. */
function pageQuery(name: string, docId: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<PageQueryResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    bridge
      .pageQuery(name, docId, variables)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export const gql = createGraphql({
  gate,
  session,
  csrf,
  docId,
  providedVariables,
  pageQuery,
  fetch: pageFetch,
  policy: CONFIG.retry,
  hooks: requestHooks,
});

const MEDIA_INFO_OFF = 'memfolio:media-info-off';

/**
 * `/api/v1/media/<pk>/info/`. The site is retiring this endpoint per session;
 * once it answers with something other than JSON it is skipped for the rest of
 * the browser tab's session.
 */
export async function mediaInfo(pk: string, signal: AbortSignal): Promise<unknown | null> {
  if (sessionStorage.getItem(MEDIA_INFO_OFF)) return null;
  const s = await session();
  const headers: Record<string, string> = { 'x-ig-app-id': s.appId };
  if (s.wwwClaim) headers['x-ig-www-claim'] = s.wwwClaim;
  await gate.pass(signal);
  try {
    const body = (await requestJson(
      (sig) => pageFetch(`${ORIGIN}/api/v1/media/${pk}/info/`, { credentials: 'include', headers, signal: sig }),
      CONFIG.retry,
      requestHooks,
      signal,
    )) as { items?: unknown[] } | null;
    return body?.items?.[0] ?? null;
  } catch (e) {
    // A 404 is about one post; only the HTML shell means the endpoint itself is gone.
    if (e instanceof StopError && e.reason === 'bad-response') sessionStorage.setItem(MEDIA_INFO_OFF, '1');
    throw e;
  }
}

export const fetchMedia = (url: string, signal: AbortSignal): Promise<Response> => fetch(url, { signal });

const STOP_MESSAGES: Record<StopReason, Parameters<typeof t>[0]> = {
  login: 'stopLogin',
  challenge: 'stopChallenge',
  'rate-limited': 'stopRateLimited',
  budget: 'stopBudget',
  http: 'stopHttp',
  'bad-response': 'stopBadResponse',
  graphql: 'stopGraphql',
  network: 'stopNetwork',
};

/** User-facing explanation of why requests to the platform stopped. */
export function describeStop(e: StopError): string {
  return t(STOP_MESSAGES[e.reason], e.message);
}

export function describeError(e: unknown): string {
  if (e instanceof StopError) return describeStop(e);
  return e instanceof Error ? e.message : String(e);
}

/**
 * Opens the folder picker. Must run while a click is still "active" in the
 * page, which is why every caller asks through a dialog button first.
 */
export async function pickDirectory(
  id: string,
  startIn?: FileSystemDirectoryHandle | 'pictures',
): Promise<FileSystemDirectoryHandle | null> {
  E2E: {
    // The test page names the folder the next "pick" returns; it lives in the origin-private file system.
    const name = document.documentElement.dataset.memfolioPick;
    if (!name) return null;
    let dir = await navigator.storage.getDirectory();
    for (const part of name.split('/')) dir = await dir.getDirectoryHandle(part, { create: true });
    return dir;
  }
  if (typeof window.showDirectoryPicker !== 'function') {
    surface.toast(t('noPicker'), 'error', null);
    return null;
  }
  try {
    return await window.showDirectoryPicker({ id, mode: 'readwrite', startIn });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') return null;
    throw e;
  }
}

/** Makes sure the folder may be written, asking the user when the browser requires it. */
export async function ensurePermission(dir: FileSystemDirectoryHandle): Promise<boolean> {
  if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  try {
    if ((await dir.requestPermission({ mode: 'readwrite' })) === 'granted') return true;
  } catch {
    // No active click left; ask through a dialog, whose button provides one.
  }
  const go = await surface.dialog({
    title: t('permTitle'),
    message: t('permMessage', dir.name),
    buttons: [
      { label: t('cancel'), value: false },
      { label: t('permGrant'), value: true, primary: true },
    ],
  });
  if (!go) return false;
  try {
    return (await dir.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}
