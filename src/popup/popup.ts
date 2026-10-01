// Read-only list of managed accounts plus the settings. It shows summaries written by the
// content script and opens profile pages; it never touches folders or the platform.

import { initI18n, n, setLanguage, t, uiLanguage, when } from '../core/i18n';
import { IMPORT_MESSAGE, PENDING_TOOL_KEY, type PendingTool } from '../core/messages';
import { allAccounts, getSettings, onStorageChange, removeAccount, setSettings, type AccountRecord, type AccountStatus, type Language, type SingleSave } from '../core/records';
import { profileUrl } from '../platforms/instagram/routes';
import { ICONS, h, icon } from '../ui/dom';

const PROFILE_URL: Record<string, (username: string) => string> = { instagram: profileUrl };
const HOME_URL = 'https://www.instagram.com/';

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

function row(account: AccountRecord): HTMLElement {
  const statusKey = STATUS_TEXT[account.lastStatus];
  const open = h(
    'button',
    {
      class: 'open',
      title: t('popupOpenHint', account.username),
      on: {
        click: () => {
          const url = PROFILE_URL[account.platform]?.(account.username);
          if (url) void chrome.tabs.create({ url });
        },
      },
    },
    h('div', { class: 'name', text: `@${account.username}` }),
    h('div', { class: 'path', text: account.relPath ?? account.folderName, title: account.relPath ? t('popupRelative') : undefined }),
    statusKey ? h('div', { class: `status ${ERROR_STATUS.has(account.lastStatus) ? 'error' : ''}`, text: t(statusKey) }) : null,
  );
  const side = h(
    'div',
    { class: 'side' },
    h('div', { class: 'files', text: t('popupFiles', n(account.fileCount)) }),
    h('div', { text: account.lastRunAt ? when(account.lastRunAt) : t('popupNeverRun') }),
  );
  const remove = h('button', { class: 'remove', title: t('popupRemove'), attrs: { 'aria-label': t('popupRemove') } }, icon([...ICONS.close], 14));
  remove.addEventListener('click', () => {
    if (remove.classList.contains('confirm')) {
      void removeAccount(account.platform, account.id);
      return;
    }
    // Two clicks: the first one only asks.
    remove.classList.add('confirm');
    remove.textContent = t('popupRemoveConfirm');
    setTimeout(() => {
      remove.classList.remove('confirm');
      remove.replaceChildren(icon([...ICONS.close], 14));
    }, 4000);
  });
  return h('div', { class: 'row' }, open, side, remove);
}

async function render(): Promise<void> {
  const accounts = (await allAccounts()).sort((a, b) => a.username.localeCompare(b.username));
  const needle = filter.value.trim().toLowerCase();
  const shown = needle
    ? accounts.filter((a) => a.username.toLowerCase().includes(needle) || (a.relPath ?? a.folderName).toLowerCase().includes(needle))
    : accounts;
  count.textContent = accounts.length > 0 ? t('popupCount', n(accounts.length)) : '';
  filter.hidden = accounts.length === 0;
  if (shown.length === 0) {
    list.replaceChildren(h('div', { class: 'empty', text: accounts.length === 0 ? t('popupEmpty') : t('popupNoMatch') }));
  } else {
    list.replaceChildren(...shown.map(row));
  }
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
  text('import-name', t('popupImport'));
  text('import-hint', t('popupImportHint'));
  text('import', t('popupImportStart'));
  text('settings-title', t('optionsTitle'));
  text('developer-mode-name', t('optDevMode'));
  text('developer-mode-hint', t('optDevModeHint'));
  text('language-name', t('optLanguage'));
  text('language-hint', t('optLanguageHint'));
  text('language-auto', t('optLanguageAuto'));
  text('single-save-name', t('optSingleSave'));
  text('single-save-hint', t('optSingleSaveHint'));
  text('single-save-browser', t('optSingleSaveBrowser'));
  text('single-save-folder', t('optSingleSaveFolder'));
}

/** The popup shows either the account list or the settings. */
function showSettings(on: boolean): void {
  document.getElementById('accounts')!.hidden = on;
  document.getElementById('settings')!.hidden = !on;
  document.getElementById('options')!.hidden = on;
  document.getElementById('back')!.hidden = !on;
  count.hidden = on;
}

/** Settings are stored the moment they change: a popup closes as soon as it loses focus. */
async function initSettings(): Promise<void> {
  const settings = await getSettings();
  const saved = document.getElementById('saved')!;

  const developerMode = document.getElementById('developer-mode') as HTMLInputElement;
  developerMode.checked = settings.developerMode;
  developerMode.addEventListener('change', async () => {
    await setSettings({ developerMode: developerMode.checked });
    saved.textContent = t('optSaved');
  });

  const language = document.getElementById('language') as HTMLSelectElement;
  language.value = settings.language;
  language.addEventListener('change', async () => {
    const value = language.value as Language;
    await setSettings({ language: value });
    setLanguage(value);
    renderText();
    saved.textContent = t('optSaved');
    await render();
  });

  const singleSave = document.getElementById('single-save') as HTMLSelectElement;
  singleSave.value = settings.singleSave;
  singleSave.addEventListener('change', async () => {
    await setSettings({ singleSave: singleSave.value as SingleSave });
    saved.textContent = t('optSaved');
  });

  document.getElementById('options')!.addEventListener('click', () => {
    saved.textContent = '';
    showSettings(true);
  });
  document.getElementById('back')!.addEventListener('click', () => showSettings(false));
}

async function main(): Promise<void> {
  await initI18n();
  renderText();
  filter.addEventListener('input', () => void render());
  document.getElementById('import')!.addEventListener('click', () => void openImport());
  await initSettings();

  onStorageChange(() => void render());
  await render();
}

void main();
