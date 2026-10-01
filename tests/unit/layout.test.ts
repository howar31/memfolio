import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LAYOUT,
  addGroup,
  arrange,
  assign,
  exportText,
  moveGroup,
  normalizeLayout,
  prune,
  removeGroup,
  renameGroup,
  renameKey,
  reorder,
  setCollapsed,
  setSort,
  toggleDirection,
  type Item,
  type Layout,
} from '../../src/core/layout';

const item = (name: string, more: Partial<Item> = {}): Item => ({ key: `p:${name}`, name, pinned: false, lastRunAt: null, fileCount: 0, addedAt: 0, ...more });

const names = (layout: Layout, items: Item[]): Array<[string, string[]]> => arrange(items, layout).map((b) => [b.id, b.items.map((i) => i.name)]);

function withGroups(): Layout {
  let layout = addGroup(DEFAULT_LAYOUT, 'g1', 'First');
  layout = addGroup(layout, 'g2', 'Second');
  return layout;
}

describe('arrange', () => {
  it('is one block sorted by name when nothing is grouped or pinned', () => {
    expect(names(DEFAULT_LAYOUT, [item('b'), item('a')])).toEqual([['ungrouped', ['a', 'b']]]);
  });

  it('puts pinned entries into a block of their own at the top, whatever their group', () => {
    const layout = assign(withGroups(), 'p:b', 'g1');
    expect(names(layout, [item('a'), item('b', { pinned: true }), item('c', { pinned: true })])).toEqual([
      ['pinned', ['b', 'c']],
      ['g1', []],
      ['g2', []],
      ['ungrouped', ['a']],
    ]);
  });

  it('lists the groups in their order, empty ones too, and the rest last', () => {
    let layout = assign(withGroups(), 'p:c', 'g2');
    layout = assign(layout, 'p:a', 'g2');
    expect(names(layout, [item('a'), item('b'), item('c')])).toEqual([
      ['g1', []],
      ['g2', ['a', 'c']],
      ['ungrouped', ['b']],
    ]);
  });

  it('treats an entry of a group that no longer exists as ungrouped', () => {
    const layout: Layout = { ...DEFAULT_LAYOUT, groupOf: { 'p:a': 'gone' } };
    expect(names(layout, [item('a')])).toEqual([['ungrouped', ['a']]]);
  });

  it('carries the name and the folded state of each block', () => {
    let layout = setCollapsed(withGroups(), 'g1', true);
    layout = setCollapsed(layout, 'ungrouped', true);
    layout = setCollapsed(layout, 'pinned', true);
    const blocks = arrange([item('a', { pinned: true }), item('b')], layout);
    expect(blocks.map((b) => [b.kind, b.name, b.collapsed])).toEqual([
      ['pinned', null, true],
      ['group', 'First', true],
      ['group', 'Second', false],
      ['ungrouped', null, true],
    ]);
  });
});

describe('sorting inside a block', () => {
  const items = [
    item('a', { lastRunAt: 100, fileCount: 5, addedAt: 3 }),
    item('b', { lastRunAt: 300, fileCount: 50, addedAt: 1 }),
    item('c', { lastRunAt: null, fileCount: 0, addedAt: 2 }),
    item('d', { lastRunAt: 200, fileCount: 5, addedAt: 4 }),
  ];
  const sorted = (layout: Layout): string[] => arrange(items, layout)[0]!.items.map((i) => i.name);

  it('goes by name from A to Z by default and can be turned around', () => {
    expect(sorted(DEFAULT_LAYOUT)).toEqual(['a', 'b', 'c', 'd']);
    expect(sorted(toggleDirection(DEFAULT_LAYOUT))).toEqual(['d', 'c', 'b', 'a']);
  });

  it('starts the last run with the newest and keeps entries that never ran at the end either way', () => {
    const layout = setSort(DEFAULT_LAYOUT, 'lastRun');
    expect(layout.sort).toEqual({ by: 'lastRun', desc: true });
    expect(sorted(layout)).toEqual(['b', 'd', 'a', 'c']);
    expect(sorted(toggleDirection(layout))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('starts the file count with the largest and settles ties by name', () => {
    const layout = setSort(DEFAULT_LAYOUT, 'files');
    expect(sorted(layout)).toEqual(['b', 'a', 'd', 'c']);
    expect(sorted(toggleDirection(layout))).toEqual(['c', 'a', 'd', 'b']);
  });

  it('starts the date added with the newest', () => {
    const layout = setSort(DEFAULT_LAYOUT, 'added');
    expect(sorted(layout)).toEqual(['d', 'a', 'c', 'b']);
    expect(sorted(toggleDirection(layout))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('follows the stored order when set to manual, unknown entries last by name', () => {
    const layout: Layout = { ...setSort(DEFAULT_LAYOUT, 'manual'), order: ['p:d', 'p:b'] };
    expect(sorted(layout)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('has no direction to turn when set to manual', () => {
    const layout = setSort(DEFAULT_LAYOUT, 'manual');
    expect(toggleDirection(layout)).toEqual(layout);
  });

  it('never moves an entry out of its block', () => {
    const layout = setSort(assign(withGroups(), 'p:c', 'g1'), 'files');
    expect(names(layout, items)).toEqual([
      ['g1', ['c']],
      ['g2', []],
      ['ungrouped', ['b', 'a', 'd']],
    ]);
  });
});

describe('groups', () => {
  it('are renamed, and trimmed names that are empty are refused', () => {
    const layout = renameGroup(withGroups(), 'g1', '  Renamed ');
    expect(layout.groups.map((g) => g.name)).toEqual(['Renamed', 'Second']);
    expect(renameGroup(layout, 'g1', '   ')).toEqual(layout);
  });

  it('give their entries back to the rest when removed', () => {
    const layout = removeGroup(assign(withGroups(), 'p:a', 'g1'), 'g1');
    expect(layout.groups.map((g) => g.id)).toEqual(['g2']);
    expect(layout.groupOf).toEqual({});
  });

  it('change places', () => {
    const layout = addGroup(withGroups(), 'g3', 'Third');
    expect(moveGroup(layout, 'g3', 'g1').groups.map((g) => g.id)).toEqual(['g3', 'g1', 'g2']);
    expect(moveGroup(layout, 'g1', null).groups.map((g) => g.id)).toEqual(['g2', 'g3', 'g1']);
    expect(moveGroup(layout, 'g1', 'g1')).toEqual(layout);
  });

  it('take an entry, and let it go again', () => {
    const layout = assign(withGroups(), 'p:a', 'g1');
    expect(layout.groupOf).toEqual({ 'p:a': 'g1' });
    expect(assign(layout, 'p:a', null).groupOf).toEqual({});
    expect(assign(layout, 'p:a', 'nope').groupOf).toEqual({});
  });

  it('are left untouched by a move that changes nothing', () => {
    const layout = assign(assign(withGroups(), 'p:a', 'g1'), 'p:b', 'g1');
    expect(assign(layout, 'p:a', 'g1')).toBe(layout);
    expect(assign(layout, 'p:z', null)).toBe(layout);
  });

  it('cannot take the names the text form keeps for the pinned block and the rest', () => {
    const layout = withGroups();
    expect(renameGroup(layout, 'g1', '[pinned]')).toEqual(layout);
    expect(renameGroup(layout, 'g1', ' [ungrouped] ')).toEqual(layout);
  });
});

describe('manual order', () => {
  const items = [item('a'), item('b'), item('c'), item('d')];
  const manual = setSort(DEFAULT_LAYOUT, 'manual');
  const sorted = (layout: Layout): string[] => arrange(items, layout).flatMap((b) => b.items.map((i) => i.name));

  it('moves an entry before or after another one', () => {
    expect(sorted(reorder(manual, items, 'p:d', 'p:a', false))).toEqual(['d', 'a', 'b', 'c']);
    expect(sorted(reorder(manual, items, 'p:a', 'p:c', true))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an entry to the end when no neighbour is named', () => {
    expect(sorted(reorder(manual, items, 'p:a', null, true))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('keeps the places of entries that were never moved before', () => {
    const layout = reorder(manual, items, 'p:c', 'p:b', false);
    expect(layout.order).toEqual(['p:a', 'p:c', 'p:b', 'p:d']);
  });

  it('starts from the order on screen when the list was sorted another way before', () => {
    const byNameDesc = toggleDirection(DEFAULT_LAYOUT);
    const layout = setSort(byNameDesc, 'manual', items);
    expect(sorted(layout)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('comes back as it was left after the list was sorted another way in between', () => {
    const arranged = reorder(manual, items, 'p:d', 'p:a', false);
    const back = setSort(setSort(arranged, 'name', items), 'manual', items);
    expect(sorted(back)).toEqual(['d', 'a', 'b', 'c']);
  });
});

describe('keys', () => {
  it('are renamed in the group map and in the order', () => {
    const layout: Layout = { ...assign(withGroups(), 'p:@a', 'g1'), order: ['p:x', 'p:@a'] };
    const next = renameKey(layout, 'p:@a', 'p:1');
    expect(next.groupOf).toEqual({ 'p:1': 'g1' });
    expect(next.order).toEqual(['p:x', 'p:1']);
  });

  it('keep the place of the target when it already has one', () => {
    const layout: Layout = { ...assign(assign(withGroups(), 'p:@a', 'g1'), 'p:1', 'g2'), order: ['p:1', 'p:@a'] };
    const next = renameKey(layout, 'p:@a', 'p:1');
    expect(next.groupOf).toEqual({ 'p:1': 'g2' });
    expect(next.order).toEqual(['p:1']);
  });

  it('that name no entry any more are dropped', () => {
    const layout: Layout = { ...assign(assign(withGroups(), 'p:a', 'g1'), 'p:b', 'g1'), order: ['p:b', 'p:a'] };
    const next = prune(layout, new Set(['p:a']));
    expect(next.groupOf).toEqual({ 'p:a': 'g1' });
    expect(next.order).toEqual(['p:a']);
  });
});

describe('normalizeLayout', () => {
  it('gives the defaults for nothing or nonsense', () => {
    expect(normalizeLayout(undefined)).toEqual(DEFAULT_LAYOUT);
    expect(normalizeLayout({ sort: { by: 'colour' }, groups: 'x', order: 3 })).toEqual(DEFAULT_LAYOUT);
  });

  it('keeps what is well formed', () => {
    const layout = setCollapsed(setSort(assign(withGroups(), 'p:a', 'g1'), 'files'), 'pinned', true);
    expect(normalizeLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });
});

describe('exportText', () => {
  const url = (i: Item): string => `https://example.test/${i.name}/`;

  it('is the plain list of addresses when there are no blocks to name', () => {
    expect(exportText(arrange([item('b'), item('a')], DEFAULT_LAYOUT), url)).toBe('https://example.test/a/\nhttps://example.test/b/');
  });

  it('names every block before its addresses, in the order on screen', () => {
    const layout = assign(withGroups(), 'p:b', 'g2');
    const text = exportText(arrange([item('a', { pinned: true }), item('b'), item('c')], layout), url);
    expect(text.split('\n')).toEqual([
      '# [pinned]',
      'https://example.test/a/',
      '# First',
      '# Second',
      'https://example.test/b/',
      '# [ungrouped]',
      'https://example.test/c/',
    ]);
  });

  it('leaves out the heading of the rest when it is empty', () => {
    const layout = assign(withGroups(), 'p:a', 'g1');
    expect(exportText(arrange([item('a')], layout), url).split('\n')).toEqual(['# First', 'https://example.test/a/', '# Second']);
  });
});
