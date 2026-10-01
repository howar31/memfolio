// The two text views of the popup: adding accounts from pasted profile addresses
// and handing the list out in the same form.

import { n, t } from '../core/i18n';
import { addGroup, assign, exportText, pendingKey } from '../core/layout';
import { putPending, setLayout, type PendingAccount } from '../core/records';
import { profileNamesIn } from '../platforms/instagram/routes';
import { newGroupId } from './list';
import { PASTE_PLATFORM, PROFILE_URL, loadList, show, text } from './shared';

const box = (id: string): HTMLTextAreaElement => document.getElementById(id) as HTMLTextAreaElement;

/**
 * Adds the accounts named by the pasted addresses, into the groups their
 * headings name. Entries already listed are left as they are; lines that are
 * neither an address nor a heading stay in the box.
 */
async function addPasted(): Promise<void> {
  const input = box('addresses');
  if (input.value.trim() === '') return;
  const { entries, groups, rejected } = profileNamesIn(input.value);
  const list = await loadList();
  const listed = new Set(list.entries.filter((e) => e.platform === PASTE_PLATFORM).map((e) => e.name.toLowerCase()));
  const fresh = entries.filter((e) => !listed.has(e.username));

  let layout = list.layout;
  for (const name of groups) if (!layout.groups.some((g) => g.name === name)) layout = addGroup(layout, newGroupId(), name);
  for (const entry of fresh) {
    const key = pendingKey(PASTE_PLATFORM, entry.username);
    const group = layout.groups.find((g) => g.name === entry.group);
    if (group) layout = assign(layout, key, group.id);
    // In manual order new entries follow each other the way they were pasted.
    if (layout.sort.by === 'manual') layout = { ...layout, order: [...layout.order.filter((k) => k !== key), key] };
  }
  if (layout !== list.layout) await setLayout(layout);
  await putPending(
    fresh.map((e): PendingAccount => ({ platform: PASTE_PLATFORM, username: e.username, addedAt: Date.now(), ...(e.pinned ? { pinned: true } : {}) })),
  );
  input.value = rejected.join('\n');
  text('add-result', t('popupAddResult', n(fresh.length), n(entries.length - fresh.length), n(rejected.length)));
}

/** One profile address per entry under the heading of its block, in the order of the list, whatever the filter shows. */
async function openExport(): Promise<void> {
  const { blocks } = await loadList();
  box('exported').value = exportText(blocks, (entry) => PROFILE_URL[entry.platform]?.(entry.name) ?? '');
  text('export-result', '');
  show('exporting');
}

async function copyExport(): Promise<void> {
  try {
    await navigator.clipboard.writeText(box('exported').value);
    text('export-result', t('checkCopied'));
  } catch (e) {
    text('export-result', t('popupExportCopyFailed', e instanceof Error ? e.name : String(e)));
  }
}

/** Saves the addresses as a text file through the browser's download handling. */
function saveExport(): void {
  const at = new Date();
  const two = (v: number): string => String(v).padStart(2, '0');
  const name = `memfolio-accounts-${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}${two(at.getSeconds())}.txt`;
  const href = URL.createObjectURL(new Blob([box('exported').value + '\n'], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  text('export-result', t('popupExportSaved', name));
}

export function initTransfer(): void {
  document.getElementById('add')!.addEventListener('click', () => {
    text('add-result', '');
    show('adding');
    box('addresses').focus();
  });
  document.getElementById('add-go')!.addEventListener('click', () => void addPasted());
  document.getElementById('export')!.addEventListener('click', () => void openExport());
  document.getElementById('export-copy')!.addEventListener('click', () => void copyExport());
  document.getElementById('export-save')!.addEventListener('click', saveExport);
}
