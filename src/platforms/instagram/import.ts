import { scanForAccounts, type ScanCandidate } from '../../core/import-scan';
import { n, t } from '../../core/i18n';
import { adoptPending, getAccount, putAccount } from '../../core/records';
import { isAbortError } from '../../core/types';
import { h } from '../../ui/dom';
import { surface } from '../../ui/host';
import { CONFIG, PLATFORM, describeError, ensurePermission, handles, pickDirectory } from './env';

interface Row {
  candidate: ScanCandidate;
  relPath: string;
  /** Already has a summary and a folder handle. */
  managed: boolean;
  /** The same account id was found in more than one folder. */
  duplicate: boolean;
  checkbox: HTMLInputElement;
}

async function buildRows(parent: FileSystemDirectoryHandle, candidates: ScanCandidate[]): Promise<Row[]> {
  const perOwner = new Map<string, ScanCandidate[]>();
  for (const c of candidates) perOwner.set(c.ownerId, [...(perOwner.get(c.ownerId) ?? []), c]);

  const rows: Row[] = [];
  for (const c of candidates) {
    const group = perOwner.get(c.ownerId)!;
    const largest = group.reduce((a, b) => (b.fileCount > a.fileCount ? b : a));
    const managed = (await getAccount(PLATFORM, c.ownerId)) !== null && (await handles.getAccount(c.ownerId)) !== null;
    const checkbox = h('input', { attrs: { type: 'checkbox' } });
    // One folder per account: of several folders with the same id, preselect the one with the most files.
    checkbox.checked = !managed && c === largest;
    rows.push({ candidate: c, relPath: [parent.name, ...c.path].join('/'), managed, duplicate: group.length > 1, checkbox });
  }
  for (const row of rows) {
    row.checkbox.addEventListener('change', () => {
      if (!row.checkbox.checked) return;
      for (const other of rows) {
        if (other !== row && other.candidate.ownerId === row.candidate.ownerId) other.checkbox.checked = false;
      }
    });
  }
  return rows;
}

function table(rows: Row[]): HTMLElement {
  const body = h('tbody');
  for (const row of rows) {
    const c = row.candidate;
    const flags: string[] = [];
    if (row.managed) flags.push(t('importFlagManaged'));
    if (row.duplicate) flags.push(t('importFlagDuplicate'));
    if (c.otherOwners > 0) flags.push(t('importFlagOthers', n(c.otherOwners)));
    body.append(
      h(
        'tr',
        {},
        h('td', {}, row.checkbox),
        h('td', {}, h('div', { text: `@${c.username}` }), h('div', { class: 'sub', text: c.ownerId })),
        h('td', {}, h('div', { text: row.relPath }), flags.length ? h('div', { class: 'flag', text: flags.join('\n') }) : null),
        h('td', { class: 'num', text: n(c.fileCount) }),
      ),
    );
  }
  return h(
    'table',
    {},
    h('thead', {}, h('tr', {}, h('th'), h('th', { text: t('importColAccount') }), h('th', { text: t('importColFolder') }), h('th', { class: 'num', text: t('importColFiles') }))),
    body,
  );
}

/**
 * Finds existing download folders below a folder the user picks and registers
 * the confirmed ones as managed accounts. Reads file names only.
 */
export async function runImport(): Promise<void> {
  const go = await surface.dialog({
    title: t('importTitle'),
    message: t('importIntro'),
    buttons: [
      { label: t('cancel'), value: false },
      { label: t('chooseFolder'), value: true, primary: true },
    ],
  });
  if (!go) return;

  try {
    const parent = await pickDirectory('memfolio-import', 'downloads');
    if (!parent || !(await ensurePermission(parent))) return;

    const controller = new AbortController();
    const progress = surface.toast(t('importScanning', 0), 'info', null);
    let scan;
    try {
      scan = await scanForAccounts(parent, {
        signal: controller.signal,
        maxDepth: CONFIG.importMaxDepth,
        maxDirs: CONFIG.importMaxDirs,
        onProgress: (dirs) => progress.update(t('importScanning', n(dirs))),
      });
    } finally {
      progress.close();
    }

    if (scan.candidates.length === 0) {
      surface.toast(t('importNothing', parent.name, n(scan.dirsScanned)), 'warn', null);
      return;
    }

    const rows = await buildRows(parent, scan.candidates);
    const content = h(
      'div',
      {},
      h('p', { text: t('importFound', n(rows.length), n(scan.dirsScanned)) }),
      scan.truncated ? h('p', { text: t('importTruncated', n(CONFIG.importMaxDirs)) }) : null,
      table(rows),
    );
    const confirmed = await surface.dialog({
      title: t('importTitle'),
      content,
      wide: true,
      buttons: [
        { label: t('cancel'), value: false },
        { label: t('importConfirm'), value: true, primary: true },
      ],
    });
    if (!confirmed) return;

    await handles.addParent(parent);
    let imported = 0;
    for (const row of rows) {
      if (!row.checkbox.checked) continue;
      const c = row.candidate;
      const previous = await getAccount(PLATFORM, c.ownerId);
      const pasted = await adoptPending(PLATFORM, c.username, c.ownerId);
      await handles.setAccount(c.ownerId, c.dir);
      await putAccount({
        platform: PLATFORM,
        id: c.ownerId,
        username: c.username,
        folderName: c.dir.name,
        relPath: row.relPath,
        fileCount: c.totalFiles,
        lastRunAt: previous?.lastRunAt ?? null,
        lastStatus: previous && previous.lastStatus !== 'folder-missing' && previous.lastStatus !== 'needs-relink' ? previous.lastStatus : 'imported',
        needsFullScan: previous?.needsFullScan ?? {},
        listed: previous?.listed ?? {},
        addedAt: previous?.addedAt ?? Date.now(),
        ...(previous?.pinned || pasted?.pinned ? { pinned: true } : {}),
      });
      imported += 1;
    }
    surface.toast(t('importDone', n(imported)), 'info', null);
  } catch (e) {
    if (isAbortError(e)) return;
    console.error('[memfolio]', e);
    surface.toast(t('importFailed', describeError(e)), 'error', null);
  }
}
