// Entry point of the popup: the fixed labels, the settings and the switch between
// views. The account list is in `list.ts`, the two text views in `transfer.ts`.
// The popup never touches folders or the platform.

import { initI18n, setLanguage, setTimeFormat, t, uiLanguage } from '../core/i18n';
import { IMPORT_MESSAGE, PENDING_TOOL_KEY, type PendingTool } from '../core/messages';
import { getSettings, onStorageChange, setSettings, type Language, type SingleSave, type TimeFormat } from '../core/records';
import { ICONS, icon } from '../ui/dom';
import { initList, render } from './list';
import { HOME_URL, label, show, text } from './shared';
import { initTransfer } from './transfer';

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

/** Every fixed label; drawn again when the language changes. */
function renderText(): void {
  document.documentElement.lang = uiLanguage();
  const filter = document.getElementById('filter') as HTMLInputElement;
  filter.placeholder = t('popupSearch');
  filter.setAttribute('aria-label', t('popupSearch'));
  label('new-group', ICONS.folderPlus, t('popupNewGroup'));
  document.getElementById('sort-by')!.setAttribute('aria-label', t('popupSort'));
  text('sort-name', t('popupSortName'));
  text('sort-last-run', t('popupSortLastRun'));
  text('sort-files', t('popupSortFiles'));
  text('sort-added', t('popupSortAdded'));
  text('sort-manual', t('popupSortManual'));
  label('options', ICONS.settings, t('popupOptions'));
  label('back', ICONS.back, t('popupBack'));
  label('transfer', ICONS.transfer, t('popupTransfer'));
  text('transferring-title', t('popupTransferTitle'));
  text('tab-add', t('popupTabAdd'));
  text('tab-export', t('popupTabExport'));
  text('exporting-hint', t('popupExportHint'));
  text('export-copy', t('popupExportCopy'));
  text('export-save', t('popupExportSave'));
  (document.getElementById('exported') as HTMLTextAreaElement).setAttribute('aria-label', t('popupTabExport'));
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
  document.getElementById('import')!.addEventListener('click', () => void openImport());
  initList();
  initTransfer();
  await initSettings();

  onStorageChange(() => void render());
  await render();
}

void main();
