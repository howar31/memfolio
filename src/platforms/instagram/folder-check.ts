import {
  compareFolders,
  exportCheck,
  exportFileName,
  inspectFolder,
  locateUnder,
  sharesStorage,
  writeTest,
  type CheckSnapshot,
  type FolderReport,
  type Location,
} from '../../core/folder-inspect';
import { n, t } from '../../core/i18n';
import { getAccount } from '../../core/records';
import { isAbortError } from '../../core/types';
import { h } from '../../ui/dom';
import { surface, type DialogButton } from '../../ui/host';
import { PLATFORM, describeError, ensurePermission, handles, pickDirectory } from './env';

/** One run of the check: the results, plus the handles needed for further tests. */
interface Subject {
  dir: FileSystemDirectoryHandle;
  other: FileSystemDirectoryHandle | null;
  snapshot: CheckSnapshot;
}

type Parent = CheckSnapshot['parents'][number];
type Action = 'write' | 'parent' | 'compare' | 'marker' | 'again' | 'export' | 'copy';

const STEP_LABEL = { create: 'checkStepCreate', write: 'checkStepWrite', read: 'checkStepRead', delete: 'checkStepDelete' } as const;

const locate = (parent: FileSystemDirectoryHandle, dir: FileSystemDirectoryHandle): Promise<Location> =>
  locateUnder(parent, dir).catch((): Location => ({ kind: 'outside' }));

async function inspect(dir: FileSystemDirectoryHandle): Promise<Subject> {
  const parents: Parent[] = [];
  const root = await handles.getRoot();
  if (root) parents.push({ name: root.name, role: 'download-root', location: await locate(root, dir) });
  for (const p of await handles.getParents()) parents.push({ name: p.name, role: 'import-parent', location: await locate(p, dir) });

  const accounts: string[] = [];
  for (const id of await handles.accountIds()) {
    const stored = await handles.getAccount(id);
    if (stored && (await stored.isSameEntry(dir))) accounts.push(`@${(await getAccount(PLATFORM, id))?.username ?? id}`);
  }
  return { dir, other: null, snapshot: { report: await inspectFolder(dir), parents, accounts, write: null, comparison: null } };
}

/** The first folder known to contain the picked one; it decides the kind. */
function containing(s: CheckSnapshot): Parent | null {
  return s.parents.find((p) => p.location.kind !== 'outside') ?? null;
}

function kindText(s: CheckSnapshot): string {
  const p = containing(s);
  if (!p) {
    const rejected = [...s.parents].reverse().find((x) => x.role === 'picked');
    return rejected ? `${t('checkParentOutside', rejected.name)}\n${t('checkKindUnknown')}` : t('checkKindUnknown');
  }
  switch (p.location.kind) {
    case 'real':
      return t('checkKindReal', p.name);
    case 'link':
      return t('checkKindLink', p.name, p.location.blockedAt);
    case 'same':
      return t('checkKindSame', p.name);
    default:
      return t('checkKindUnknown');
  }
}

function locationText(s: CheckSnapshot): string {
  const p = containing(s);
  if (!p) return t('checkLocNone');
  if (p.location.kind === 'real' || p.location.kind === 'link') return t('checkLocInside', [p.name, ...p.location.path].join('/'));
  return p.name;
}

function readText(r: FolderReport): string {
  if (r.permission !== 'granted') return t('checkReadNoPerm');
  return r.readable ? t('checkReadOk', n(r.files), n(r.mediaFiles), n(r.folders)) : t('checkReadFail', r.error ?? '?');
}

function comparisonText(c: NonNullable<CheckSnapshot['comparison']>): string {
  const lines: string[] = [];
  if (c.result.sameEntry) lines.push(t('checkCmpSameEntry'));
  else if (c.result.sameListing) lines.push(t('checkCmpSameListing', n(c.result.filesA)));
  else lines.push(t('checkCmpDifferent', n(c.result.filesA), n(c.result.filesB)));
  if (c.marker) lines.push(!c.marker.ok ? t('checkMarkerFail', c.marker.error) : c.marker.shared ? t('checkMarkerShared') : t('checkMarkerSeparate'));
  return lines.join('\n');
}

function render(s: CheckSnapshot): HTMLElement {
  const rows: Array<[string, string]> = [
    [t('checkName'), s.report.name],
    [t('checkLocation'), locationText(s)],
    [t('checkKind'), kindText(s)],
    [t('checkRead'), readText(s.report)],
    [t('checkOwners'), s.report.owners.slice(0, 5).map((o) => t('checkOwnerLine', o.id, n(o.files))).join('\n') || t('checkNone')],
    [t('checkAccounts'), s.accounts.join(', ') || t('checkNone')],
    [t('checkWrite'), !s.write ? t('checkWriteNotRun') : s.write.ok ? t('checkWriteOk') : t('checkWriteFail', t(STEP_LABEL[s.write.step]), s.write.error)],
  ];
  if (s.comparison) rows.push([t('checkCompare', s.comparison.otherName), comparisonText(s.comparison)]);
  const body = h('tbody');
  for (const [label, value] of rows) {
    const cell = h('td', { text: value });
    cell.style.whiteSpace = 'pre-line';
    body.append(h('tr', {}, h('th', { text: label, attrs: { scope: 'row' } }), cell));
  }
  return h('table', {}, body);
}

function buttonsFor(s: CheckSnapshot): DialogButton<Action | null>[] {
  const buttons: DialogButton<Action | null>[] = [
    { label: t('close'), value: null },
    { label: t('checkBtnCopy'), value: 'copy' },
    { label: t('checkBtnExport'), value: 'export' },
  ];
  const c = s.comparison;
  if (c && !c.result.sameEntry && c.result.sameListing && !c.marker) buttons.push({ label: t('checkBtnMarker'), value: 'marker' });
  if (s.report.readable && !s.write) buttons.push({ label: t('checkBtnWrite'), value: 'write' });
  if (!containing(s)) buttons.push({ label: t('checkBtnParent'), value: 'parent' });
  buttons.push({ label: t('checkBtnCompare'), value: 'compare' }, { label: t('checkBtnAgain'), value: 'again', primary: true });
  return buttons;
}

async function pickReadable(id: string): Promise<FileSystemDirectoryHandle | null> {
  const dir = await pickDirectory(id, (await handles.getRoot()) ?? 'downloads');
  return dir && (await ensurePermission(dir)) ? dir : null;
}

function toJson(s: CheckSnapshot, at: Date): string {
  const data = exportCheck(s, { version: chrome.runtime.getManifest().version, userAgent: navigator.userAgent, at });
  return JSON.stringify(data, null, 2) + '\n';
}

/** Saves the results as a JSON file through the browser's download handling. */
function exportJson(s: CheckSnapshot): void {
  const at = new Date();
  const name = exportFileName(at);
  const href = URL.createObjectURL(new Blob([toJson(s, at)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  surface.toast(t('checkExported', name));
}

async function copyJson(s: CheckSnapshot): Promise<void> {
  try {
    await navigator.clipboard.writeText(toJson(s, new Date()));
    surface.toast(t('checkCopied'));
  } catch (e) {
    surface.toast(t('checkCopyFailed', e instanceof Error ? e.name : String(e)), 'warn', null);
  }
}

/**
 * Developer tool. Shows what the browser reports for a folder the user picks:
 * whether it can be read and written, where it sits relative to known folders,
 * and whether it is reached through a link. Read-only unless a test button is
 * pressed. The results can be exported as JSON.
 */
export async function runFolderCheck(): Promise<void> {
  const go = await surface.dialog({
    title: t('checkTitle'),
    message: t('checkIntro'),
    buttons: [
      { label: t('cancel'), value: false },
      { label: t('chooseFolder'), value: true, primary: true },
    ],
  });
  if (!go) return;

  try {
    const first = await pickReadable('memfolio-check');
    if (!first) return;
    let subject = await inspect(first);
    for (;;) {
      const s = subject.snapshot;
      const action = await surface.dialog<Action | null>({ title: t('checkTitle'), content: render(s), wide: true, buttons: buttonsFor(s) });
      if (!action) return;
      if (action === 'export') {
        exportJson(s);
      } else if (action === 'copy') {
        await copyJson(s);
      } else if (action === 'write') {
        s.write = await writeTest(subject.dir);
      } else if (action === 'parent') {
        const parent = await pickReadable('memfolio-check-parent');
        if (parent) s.parents.push({ name: parent.name, role: 'picked', location: await locate(parent, subject.dir) });
      } else if (action === 'compare') {
        const other = await pickReadable('memfolio-check-other');
        if (other) {
          subject.other = other;
          s.comparison = { otherName: other.name, result: await compareFolders(subject.dir, other), marker: null };
        }
      } else if (action === 'marker' && s.comparison && subject.other) {
        s.comparison.marker = await sharesStorage(subject.dir, subject.other);
      } else if (action === 'again') {
        const next = await pickReadable('memfolio-check');
        if (next) subject = await inspect(next);
      }
    }
  } catch (e) {
    if (isAbortError(e)) return;
    console.error('[memfolio]', e);
    surface.toast(t('downloadFailed', describeError(e)), 'error', null);
  }
}
