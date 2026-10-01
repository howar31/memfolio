// Account summaries and settings live in extension storage so the popup and the
// content script can both read them. They never contain folder handles or absolute paths.

export type AccountStatus =
  | 'imported' // added by the folder import, not run yet
  | 'ok' // last run finished and nothing is known to be missing
  | 'partial' // last run ended with failed or unlisted media
  | 'stopped' // the platform ended the last run (rate limit, login, error)
  | 'cancelled'
  | 'folder-missing'
  | 'needs-relink'; // summary exists but the folder handle is gone

export interface AccountRecord {
  platform: string;
  /** Numeric account id on the platform; stable across username changes. */
  id: string;
  username: string;
  folderName: string;
  /** Path relative to a folder the user picked, as reported by the browser. */
  relPath: string | null;
  fileCount: number;
  lastRunAt: number | null;
  lastStatus: AccountStatus;
  /** Per listing (e.g. "posts"): the next run must walk every page. */
  needsFullScan: Record<string, boolean>;
  /** Per listing: a run has walked every page at least once. */
  listed?: Record<string, boolean>;
  addedAt: number;
}

/** UI language: `auto` follows the browser, the others name a folder in `_locales`. */
export type Language = 'auto' | 'en' | 'zh_TW';

export interface Settings {
  /** Shows diagnostic tools (the folder check) in the card and the popup. */
  developerMode: boolean;
  language: Language;
  /** Where a single download goes: the browser's download folder, or the account folder when the account is managed. */
  singleSave: SingleSave;
  /** Clock used for times of day. */
  timeFormat: TimeFormat;
}

export type SingleSave = 'browser' | 'folder';

export type TimeFormat = '24' | '12';

export const DEFAULT_SETTINGS: Settings = { developerMode: false, language: 'auto', singleSave: 'browser', timeFormat: '24' };

const ACCOUNT_PREFIX = 'account:';
const SETTINGS_KEY = 'settings';

function accountKey(platform: string, id: string): string {
  return `${ACCOUNT_PREFIX}${platform}:${id}`;
}

export async function getAccount(platform: string, id: string): Promise<AccountRecord | null> {
  const key = accountKey(platform, id);
  const got = await chrome.storage.local.get(key);
  return (got[key] as AccountRecord | undefined) ?? null;
}

export async function putAccount(record: AccountRecord): Promise<void> {
  await chrome.storage.local.set({ [accountKey(record.platform, record.id)]: record });
}

export async function removeAccount(platform: string, id: string): Promise<void> {
  await chrome.storage.local.remove(accountKey(platform, id));
}

export async function allAccounts(): Promise<AccountRecord[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(ACCOUNT_PREFIX))
    .map(([, v]) => v as AccountRecord);
}

export async function findAccountByUsername(platform: string, username: string): Promise<AccountRecord | null> {
  const wanted = username.toLowerCase();
  return (await allAccounts()).find((a) => a.platform === platform && a.username.toLowerCase() === wanted) ?? null;
}

/** An account named by its profile address only: no id and no folder until its first run. */
export interface PendingAccount {
  platform: string;
  /** Lower case. */
  username: string;
  addedAt: number;
}

const PENDING_PREFIX = 'pending:';

function pendingKey(platform: string, username: string): string {
  return `${PENDING_PREFIX}${platform}:${username.toLowerCase()}`;
}

export async function putPending(entries: PendingAccount[]): Promise<void> {
  if (entries.length === 0) return;
  await chrome.storage.local.set(Object.fromEntries(entries.map((e) => [pendingKey(e.platform, e.username), e])));
}

export async function removePending(platform: string, username: string): Promise<void> {
  await chrome.storage.local.remove(pendingKey(platform, username));
}

export async function allPending(): Promise<PendingAccount[]> {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PENDING_PREFIX))
    .map(([, v]) => v as PendingAccount);
}

export async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(got[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...(await getSettings()), ...patch } });
}

/** Calls back when the account list or the settings change in any tab or in the popup. */
export function onStorageChange(cb: () => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes).some((k) => k === SETTINGS_KEY || k.startsWith(ACCOUNT_PREFIX) || k.startsWith(PENDING_PREFIX))) cb();
  });
}

/** Timestamps of recent API requests, for the hourly budget. */
export function budgetStore(platform: string): { load(): Promise<number[]>; save(ts: number[]): Promise<void> } {
  const key = `apiLog:${platform}`;
  return {
    async load() {
      const got = await chrome.storage.local.get(key);
      return Array.isArray(got[key]) ? (got[key] as number[]) : [];
    },
    async save(ts) {
      await chrome.storage.local.set({ [key]: ts });
    },
  };
}
