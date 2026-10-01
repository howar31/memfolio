import { describe, expect, it } from 'vitest';
import { compareFolders, exportCheck, exportFileName, inspectFolder, locateUnder, sharesStorage, writeTest, type CheckSnapshot } from '../../src/core/folder-inspect';
import { FakeDir, asDir } from '../helpers/fake-fs';

/** A second handle with another path that reaches the same files: what a junction or symlink amounts to. */
function linkTo(real: FakeDir, name: string): FakeDir {
  const link = new FakeDir(name);
  link.children = real.children;
  return link;
}

function media(dir: FakeDir, owner: string, count: number): void {
  for (let i = 0; i < count; i++) dir.put(`acct_${1600000000 + i}_${300000000000 + i}_${owner}.jpg`);
}

describe('inspectFolder', () => {
  it('reports what the browser exposes for a readable folder', async () => {
    const dir = new FakeDir('instagram');
    media(dir, '42', 3);
    media(dir, '77', 1);
    dir.put('notes.txt');
    dir.mkdir('sub');
    expect(await inspectFolder(asDir(dir))).toEqual({
      name: 'instagram',
      permission: 'granted',
      readable: true,
      files: 5,
      folders: 1,
      mediaFiles: 4,
      owners: [
        { id: '42', files: 3 },
        { id: '77', files: 1 },
      ],
      error: null,
    });
  });

  it('reports a folder that cannot be read, with the reason', async () => {
    const dir = new FakeDir('gone');
    dir.removed = true;
    const r = await inspectFolder(asDir(dir));
    expect(r).toMatchObject({ readable: false, error: 'NotFoundError', files: 0 });
  });

  it('does not try to read without permission', async () => {
    const dir = new FakeDir('locked');
    dir.permission = 'prompt';
    media(dir, '42', 2);
    expect(await inspectFolder(asDir(dir))).toMatchObject({ permission: 'prompt', readable: false, files: 0, error: null });
  });
});

describe('writeTest', () => {
  it('creates, writes, reads back and removes a temporary file', async () => {
    const dir = new FakeDir('instagram');
    media(dir, '42', 1);
    expect(await writeTest(asDir(dir))).toEqual({ ok: true });
    expect(dir.fileNames()).toHaveLength(1);
  });

  it('names the step that failed and leaves nothing behind', async () => {
    const dir = new FakeDir('readonly');
    dir.failWrites = true;
    const r = await writeTest(asDir(dir));
    expect(r).toMatchObject({ ok: false, step: 'write', error: 'NoModificationAllowedError' });
    expect(dir.fileNames()).toEqual([]);
  });

  it('reports a folder it cannot create a file in', async () => {
    const dir = new FakeDir('gone');
    dir.removed = true;
    expect(await writeTest(asDir(dir))).toMatchObject({ ok: false, step: 'create', error: 'NotFoundError' });
  });
});

describe('compareFolders', () => {
  it('recognises the same handle', async () => {
    const dir = new FakeDir('a');
    media(dir, '42', 2);
    expect(await compareFolders(asDir(dir), asDir(dir))).toEqual({ sameEntry: true, sameListing: true, filesA: 2, filesB: 2 });
  });

  it('finds two paths with identical content', async () => {
    const real = new FakeDir('instagram');
    media(real, '42', 3);
    const link = linkTo(real, 'acct');
    expect(await compareFolders(asDir(link), asDir(real))).toEqual({ sameEntry: false, sameListing: true, filesA: 3, filesB: 3 });
  });

  it('tells different folders apart', async () => {
    const a = new FakeDir('a');
    const b = new FakeDir('b');
    media(a, '42', 3);
    media(b, '42', 2);
    expect(await compareFolders(asDir(a), asDir(b))).toEqual({ sameEntry: false, sameListing: false, filesA: 3, filesB: 2 });
  });

  it('does not call two empty folders identical', async () => {
    expect(await compareFolders(asDir(new FakeDir('a')), asDir(new FakeDir('b')))).toMatchObject({ sameListing: false });
  });
});

describe('sharesStorage', () => {
  it('confirms that a link and its target are the same place', async () => {
    const real = new FakeDir('instagram');
    media(real, '42', 1);
    const link = linkTo(real, 'acct');
    expect(await sharesStorage(asDir(link), asDir(real))).toEqual({ ok: true, shared: true });
    expect(real.fileNames()).toHaveLength(1);
  });

  it('shows that two copies with equal file names are separate places', async () => {
    const a = new FakeDir('a');
    const b = new FakeDir('b');
    media(a, '42', 2);
    media(b, '42', 2);
    expect(await sharesStorage(asDir(a), asDir(b))).toEqual({ ok: true, shared: false });
    expect(a.fileNames()).toHaveLength(2);
    expect(b.fileNames()).toHaveLength(2);
  });

  it('reports when the marker cannot be written', async () => {
    const a = new FakeDir('a');
    a.failWrites = true;
    expect(await sharesStorage(asDir(a), asDir(new FakeDir('b')))).toMatchObject({ ok: false, error: 'NoModificationAllowedError' });
    expect(a.fileNames()).toEqual([]);
  });
});

describe('locateUnder', () => {
  it('finds a real folder below the parent by walking down to it', async () => {
    const parent = new FakeDir('archive');
    const dir = parent.mkdir('alice').mkdir('instagram');
    expect(await locateUnder(asDir(parent), asDir(dir))).toEqual({ kind: 'real', path: ['alice', 'instagram'] });
  });

  it('recognises a link: its path is inside the parent, but the parent cannot open it', async () => {
    const parent = new FakeDir('downloads');
    const link = new FakeDir('acct');
    link.parent = parent; // the path says it is inside ...
    parent.links.add('acct'); // ... but the browser hides links from the parent
    expect(await locateUnder(asDir(parent), asDir(link))).toEqual({ kind: 'link', path: ['acct'], blockedAt: 'acct' });
  });

  it('names the segment where a link sits further up the path', async () => {
    const parent = new FakeDir('root');
    const person = new FakeDir('person');
    person.parent = parent;
    parent.links.add('person');
    const dir = person.mkdir('instagram');
    expect(await locateUnder(asDir(parent), asDir(dir))).toEqual({ kind: 'link', path: ['person', 'instagram'], blockedAt: 'person' });
  });

  it('reports a folder that is not below the parent', async () => {
    expect(await locateUnder(asDir(new FakeDir('a')), asDir(new FakeDir('b')))).toEqual({ kind: 'outside' });
  });

  it('reports the parent itself', async () => {
    const parent = new FakeDir('a');
    expect(await locateUnder(asDir(parent), asDir(parent))).toEqual({ kind: 'same' });
  });
});

describe('exportCheck', () => {
  const snapshot: CheckSnapshot = {
    report: { name: 'instagram', permission: 'granted', readable: true, files: 3, folders: 0, mediaFiles: 3, owners: [{ id: '42', files: 3 }], error: null },
    parents: [
      { name: 'downloads', role: 'download-root', location: { kind: 'outside' } },
      { name: 'archive', role: 'import-parent', location: { kind: 'real', path: ['alice', 'instagram'] } },
    ],
    accounts: ['@acct'],
    write: { ok: true },
    comparison: { otherName: 'acct', result: { sameEntry: false, sameListing: true, filesA: 3, filesB: 3 }, marker: { ok: true, shared: true } },
  };
  const meta = { version: '0.1.0', userAgent: 'TestBrowser/1', at: new Date('2026-09-30T15:04:05Z') };

  it('contains every result of the check plus what is needed to interpret it', () => {
    expect(exportCheck(snapshot, meta)).toEqual({
      tool: 'memfolio-folder-check',
      formatVersion: 1,
      extensionVersion: '0.1.0',
      generatedAt: '2026-09-30T15:04:05.000Z',
      userAgent: 'TestBrowser/1',
      folder: snapshot.report,
      parents: snapshot.parents,
      managedAccounts: ['@acct'],
      writeTest: { ok: true },
      comparison: snapshot.comparison,
    });
  });

  it('marks tests that were not run as null', () => {
    const out = exportCheck({ ...snapshot, write: null, comparison: null }, meta);
    expect(out.writeTest).toBeNull();
    expect(out.comparison).toBeNull();
  });

  it('is plain data that survives JSON', () => {
    const out = exportCheck(snapshot, meta);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });
});

describe('exportFileName', () => {
  it('carries the local date and time', () => {
    expect(exportFileName(new Date(2026, 8, 30, 23, 5, 9))).toBe('memfolio-folder-check-20260930-230509.json');
  });
});
