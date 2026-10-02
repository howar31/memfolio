// The account list of the popup: blocks (pinned, groups, the rest), the entries
// with their fold-out actions, the sort controls and dragging.

import { n, t, when, type MessageKey } from '../core/i18n';
import {
  addGroup,
  assign,
  freeName,
  moveGroup,
  nameTaken,
  PINNED,
  prune,
  removeGroup,
  renameGroup,
  reorder,
  setCollapsed,
  setSort,
  toggleDirection,
  UNGROUPED,
  type Block,
  type Layout,
  type SortBy,
} from '../core/layout';
import { getAccount, getPending, putAccount, putPending, removeAccount, removePending, setLayout, type AccountStatus } from '../core/records';
import { ICONS, folderLine, h, icon } from '../ui/dom';
import { PROFILE_URL, loadList, type Entry } from './shared';

const STATUS_TEXT: Partial<Record<AccountStatus, MessageKey>> = {
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
const sortBy = document.getElementById('sort-by') as HTMLSelectElement;
const sortDir = document.getElementById('sort-dir') as HTMLButtonElement;

/** The group whose name box is open, and what was typed into it so far. */
let naming: string | null = null;
let namingDraft: string | null = null;
/** A group being made: it is shown with its name box open and stored only when the name is saved. `entry` joins it then. */
let drafting: { id: string; entry: string | null } | null = null;
/** The entry whose actions open again after the next drawing, with the button that takes the focus. */
let reopen: { key: string; button: string } | null = null;
/** A drag is under way; the list is not redrawn under it. */
let dragging = false;
let redrawAfterDrag = false;
/** Counts the drawings, so that one overtaken while it was reading does not draw. */
let turn = 0;

export function newGroupId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Applies a change to the stored layout and draws the list again. Keys of entries
 * that are gone are dropped on the way. An open name box closes, and a group
 * that was being made is given up.
 */
async function change(fn: (layout: Layout, entries: Entry[]) => Layout): Promise<void> {
  naming = null;
  namingDraft = null;
  drafting = null;
  const { entries, layout } = await loadList();
  const next = prune(fn(layout, entries), new Set(entries.map((e) => e.key)));
  // A stored change comes back as a storage event, which draws the list; without one it is drawn here.
  if (JSON.stringify(next) === JSON.stringify(layout)) await render();
  else await setLayout(next);
}

/** Shows a group that does not exist yet, with its name box open. */
function draftGroup(entry: string | null): void {
  drafting = { id: newGroupId(), entry };
  naming = drafting.id;
  namingDraft = null;
  void render();
}

/** Pins or unpins an entry. The record is read again first: a run may have rewritten it since the list was drawn. */
async function setPinned(entry: Entry, pinned: boolean): Promise<void> {
  if (entry.account) {
    const now = await getAccount(entry.platform, entry.account.id);
    if (now) await putAccount({ ...now, pinned });
  } else {
    const now = await getPending(entry.platform, entry.name);
    if (now) await putPending([{ ...now, pinned }]);
  }
}

/** A line that unfolds under an entry or a heading, with the button that unfolds it. */
function foldOut(owner: () => HTMLElement, extra: HTMLElement, onOpen: () => void): HTMLButtonElement {
  const more = h('button', { class: 'more', title: t('popupMore'), attrs: { 'aria-label': t('popupMore'), 'aria-expanded': 'false' } }, icon([...ICONS.chevronDown], 16));
  extra.hidden = true;
  more.addEventListener('click', () => {
    const on = extra.hidden;
    extra.hidden = !on;
    owner().classList.toggle('unfolded', on);
    more.setAttribute('aria-expanded', String(on));
    if (on) onOpen();
  });
  return more;
}

interface Drawn {
  layout: Layout;
  /** The list is narrowed by the filter: nothing is rearranged. */
  narrowed: boolean;
}

function row(entry: Entry, block: Block<Entry>, drawn: Drawn): HTMLElement {
  const { account, platform, name: username } = entry;
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
      ? folderLine(account.relPath ? account.relPath.split('/') : [account.folderName], t('pathAbove'))
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

  const pin = h('button', { class: 'btn pin', text: t(entry.pinned ? 'popupUnpin' : 'popupPin'), on: { click: () => void setPinned(entry, !entry.pinned) } });

  // Where the entry belongs: any group, the rest, or a group made for it.
  const current = drawn.layout.groupOf[entry.key] ?? '';
  const moveto = h(
    'select',
    { class: 'moveto', attrs: { 'aria-label': t('popupMoveTo') } },
    h('option', { text: t('popupMoveTo'), attrs: { value: '?', disabled: '', hidden: '' } }),
    ...drawn.layout.groups.map((g) => h('option', { text: g.name, attrs: { value: g.id, ...(g.id === current ? { disabled: '' } : {}) } })),
    h('option', { text: t('popupBlockUngrouped'), attrs: { value: '', ...(current === '' ? { disabled: '' } : {}) } }),
    h('option', { text: t('popupMoveNew'), attrs: { value: '+' } }),
  );
  moveto.value = '?';
  moveto.addEventListener('change', () => {
    const value = moveto.value;
    if (value === '+') return draftGroup(entry.key);
    void change((layout, entries) => {
      const grouped = assign(layout, entry.key, value === '' ? null : value);
      return grouped.sort.by === 'manual' ? reorder(grouped, entries, entry.key, null, true) : grouped;
    });
  });

  // Manual order can be set without dragging.
  const at = block.items.indexOf(entry);
  const step = (className: string, name: MessageKey, to: number): HTMLButtonElement => {
    const neighbour = block.items[to];
    const button = h('button', { class: `btn ${className}`, text: t(name) });
    button.disabled = !neighbour;
    if (neighbour) {
      button.addEventListener('click', () => {
        // The list is drawn anew; the actions of this entry open again so that it can be moved on.
        reopen = { key: entry.key, button: className };
        void change((layout, entries) => reorder(layout, entries, entry.key, neighbour.key, to > at));
      });
    }
    return button;
  };
  const steps = drawn.layout.sort.by === 'manual' && !drawn.narrowed ? [step('up', 'popupMoveUp', at - 1), step('down', 'popupMoveDown', at + 1)] : [];

  const remove = h('button', { class: 'btn remove', text: t('popupRemoveYes') });
  const acts = h('div', { class: 'acts' }, pin, moveto, ...steps, remove);
  const cancel = h('button', { class: 'btn', text: t('cancel') });
  const drop = (): void => void (account ? removeAccount(platform, account.id) : removePending(platform, username));
  // Removing asks first, on the line the actions were on.
  const confirm = h(
    'div',
    { class: 'confirm', attrs: { role: 'alert' } },
    h('span', { text: account ? t('popupRemoveConfirm') : t('popupRemovePending') }),
    cancel,
    h('button', { class: 'btn danger', text: t('popupRemoveYes'), on: { click: drop } }),
  );
  confirm.hidden = true;
  const ask = (on: boolean): void => {
    confirm.hidden = !on;
    acts.hidden = on;
    (on ? cancel : remove).focus();
  };
  remove.addEventListener('click', () => ask(true));
  cancel.addEventListener('click', () => ask(false));

  const extra = h('div', { class: 'extra' }, acts, confirm);
  const el: HTMLElement = h('div', { class: 'row', attrs: { 'data-key': entry.key, 'data-name': username } });
  const more = foldOut(() => el, extra, () => {
    confirm.hidden = true;
    acts.hidden = false;
  });
  el.append(open, side, more, extra);
  if (reopen?.key === entry.key) {
    const wanted = reopen.button;
    reopen = null;
    more.click();
    // Once on the page: the focus goes to the button that was pressed, or to its counterpart at the end of the block.
    queueMicrotask(() => (acts.querySelector<HTMLButtonElement>(`.${wanted}:not(:disabled)`) ?? acts.querySelector<HTMLButtonElement>('.up:not(:disabled), .down:not(:disabled)'))?.focus());
  }
  return el;
}

/** The fold-out line of a group's heading: rename and delete, the name box, the question before deleting. */
function groupExtra(block: Block<Entry>): { more: HTMLButtonElement; extra: HTMLElement; startNaming: () => void } {
  const draft = drafting?.id === block.id ? drafting : null;
  const rename = h('button', { class: 'btn grename', text: t('popupGroupRename') });
  const del = h('button', { class: 'btn gdelete', text: t('popupGroupDelete') });
  const acts = h('div', { class: 'acts' }, rename, del);

  const input = h('input', { class: 'gname', attrs: { type: 'text', maxlength: '60', 'aria-label': t('popupGroupName') } });
  // A drawing in the middle of typing keeps what was typed.
  const typed = naming === block.id ? namingDraft : null;
  input.value = typed ?? block.name ?? '';
  const error = h('div', { class: 'gerror', text: t('popupGroupNameTaken'), attrs: { role: 'alert' } });
  error.hidden = true;
  input.addEventListener('input', () => {
    if (naming === block.id) namingDraft = input.value;
    error.hidden = true;
  });
  // Leaving the box of a group that was being made makes no group.
  const stop = (): void => {
    naming = null;
    namingDraft = null;
    drafting = null;
    void render();
  };
  const save = async (): Promise<void> => {
    // A name in use is said so and the box stays open; an empty one makes no change.
    const wanted = input.value.trim();
    if (wanted !== '' && nameTaken((await loadList()).layout, wanted, draft ? undefined : block.id)) return void (error.hidden = false);
    if (!draft) return void change((layout) => renameGroup(layout, block.id, wanted));
    void change((layout, entries) => {
      const made = addGroup(layout, draft.id, wanted || freeName(layout, t('popupGroupDefault')));
      if (draft.entry === null) return made;
      const joined = assign(made, draft.entry, draft.id);
      return joined.sort.by === 'manual' ? reorder(joined, entries, draft.entry, null, true) : joined;
    });
  };
  input.addEventListener('keydown', (e) => {
    // Enter that confirms an input method's composition belongs to the text, not to the box.
    if (e.isComposing) return;
    if (e.key === 'Enter') void save();
    else if (e.key === 'Escape') stop();
    else return;
    e.preventDefault();
  });
  const form = h(
    'div',
    { class: 'renaming' },
    input,
    h('button', { class: 'btn gcancel', text: t('cancel'), on: { click: stop } }),
    h('button', { class: 'btn gsave', text: t('popupSave'), on: { click: () => void save() } }),
    error,
  );

  const cancel = h('button', { class: 'btn', text: t('cancel') });
  const confirm = h(
    'div',
    { class: 'confirm', attrs: { role: 'alert' } },
    h('span', { text: t('popupGroupDeleteConfirm') }),
    cancel,
    h('button', { class: 'btn danger', text: t('popupGroupDeleteYes'), on: { click: () => void change((layout) => removeGroup(layout, block.id)) } }),
  );

  const showOnly = (part: HTMLElement): void => {
    for (const el of [acts, form, confirm]) el.hidden = el !== part;
  };
  const startNaming = (): void => {
    showOnly(form);
    input.focus();
    if (typed === null) input.select();
  };
  rename.addEventListener('click', () => {
    naming = block.id;
    namingDraft = null;
    startNaming();
  });
  del.addEventListener('click', () => {
    showOnly(confirm);
    cancel.focus();
  });
  cancel.addEventListener('click', () => showOnly(acts));

  const extra = h('div', { class: 'extra gextra' }, acts, form, confirm);
  showOnly(acts);
  const more = foldOut(() => extra.parentElement!, extra, () => showOnly(acts));
  more.classList.add('gmore');
  return { more, extra, startNaming };
}

function blockName(block: Block<Entry>): string {
  return block.kind === 'pinned' ? t('popupBlockPinned') : block.kind === 'ungrouped' ? t('popupBlockUngrouped') : (block.name ?? '');
}

function blockEl(block: Block<Entry>, shown: Entry[], headings: boolean, drawn: Drawn): HTMLElement {
  const draft = drafting?.id === block.id;
  const folded = block.collapsed && !drawn.narrowed;
  const fold = h(
    'button',
    {
      class: 'fold',
      attrs: { 'aria-expanded': String(!folded) },
      on: {
        click: () => {
          // While the filter narrows the list every block is open; there is nothing to fold.
          if (!drawn.narrowed && !draft) void change((layout) => setCollapsed(layout, block.id, !block.collapsed));
        },
      },
    },
    icon([...ICONS.chevronDown], 14),
    h('span', { class: 'blockname', text: blockName(block) }),
    h('span', { class: 'blockcount', text: n(block.items.length) }),
  );
  const head = h('div', { class: 'blockhead' }, fold);
  head.hidden = !headings;

  const rows = h('div', { class: 'rows' }, ...shown.map((entry) => row(entry, block, drawn)));
  if (block.kind === 'group' && block.items.length === 0 && !draft) rows.append(h('div', { class: 'hollow', text: t('popupGroupEmpty') }));
  rows.hidden = folded;

  const vacant = block.kind === 'ungrouped' && block.items.length === 0;
  const el = h('section', { class: `block${folded ? ' folded' : ''}${vacant ? ' vacant' : ''}${draft ? ' draft' : ''}`, attrs: { 'data-block': block.id, 'data-kind': draft ? 'draft' : block.kind } }, head);
  if (block.kind === 'group') {
    const { more, extra, startNaming } = groupExtra(block);
    // A group that is not stored yet has nothing to rename or delete.
    if (!draft) head.append(more);
    el.append(extra);
    if (naming === block.id) {
      extra.hidden = false;
      el.classList.add('unfolded');
      more.setAttribute('aria-expanded', 'true');
      // The box takes the focus once it is on the page.
      queueMicrotask(startNaming);
    }
  }
  el.append(rows);
  return el;
}

const DIRECTION: Record<'asc' | 'desc', { paths: readonly string[]; name: MessageKey }> = {
  asc: { paths: ICONS.arrowUp, name: 'popupSortAsc' },
  desc: { paths: ICONS.arrowDown, name: 'popupSortDesc' },
};

function renderControls(layout: Layout, empty: boolean): void {
  document.getElementById('controls')!.hidden = empty;
  sortBy.value = layout.sort.by;
  const direction = DIRECTION[layout.sort.desc ? 'desc' : 'asc'];
  sortDir.replaceChildren(icon([...direction.paths], 16));
  sortDir.title = t(direction.name);
  sortDir.setAttribute('aria-label', t(direction.name));
  sortDir.disabled = layout.sort.by === 'manual';
}

export async function render(): Promise<void> {
  if (dragging) {
    redrawAfterDrag = true;
    return;
  }
  const mine = ++turn;
  const { entries, layout, blocks } = await loadList();
  if (dragging) redrawAfterDrag = true;
  if (mine !== turn || dragging) return;
  const needle = filter.value.trim().toLowerCase();
  const matches = (e: Entry): boolean =>
    e.name.toLowerCase().includes(needle) || (e.account ? (e.account.relPath ?? e.account.folderName).toLowerCase().includes(needle) : false);
  const drawn: Drawn = { layout, narrowed: needle !== '' };

  document.getElementById('count')!.textContent = entries.length > 0 ? t('popupCount', n(entries.length)) : t('popupTitle');
  renderControls(layout, entries.length === 0 && layout.groups.length === 0);

  // A group being made is drawn after the groups, like the stored one will be.
  if (drafting) {
    const made: Block<Entry> = { id: drafting.id, kind: 'group', name: freeName(layout, t('popupGroupDefault')), collapsed: false, items: [] };
    const at = blocks.findIndex((b) => b.kind === 'ungrouped');
    blocks.splice(at < 0 ? blocks.length : at, 0, made);
  }
  const visible = blocks
    .map((block) => ({ block, shown: needle ? block.items.filter(matches) : block.items }))
    .filter(({ block, shown }) => !needle || shown.length > 0 || block.id === drafting?.id);
  if (entries.length === 0 && layout.groups.length === 0 && !drafting) {
    list.replaceChildren(h('div', { class: 'empty', text: t('popupEmpty') }));
  } else if (visible.length === 0) {
    list.replaceChildren(h('div', { class: 'empty', text: t('popupNoMatch') }));
  } else {
    const headings = blocks.length > 1;
    list.replaceChildren(...visible.map(({ block, shown }) => blockEl(block, shown, headings, drawn)));
  }
}

// ---- dragging ---------------------------------------------------------------

/** Where a dragged entry would land. */
interface EntryDrop {
  blockId: string;
  /** The entry it lands next to; none when it only joins the block. */
  anchor: string | null;
  after: boolean;
}

/** Pointer travel before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 5;
/** Distance from the list's upper or lower edge inside which a drag scrolls it. */
const SCROLL_EDGE = 28;

function initDrag(): void {
  const line = h('div', { class: 'dropline' });

  list.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || filter.value.trim() !== '') return;
    const pressed = down.target as Element;
    if (pressed.closest('.more, .extra, input, select')) return;
    const rowEl = pressed.closest<HTMLElement>('.row');
    const groupEl = rowEl ? null : (pressed.closest('.fold')?.closest<HTMLElement>('.block[data-kind="group"]') ?? null);
    const source = rowEl ?? groupEl;
    if (!source) return;

    const manual = sortBy.value === 'manual';
    let active = false;
    let entryDrop: EntryDrop | null = null;
    /** Group to land in front of; `null` is the end, `undefined` is nowhere. */
    let groupBefore: string | null | undefined;
    let scroll = 0;
    let timer: ReturnType<typeof setInterval> | undefined;

    const mark = (target: Element | null): void => {
      list.querySelector('.droptarget')?.classList.remove('droptarget');
      target?.classList.add('droptarget');
    };
    const showLine = (at: Element | null, below: boolean): void => {
      if (!at) return void line.remove();
      const box = at.getBoundingClientRect();
      const frame = list.getBoundingClientRect();
      line.style.top = `${(below ? box.bottom : box.top) - frame.top + list.scrollTop - 1}px`;
      list.append(line);
    };

    const aim = (x: number, y: number): void => {
      const under = document.elementFromPoint(x, y);
      const blockEl = under?.closest<HTMLElement>('.block:not(.draft)') ?? null;
      entryDrop = null;
      groupBefore = undefined;
      if (rowEl) {
        const overRow = under?.closest<HTMLElement>('.row') ?? null;
        if (!blockEl || overRow === rowEl) {
          mark(null);
          showLine(null, false);
          return;
        }
        if (manual && overRow) {
          const box = overRow.getBoundingClientRect();
          const after = y > box.top + box.height / 2;
          entryDrop = { blockId: blockEl.dataset.block!, anchor: overRow.dataset.key!, after };
          mark(null);
          showLine(overRow, after);
        } else {
          entryDrop = { blockId: blockEl.dataset.block!, anchor: null, after: true };
          mark(blockEl);
          showLine(null, false);
        }
        return;
      }
      // A group lands in front of or behind another group.
      const over = blockEl?.dataset.kind === 'group' && blockEl !== source ? blockEl : null;
      if (!over) return void showLine(null, false);
      const box = over.getBoundingClientRect();
      const after = y > box.top + box.height / 2;
      const next = over.nextElementSibling as HTMLElement | null;
      groupBefore = after ? (next?.dataset.kind === 'group' ? next.dataset.block! : null) : over.dataset.block!;
      showLine(over, after);
    };

    const move = (ev: PointerEvent): void => {
      if (!active) {
        if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < DRAG_THRESHOLD) return;
        active = true;
        dragging = true;
        list.classList.add('dragging');
        source.classList.add('dragged');
        timer = setInterval(() => {
          if (scroll !== 0) list.scrollTop += scroll;
        }, 16);
      }
      ev.preventDefault();
      const frame = list.getBoundingClientRect();
      // Only towards an edge the pointer was moved to: a drag that starts beside an edge does not scroll by itself.
      const upwards = ev.clientY < frame.top + SCROLL_EDGE && ev.clientY < down.clientY;
      const downwards = ev.clientY > frame.bottom - SCROLL_EDGE && ev.clientY > down.clientY;
      scroll = upwards ? -8 : downwards ? 8 : 0;
      aim(ev.clientX, ev.clientY);
    };

    /** `released`: the pointer is up. A drag given up by key leaves it down, and its release must not count as a click either. */
    const finish = (apply: boolean, released: boolean): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      clearInterval(timer);
      if (!active) return;
      list.classList.remove('dragging');
      source.classList.remove('dragged');
      mark(null);
      line.remove();
      dragging = false;
      // The release that ends the drag must not count as a click on what lies under it.
      const swallowClick = (): void => {
        const swallow = (ev: MouseEvent): void => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      };
      if (released) swallowClick();
      else window.addEventListener('pointerup', swallowClick, { capture: true, once: true });

      const redraw = redrawAfterDrag;
      redrawAfterDrag = false;
      const done = apply
        ? rowEl && entryDrop
          ? dropEntry(rowEl.dataset.key!, entryDrop)
          : groupEl && groupBefore !== undefined
            ? change((layout) => moveGroup(layout, groupEl.dataset.block!, groupBefore!))
            : null
        : null;
      // A drawing asked for during the drag was put off until now.
      if (done) void done.finally(() => (redraw ? render() : undefined));
      else if (redraw) void render();
    };
    const up = (): void => finish(true, true);
    const cancel = (): void => finish(false, true);
    const key = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Escape' || !active) return;
      // Escape gives the drag up; it does not also close the popup.
      ev.preventDefault();
      ev.stopPropagation();
      finish(false, false);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
  });
}

/** Puts a dragged entry where it was dropped: pinned or not, its group, and its place when the order is manual. */
async function dropEntry(key: string, drop: EntryDrop): Promise<void> {
  const { entries } = await loadList();
  const entry = entries.find((e) => e.key === key);
  if (!entry) return;
  const toPinned = drop.blockId === PINNED;
  await change((layout, all) => {
    const grouped = toPinned ? layout : assign(layout, key, drop.blockId === UNGROUPED ? null : drop.blockId);
    return grouped.sort.by === 'manual' ? reorder(grouped, all, key, drop.anchor, drop.after) : grouped;
  });
  if (entry.pinned !== toPinned) await setPinned(entry, toPinned);
}

export function initList(): void {
  filter.addEventListener('input', () => void render());
  sortBy.addEventListener('change', () => void change((layout, entries) => setSort(layout, sortBy.value as SortBy, entries)));
  sortDir.addEventListener('click', () => void change(toggleDirection));
  document.getElementById('new-group')!.addEventListener('click', () => {
    draftGroup(null);
  });
  initDrag();
}
