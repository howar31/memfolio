// How the account list is laid out: blocks (pinned, groups, the rest), the order
// inside a block, and the text form of that layout. Pure functions; storage and
// drawing live elsewhere.

export type SortBy = 'name' | 'lastRun' | 'files' | 'added' | 'manual';

export interface Group {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface Layout {
  sort: { by: SortBy; desc: boolean };
  /** In the order they are listed. */
  groups: Group[];
  /** Entry key to group id; an entry without one belongs to the rest. */
  groupOf: Record<string, string>;
  /** Manual order of the whole list; inside a block the relative places count. */
  order: string[];
  folded: { pinned: boolean; ungrouped: boolean };
}

export const DEFAULT_LAYOUT: Layout = {
  sort: { by: 'name', desc: false },
  groups: [],
  groupOf: {},
  order: [],
  folded: { pinned: false, ungrouped: false },
};

/** The direction a sort starts with: names from A, everything else from the newest or largest. */
const STARTS_DESC: Record<SortBy, boolean> = { name: false, lastRun: true, files: true, added: true, manual: false };

/** Ids of the two blocks that are not groups. */
export const PINNED = 'pinned';
export const UNGROUPED = 'ungrouped';

/** Headings the text form uses for the two blocks that are not groups. */
export const PINNED_HEADING = '[pinned]';
export const UNGROUPED_HEADING = '[ungrouped]';

/** What the layout needs to know about one entry of the list. */
export interface Item {
  key: string;
  name: string;
  pinned: boolean;
  lastRunAt: number | null;
  fileCount: number;
  addedAt: number;
}

export interface Block<T extends Item = Item> {
  /** `pinned`, `ungrouped` or a group id. */
  id: string;
  kind: 'pinned' | 'group' | 'ungrouped';
  /** Only groups carry a name of their own. */
  name: string | null;
  collapsed: boolean;
  items: T[];
}

export function accountKey(platform: string, id: string): string {
  return `${platform}:${id}`;
}

/** Key of an entry known by its address only. */
export function pendingKey(platform: string, username: string): string {
  return `${platform}:@${username.toLowerCase()}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A layout read from storage, with defaults for whatever is missing or malformed. */
export function normalizeLayout(raw: unknown): Layout {
  if (!isObject(raw)) return DEFAULT_LAYOUT;
  const sort = isObject(raw.sort) && typeof raw.sort.by === 'string' && raw.sort.by in STARTS_DESC
    ? { by: raw.sort.by as SortBy, desc: raw.sort.desc === true }
    : DEFAULT_LAYOUT.sort;
  const groups = Array.isArray(raw.groups)
    ? raw.groups.flatMap((g): Group[] =>
        isObject(g) && typeof g.id === 'string' && typeof g.name === 'string' ? [{ id: g.id, name: g.name, collapsed: g.collapsed === true }] : [],
      )
    : [];
  const ids = new Set(groups.map((g) => g.id));
  const groupOf = isObject(raw.groupOf)
    ? Object.fromEntries(Object.entries(raw.groupOf).filter((e): e is [string, string] => typeof e[1] === 'string' && ids.has(e[1])))
    : {};
  const order = Array.isArray(raw.order) ? raw.order.filter((k): k is string => typeof k === 'string') : [];
  const folded = isObject(raw.folded) ? { pinned: raw.folded.pinned === true, ungrouped: raw.folded.ungrouped === true } : DEFAULT_LAYOUT.folded;
  return { sort, groups, groupOf, order, folded };
}

function comparer(layout: Layout): (a: Item, b: Item) => number {
  const { by, desc } = layout.sort;
  const byName = (a: Item, b: Item): number => a.name.localeCompare(b.name);
  const turn = desc ? -1 : 1;
  if (by === 'manual') {
    const place = new Map(layout.order.map((key, i) => [key, i]));
    return (a, b) => {
      const pa = place.get(a.key);
      const pb = place.get(b.key);
      if (pa !== undefined && pb !== undefined) return pa - pb;
      if (pa !== undefined) return -1;
      if (pb !== undefined) return 1;
      return byName(a, b);
    };
  }
  if (by === 'name') return (a, b) => turn * byName(a, b);
  if (by === 'lastRun') {
    return (a, b) => {
      // An entry that never ran has nothing to compare: it goes last either way.
      if (a.lastRunAt === null || b.lastRunAt === null) return a.lastRunAt === b.lastRunAt ? byName(a, b) : a.lastRunAt === null ? 1 : -1;
      return turn * (a.lastRunAt - b.lastRunAt) || byName(a, b);
    };
  }
  const value = by === 'files' ? (i: Item): number => i.fileCount : (i: Item): number => i.addedAt;
  return (a, b) => turn * (value(a) - value(b)) || byName(a, b);
}

/**
 * The list as blocks, top to bottom: pinned entries (when there are any), every
 * group, then the rest. The rest is left out only when it is the sole block and
 * empty. Sorting never crosses a block.
 */
export function arrange<T extends Item>(items: T[], layout: Layout): Block<T>[] {
  const compare = comparer(layout);
  const sorted = (list: T[]): T[] => [...list].sort(compare);
  const ids = new Set(layout.groups.map((g) => g.id));
  const pinned = items.filter((i) => i.pinned);
  const loose = items.filter((i) => !i.pinned);
  const groupOf = (i: T): string | null => {
    const id = layout.groupOf[i.key];
    return id !== undefined && ids.has(id) ? id : null;
  };

  const blocks: Block<T>[] = [];
  if (pinned.length > 0) blocks.push({ id: PINNED, kind: 'pinned', name: null, collapsed: layout.folded.pinned, items: sorted(pinned) });
  for (const g of layout.groups) {
    blocks.push({ id: g.id, kind: 'group', name: g.name, collapsed: g.collapsed, items: sorted(loose.filter((i) => groupOf(i) === g.id)) });
  }
  const rest = loose.filter((i) => groupOf(i) === null);
  if (rest.length > 0 || blocks.length > 0 || items.length === 0) {
    blocks.push({ id: UNGROUPED, kind: 'ungrouped', name: null, collapsed: layout.folded.ungrouped, items: sorted(rest) });
  }
  return blocks;
}

/** Every key in the order the list shows it. */
function shownOrder(items: Item[], layout: Layout): string[] {
  return arrange(items, layout).flatMap((b) => b.items.map((i) => i.key));
}

/**
 * Chooses what to sort by, starting in that criterion's own direction. Going to
 * manual for the first time keeps the order on screen, which needs the entries.
 */
export function setSort(layout: Layout, by: SortBy, items?: Item[]): Layout {
  // A manual order made earlier is kept; the first time there is none, and the list stays as it looks.
  const order = by === 'manual' && layout.order.length === 0 && items ? shownOrder(items, layout) : layout.order;
  return { ...layout, sort: { by, desc: STARTS_DESC[by] }, order };
}

export function toggleDirection(layout: Layout): Layout {
  if (layout.sort.by === 'manual') return layout;
  return { ...layout, sort: { ...layout.sort, desc: !layout.sort.desc } };
}

export function addGroup(layout: Layout, id: string, name: string): Layout {
  return { ...layout, groups: [...layout.groups, { id, name: name.trim(), collapsed: false }] };
}

export function renameGroup(layout: Layout, id: string, name: string): Layout {
  const trimmed = name.trim();
  if (trimmed === '' || trimmed === PINNED_HEADING || trimmed === UNGROUPED_HEADING) return layout;
  return { ...layout, groups: layout.groups.map((g) => (g.id === id ? { ...g, name: trimmed } : g)) };
}

/** Removes a group; its entries go back to the rest. */
export function removeGroup(layout: Layout, id: string): Layout {
  return {
    ...layout,
    groups: layout.groups.filter((g) => g.id !== id),
    groupOf: Object.fromEntries(Object.entries(layout.groupOf).filter(([, g]) => g !== id)),
  };
}

/** Moves a group in front of another one, or to the end when `before` is null. */
export function moveGroup(layout: Layout, id: string, before: string | null): Layout {
  if (id === before) return layout;
  const moved = layout.groups.find((g) => g.id === id);
  if (!moved) return layout;
  const others = layout.groups.filter((g) => g.id !== id);
  const at = before === null ? -1 : others.findIndex((g) => g.id === before);
  const groups = at < 0 ? [...others, moved] : [...others.slice(0, at), moved, ...others.slice(at)];
  return { ...layout, groups };
}

export function setCollapsed(layout: Layout, blockId: string, collapsed: boolean): Layout {
  if (blockId === PINNED || blockId === UNGROUPED) return { ...layout, folded: { ...layout.folded, [blockId]: collapsed } };
  return { ...layout, groups: layout.groups.map((g) => (g.id === blockId ? { ...g, collapsed } : g)) };
}

/** Puts an entry into a group, or back to the rest with `null` or an unknown group. */
export function assign(layout: Layout, key: string, groupId: string | null): Layout {
  const known = groupId !== null && layout.groups.some((g) => g.id === groupId);
  if ((layout.groupOf[key] ?? null) === (known ? groupId : null)) return layout;
  const { [key]: _, ...others } = layout.groupOf;
  return { ...layout, groupOf: known ? { ...others, [key]: groupId } : others };
}

/**
 * Moves an entry next to another one in the manual order, or to the end when
 * no neighbour is named. Entries that were never placed keep the place the
 * list shows them at.
 */
export function reorder(layout: Layout, items: Item[], key: string, anchor: string | null, after: boolean): Layout {
  const manual: Layout = { ...layout, sort: { by: 'manual', desc: false } };
  const order = shownOrder(items, manual).filter((k) => k !== key);
  const at = anchor === null ? -1 : order.indexOf(anchor);
  if (at < 0) order.push(key);
  else order.splice(after ? at + 1 : at, 0, key);
  return { ...layout, order };
}

/** An entry got a new key (an address-only entry became an account). A place the new key already has wins. */
export function renameKey(layout: Layout, from: string, to: string): Layout {
  const { [from]: group, ...groupOf } = layout.groupOf;
  if (group !== undefined && groupOf[to] === undefined) groupOf[to] = group;
  const order = layout.order.includes(to) ? layout.order.filter((k) => k !== from) : layout.order.map((k) => (k === from ? to : k));
  return { ...layout, groupOf, order };
}

/** Drops the keys of entries that are gone. */
export function prune(layout: Layout, live: Set<string>): Layout {
  return {
    ...layout,
    groupOf: Object.fromEntries(Object.entries(layout.groupOf).filter(([k]) => live.has(k))),
    order: layout.order.filter((k) => live.has(k)),
  };
}

/**
 * The list as text: one address per entry in the order on screen, each block
 * under a `# name` line. A list without groups and pins is addresses only.
 */
export function exportText<T extends Item>(blocks: Block<T>[], address: (item: T) => string): string {
  const plain = blocks.every((b) => b.kind === 'ungrouped');
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'ungrouped' && block.items.length === 0) continue;
    if (!plain) lines.push(`# ${block.kind === 'pinned' ? PINNED_HEADING : block.kind === 'ungrouped' ? UNGROUPED_HEADING : block.name}`);
    for (const item of block.items) lines.push(address(item));
  }
  return lines.join('\n');
}
