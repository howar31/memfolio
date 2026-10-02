import { describe, expect, it } from 'vitest';
import { checkFolder, openInside, relativePath } from '../../src/core/folders';
import { FakeDir, asDir } from '../helpers/fake-fs';

describe('checkFolder', () => {
  it('reports a readable folder as ok', async () => {
    const dir = new FakeDir('acct');
    dir.put('a.jpg');
    expect(await checkFolder(asDir(dir))).toBe('ok');
  });

  it('reports an empty folder as ok', async () => {
    expect(await checkFolder(asDir(new FakeDir('acct')))).toBe('ok');
  });

  it('reports a folder without write permission', async () => {
    const dir = new FakeDir('acct');
    dir.permission = 'prompt';
    expect(await checkFolder(asDir(dir))).toBe('needs-permission');
  });

  it('reports a folder that was moved, renamed or deleted', async () => {
    const dir = new FakeDir('acct');
    dir.removed = true;
    expect(await checkFolder(asDir(dir))).toBe('missing');
  });

  it('reports a folder whose parent was removed', async () => {
    const parent = new FakeDir('person');
    const dir = parent.mkdir('instagram');
    parent.removed = true;
    expect(await checkFolder(asDir(dir))).toBe('missing');
  });
});

describe('openInside', () => {
  it('opens an existing account folder', async () => {
    const root = new FakeDir('root');
    const existing = root.mkdir('acct');
    const r = await openInside(asDir(root), 'acct');
    expect(r).toEqual({ state: 'ok', dir: existing, created: false });
  });

  it('creates the account folder when it does not exist', async () => {
    const root = new FakeDir('root');
    const r = await openInside(asDir(root), 'acct');
    expect(r.state).toBe('ok');
    expect(r.state === 'ok' && r.created).toBe(true);
    expect(root.children.has('acct')).toBe(true);
  });

  it('reports a name that exists as a filesystem link the browser will not follow', async () => {
    const root = new FakeDir('root');
    root.links.add('acct');
    expect(await openInside(asDir(root), 'acct')).toEqual({ state: 'link' });
    expect(root.children.has('acct')).toBe(false);
  });

  it('reports a root that is gone', async () => {
    const root = new FakeDir('root');
    root.removed = true;
    expect(await openInside(asDir(root), 'acct')).toEqual({ state: 'parent-missing' });
  });
});

describe('relativePath', () => {
  it('returns the path from a known parent, starting with the parent name', async () => {
    const parent = new FakeDir('archive');
    const dir = parent.mkdir('alice').mkdir('instagram');
    expect(await relativePath([asDir(parent)], asDir(dir))).toBe('archive/alice/instagram');
  });

  it('tries each known parent in turn', async () => {
    const other = new FakeDir('other');
    const parent = new FakeDir('root');
    const dir = parent.mkdir('acct');
    expect(await relativePath([asDir(other), asDir(parent)], asDir(dir))).toBe('root/acct');
  });

  it('returns null when no known parent contains the folder', async () => {
    expect(await relativePath([asDir(new FakeDir('root'))], asDir(new FakeDir('elsewhere')))).toBeNull();
  });

  it('skips parents that can no longer be read', async () => {
    const gone = new FakeDir('gone');
    gone.resolve = async () => {
      throw new DOMException('gone', 'NotFoundError');
    };
    const parent = new FakeDir('root');
    const dir = parent.mkdir('acct');
    expect(await relativePath([asDir(gone), asDir(parent)], asDir(dir))).toBe('root/acct');
  });
});
