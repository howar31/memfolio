// List of managed accounts plus the settings. It shows summaries written by the content
// script, takes pasted profile addresses and opens profile pages; it never touches folders
// or the platform.

import { initI18n, n, setLanguage, setTimeFormat, t, uiLanguage, when } from '../core/i18n';
import { IMPORT_MESSAGE, PENDING_TOOL_KEY, type PendingTool } from '../core/messages';
import { allAccounts, allPending, getSettings, onStorageChange, putAccount, putPending, removeAccount, removePending, setSettings, type AccountRecord, type AccountStatus, type Language, type PendingAccount, type SingleSave, type TimeFormat } from '../core/records';
import { profileNamesIn, profileUrl } from '../platforms/instagram/routes';
import { ICONS, h, icon } from '../ui/dom';

const PROFILE_URL: Record<string, (username: string) => string> = { instagram: profileUrl };
const HOME_URL = 'https://www.instagram.com/';
/** Pasted addresses are read as addresses of this platform. */
const PASTE_PLATFORM = 'instagram';

const STATUS_TEXT: Partial<Record<AccountStatus, Parameters<typeof t>[0]>> = {
  imported: 'statusImported',
  partial: 'statusPartial',
  stopped: 'statusStopped',
  cancelled: 'statusCancelled',
  'folder-missing': 'statusFolderMissing',
  'needs-relink': 'statusNeedsRelink',
};
const ERROR_STATUS = new Set<AccountStatus>(['folder-missing', 'needs-relink']);

const list = document.getElementById('list')!;
const filter = document.getElementById('filter') as HTMLInputElement;
const count = document.getElementById('count')!;

/** An account with a record, or one known by its address only. */
type Entry = { account: AccountRecord } | { pending: PendingAccount };

function row(entry: Entry): HTMLElement {
  const account = 'account' in entry ? entry.account : null;
  const { platform, username } = 'account' in entry ? entry.account : entry.pending;
  const statusKey = account ? STATUS_TEXT[account.lastStatus] : undefined;
  const open = h(
    'button',
    {
      class: 'open',
      title: t('popupOpenHint', username),
      on: {
        click: () => {
          const url = PROFILE_URL[platform]?.(username);
          if (url) void chrome.tabs.create({ url });
        },
      },
    },
    h('div', { class: 'name', text: `@${username}` }),
    account
      ? h('div', { class: 'path', text: account.relPath ?? account.folderName, title: account.relPath ? t('popupRelative') : undefined })
      : h('div', { class: 'path', text: t('popupNeverRun') }),
    account && statusKey ? h('div', { class: `status ${ERROR_STATUS.has(account.lastStatus) ? 'error' : ''}`, text: t(statusKey) }) : null,
  );
  const side = account
    ? h(
        'div',
        { class: 'side' },
        h('div', { class: 'files', text: t('popupFiles', n(account.fileCount)) }),
        h('div', { text: account.lastRunAt ? when(account.lastRunAt) : t('popupNeverRun') }),
      )
    : h('div', { class: 'side' });
  const pinned = pinnedOf(entry);
  if (pinned) {
    const mark = h('span', { class: 'pinmark', title: t('popupPinned'), attrs: { role: 'img', 'aria-label': t('popupPinned') } }, icon([...ICONS.pin], 12));
    open.querySelector('.name')!.append(mark);
  }
  const more = h('button', { class: 'more', title: t('popupMore'), attrs: { 'aria-label': t('popupMore'), 'aria-expanded': 'false' } }, icon([...ICONS.chevronDown], 16));
  const setPinned = (): void =>
    void ('account' in entry
      ? putAccount({ ...entry.account, pinned: !pinned })
      : putPending([{ ...entry.pending, pinned: !pinned }]));
  const drop = (): void => void (account ? removeAccount(platform, account.id) : removePending(platform, username));
  const remove = h('button', { class: 'btn remove', text: t('popupRemoveYes') });
  // The actions unfold on a line of their own under the entry; removing asks first on that line.
  const acts = h('div', { class: 'acts' }, h('button', { class: 'btn pin', text: t(pinned ? 'popupUnpin' : 'popupPin'), on: { click: setPinned } }), remove);
  const cancel = h('button', { class: 'btn', text: t('cancel') });
  const confirm = h(
    'div',
    { class: 'confirm', attrs: { role: 'alert' } },
    h('span', { text: account ? t('popupRemoveConfirm') : t('popupRemovePending') }),
    cancel,
    h('button', { class: 'btn danger', text: t('popupRemoveYes'), on: { click: drop } }),
  );
  confirm.hidden = true;
  const extra = h('div', { class: 'extra' }, acts, confirm);
  extra.hidden = true;
  const el = h('div', { class: 'row' }, open, side, more, extra);
  const ask = (on: boolean): void => {
    confirm.hidden = !on;
    acts.hidden = on;
    (on ? cancel : remove).focus();
  };
  more.addEventListener('click', () => {
    const on = extra.hidden;
    extra.hidden = !on;
    el.classList.toggle('unfolded', on);
    more.setAttribute('aria-expanded', String(on));
    confirm.hidden = true;
    acts.hidden = false;
  });
  remove.addEventListener('click', () => ask(true));
  cancel.addEventListener('click', () => ask(false));
  return el;
}

const nameOf = (entry: Entry): string => ('account' in entry ? entry.account.username : entry.pending.username);
const pinnedOf = (entry: Entry): boolean => ('account' in entry ? entry.account.pinned : entry.pending.pinned) === true;
const folderOf = (entry: Entry): string => ('account' in entry ? (entry.account.relPath ?? entry.account.folderName) : '');
const sameAccount = (platform: string, username: string) => (a: AccountRecord): boolean =>
  a.platform === platform && a.username.toLowerCase() === username.toLowerCase();

/** Managed accounts, then the pasted ones that have no record of the same name. */
async function entries(): Promise<Entry[]> {
  const accounts = await allAccounts();
  const pending = (await allPending()).filter((p) => !accounts.some(sameAccount(p.platform, p.username)));
  return [...accounts.map((account) => ({ account })), ...pending.map((p) => ({ pending: p }))];
}

async function render(): Promise<void> {
  const all = (await entries()).sort((a, b) => Number(pinnedOf(b)) - Number(pinnedOf(a)) || nameOf(a).localeCompare(nameOf(b)));
  const needle = filter.value.trim().toLowerCase();
  const shown = needle ? all.filter((e) => nameOf(e).toLowerCase().includes(needle) || folderOf(e).toLowerCase().includes(needle)) : all;
  count.textContent = all.length > 0 ? t('popupCount', n(all.length)) : t('popupTitle');
  filter.hidden = all.length === 0;
  if (shown.length === 0) {
    list.replaceChildren(h('div', { class: 'empty', text: all.length === 0 ? t('popupEmpty') : t('popupNoMatch') }));
  } else {
    list.replaceChildren(...shown.map(row));
  }
}

/** Adds the accounts named by the pasted addresses; lines that name none stay in the box. */
async function addPasted(): Promise<void> {
  const box = document.getElementById('addresses') as HTMLTextAreaElement;
  if (box.value.trim() === '') return;
  const { usernames, rejected } = profileNamesIn(box.value);
  const accounts = await allAccounts();
  const listed = new Set((await allPending()).filter((p) => p.platform === PASTE_PLATFORM).map((p) => p.username));
  const fresh = usernames.filter((u) => !listed.has(u) && !accounts.some(sameAccount(PASTE_PLATFORM, u)));
  await putPending(fresh.map((username) => ({ platform: PASTE_PLATFORM, username, addedAt: Date.now() })));
  box.value = rejected.join('\n');
  text('add-result', t('popupAddResult', n(fresh.length), n(usernames.length - fresh.length), n(rejected.length)));
}

/** Asks a platform tab to open the folder import; folder handles live there, not in the popup. */
async function openImport(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    if (tab?.id === undefined) throw new Error('no active tab');
    // Succeeds only when the active tab runs the content script.
    await chrome.tabs.sendMessage(tab.id, { type: IMPORT_MESSAGE });
  } catch {
    // No such tab: leave the request for the content script of a new one.
    const pending: PendingTool = { tool: 'import', at: Date.now() };
    await chrome.storage.local.set({ [PENDING_TOOL_KEY]: pending });
    await chrome.tabs.create({ url: HOME_URL });
  }
  window.close();
}

const text = (id: string, value: string): void => {
  document.getElementById(id)!.textContent = value;
};

/** An icon-only button: the name goes into the tooltip and the accessible label. */
const label = (id: string, paths: readonly string[], name: string): void => {
  const el = document.getElementById(id)!;
  el.replaceChildren(icon([...paths], 18));
  el.title = name;
  el.setAttribute('aria-label', name);
};

/** Every fixed label; drawn again when the language changes. */
function renderText(): void {
  document.documentElement.lang = uiLanguage();
  filter.placeholder = t('popupSearch');
  filter.setAttribute('aria-label', t('popupSearch'));
  label('options', ICONS.settings, t('popupOptions'));
  label('back', ICONS.back, t('popupBack'));
  label('add', ICONS.plus, t('popupAdd'));
  text('adding-title', t('popupAddTitle'));
  text('adding-hint', t('popupAddHint'));
  text('add-go', t('popupAddGo'));
  (document.getElementById('addresses') as HTMLTextAreaElement).setAttribute('aria-label', t('popupAddHint'));
  text('import-name', t('popupImport'));
  text('import-hint', t('popupImportHint'));
  text('import', t('popupImportStart'));
  text('settings-title', t('optionsTitle'));
  text('thanks-name', t('sponsorTitle'));
  text('thanks-hint', t('sponsorHint'));
  const link = document.getElementById('page-link')!;
  const heart = icon([...ICONS.heart], 15);
  heart.setAttribute('stroke-width', '1.8');
  link.replaceChildren(heart, t('sponsorAction'));
  text('group-general', t('optGroupGeneral'));
  text('group-folders', t('optGroupFolders'));
  text('group-advanced', t('optGroupAdvanced'));
  text('developer-mode-name', t('optDevMode'));
  text('developer-mode-hint', t('optDevModeHint'));
  text('language-name', t('optLanguage'));
  text('language-auto', t('optLanguageAuto'));
  text('time-format-name', t('optTimeFormat'));
  text('time-format-24', t('optTimeFormat24'));
  text('time-format-12', t('optTimeFormat12'));
  text('single-save-name', t('optSingleSave'));
  text('single-save-hint', t('optSingleSaveHint'));
  text('single-save-browser', t('optSingleSaveBrowser'));
  text('single-save-folder', t('optSingleSaveFolder'));
}

/** The version comes from the manifest, so the band always names the build that is loaded. */
function renderVersion(): void {
  text('version', `v${chrome.runtime.getManifest().version}`);
}

type View = 'accounts' | 'adding' | 'settings';

/** The popup shows one view at a time; the account list is the one to go back to. */
function show(view: View): void {
  for (const id of ['accounts', 'adding', 'settings']) document.getElementById(id)!.hidden = id !== view;
  document.getElementById('options')!.hidden = view !== 'accounts';
  document.getElementById('back')!.hidden = view === 'accounts';
}

/** Settings are stored the moment they change: a popup closes as soon as it loses focus. */
async function initSettings(): Promise<void> {
  const settings = await getSettings();
  const saved = document.getElementById('saved')!;
  let savedTimer: ReturnType<typeof setTimeout> | undefined;
  // The note appears beside the title and goes away by itself.
  const showSaved = (): void => {
    saved.textContent = t('optSaved');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (saved.textContent = ''), 4000);
  };

  const developerMode = document.getElementById('developer-mode') as HTMLInputElement;
  developerMode.checked = settings.developerMode;
  developerMode.addEventListener('change', async () => {
    await setSettings({ developerMode: developerMode.checked });
    showSaved();
  });

  const language = document.getElementById('language') as HTMLSelectElement;
  language.value = settings.language;
  language.addEventListener('change', async () => {
    const value = language.value as Language;
    await setSettings({ language: value });
    setLanguage(value);
    renderText();
    showSaved();
    await render();
  });

  const timeFormat = document.getElementById('time-format') as HTMLSelectElement;
  timeFormat.value = settings.timeFormat;
  timeFormat.addEventListener('change', async () => {
    const value = timeFormat.value as TimeFormat;
    await setSettings({ timeFormat: value });
    setTimeFormat(value);
    showSaved();
    await render();
  });

  const singleSave = document.getElementById('single-save') as HTMLSelectElement;
  singleSave.value = settings.singleSave;
  singleSave.addEventListener('change', async () => {
    await setSettings({ singleSave: singleSave.value as SingleSave });
    showSaved();
  });

  document.getElementById('options')!.addEventListener('click', () => {
    saved.textContent = '';
    show('settings');
  });
  document.getElementById('back')!.addEventListener('click', () => show('accounts'));
}

async function main(): Promise<void> {
  await initI18n();
  renderText();
  renderVersion();
  filter.addEventListener('input', () => void render());
  document.getElementById('import')!.addEventListener('click', () => void openImport());
  document.getElementById('add')!.addEventListener('click', () => {
    text('add-result', '');
    show('adding');
    document.getElementById('addresses')!.focus();
  });
  document.getElementById('add-go')!.addEventListener('click', () => void addPasted());
  await initSettings();

  onStorageChange(() => void render());
  await render();
}

void main();
