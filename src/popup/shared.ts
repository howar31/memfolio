// What the popup's parts have in common: the entries of the list, the switch
// between views and two small text helpers.

import { accountKey, arrange, pendingKey, type Block, type Item, type Layout } from '../core/layout';
import { allAccounts, allPending, getLayout, type AccountRecord, type PendingAccount } from '../core/records';
import { profileUrl } from '../platforms/instagram/routes';
import { icon } from '../ui/dom';

export const PROFILE_URL: Record<string, (username: string) => string> = { instagram: profileUrl };
export const HOME_URL = 'https://www.instagram.com/';
/** Pasted addresses are read as addresses of this platform. */
export const PASTE_PLATFORM = 'instagram';

/** One entry of the list: an account with a record, or one known by its address only. */
export interface Entry extends Item {
  platform: string;
  account: AccountRecord | null;
  pending: PendingAccount | null;
}

/** Managed accounts, then the pasted ones that have no record of the same name. */
export async function loadEntries(): Promise<Entry[]> {
  const accounts = await allAccounts();
  const taken = new Set(accounts.map((a) => `${a.platform}:${a.username.toLowerCase()}`));
  const pending = (await allPending()).filter((p) => !taken.has(`${p.platform}:${p.username.toLowerCase()}`));
  return [
    ...accounts.map((a): Entry => ({
      key: accountKey(a.platform, a.id),
      name: a.username,
      pinned: a.pinned === true,
      lastRunAt: a.lastRunAt,
      fileCount: a.fileCount,
      addedAt: a.addedAt,
      platform: a.platform,
      account: a,
      pending: null,
    })),
    ...pending.map((p): Entry => ({
      key: pendingKey(p.platform, p.username),
      name: p.username,
      pinned: p.pinned === true,
      lastRunAt: null,
      fileCount: 0,
      addedAt: p.addedAt,
      platform: p.platform,
      account: null,
      pending: p,
    })),
  ];
}

/** The whole list as it is laid out, whatever the filter shows. The export follows it. */
export async function loadList(): Promise<{ entries: Entry[]; layout: Layout; blocks: Block<Entry>[] }> {
  const [entries, layout] = [await loadEntries(), await getLayout()];
  return { entries, layout, blocks: arrange(entries, layout) };
}

export const text = (id: string, value: string): void => {
  document.getElementById(id)!.textContent = value;
};

/** An icon-only button: the name goes into the tooltip and the accessible label. */
export const label = (id: string, paths: readonly string[], name: string): void => {
  const el = document.getElementById(id)!;
  el.replaceChildren(icon([...paths], 18));
  el.title = name;
  el.setAttribute('aria-label', name);
};

export type View = 'accounts' | 'transferring' | 'settings';

/** The popup shows one view at a time; the account list is the one to go back to. */
export function show(view: View): void {
  for (const id of ['accounts', 'transferring', 'settings']) document.getElementById(id)!.hidden = id !== view;
  document.getElementById('options')!.hidden = view !== 'accounts';
  document.getElementById('back')!.hidden = view === 'accounts';
}
