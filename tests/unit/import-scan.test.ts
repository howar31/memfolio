import { describe, expect, it } from 'vitest';
import { scanForAccounts } from '../../src/core/import-scan';
import { FakeDir, asDir } from '../helpers/fake-fs';

function fill(dir: FakeDir, username: string, ownerId: string, count: number, startAt = 1600000000): void {
  for (let i = 0; i < count; i++) dir.put(`${username}_${startAt + i}_${200000000000 + i}${ownerId}_${ownerId}.jpg`);
}

const signal = new AbortController().signal;

describe('scanForAccounts', () => {
  it('finds account folders below the picked parent with their relative path', async () => {
    const parent = new FakeDir('archive');
    fill(parent.mkdir('alice').mkdir('instagram'), 'alice.ig', '42', 5);
    fill(parent.mkdir('bob').mkdir('instagram'), 'bob_ig', '77', 3);
    parent.mkdir('empty');

    const r = await scanForAccounts(asDir(parent), { signal });

    expect(r.candidates.map((c) => [c.path.join('/'), c.ownerId, c.username, c.fileCount])).toEqual([
      ['alice/instagram', '42', 'alice.ig', 5],
      ['bob/instagram', '77', 'bob_ig', 3],
    ]);
  });

  it('proposes only the dominant owner of a folder that mixes accounts', async () => {
    const parent = new FakeDir('root');
    const d = parent.mkdir('person');
    fill(d, 'main', '42', 20);
    fill(d, 'guest', '77', 2);
    const r = await scanForAccounts(asDir(parent), { signal });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]).toMatchObject({ ownerId: '42', fileCount: 20, totalFiles: 22, otherOwners: 1 });
  });

  it('takes the username from the newest file of the dominant owner', async () => {
    const parent = new FakeDir('root');
    const d = parent.mkdir('person');
    fill(d, 'oldname', '42', 5, 1500000000);
    fill(d, 'newname', '42', 4, 1700000000);
    const r = await scanForAccounts(asDir(parent), { signal });
    expect(r.candidates[0]).toMatchObject({ ownerId: '42', username: 'newname', fileCount: 9 });
  });

  it('reports the same owner found in two folders as separate candidates', async () => {
    const parent = new FakeDir('root');
    fill(parent.mkdir('a'), 'acct', '42', 10);
    fill(parent.mkdir('b'), 'acct', '42', 4);
    const r = await scanForAccounts(asDir(parent), { signal });
    expect(r.candidates.map((c) => [c.path.join('/'), c.fileCount])).toEqual([
      ['a', 10],
      ['b', 4],
    ]);
  });

  it('includes the picked folder itself when it holds media files', async () => {
    const parent = new FakeDir('acct');
    fill(parent, 'acct', '42', 2);
    const r = await scanForAccounts(asDir(parent), { signal });
    expect(r.candidates[0]).toMatchObject({ ownerId: '42' });
    expect(r.candidates[0]!.path).toEqual([]);
  });

  it('does not descend below the depth limit', async () => {
    const parent = new FakeDir('root');
    fill(parent.mkdir('l1').mkdir('l2').mkdir('l3').mkdir('l4'), 'deep', '42', 3);
    const r = await scanForAccounts(asDir(parent), { signal, maxDepth: 3 });
    expect(r.candidates).toEqual([]);
  });

  it('stops at the folder limit and says so', async () => {
    const parent = new FakeDir('root');
    for (let i = 0; i < 10; i++) fill(parent.mkdir(`d${i}`), `u${i}`, String(100 + i), 1);
    const r = await scanForAccounts(asDir(parent), { signal, maxDirs: 4 });
    expect(r.truncated).toBe(true);
    expect(r.dirsScanned).toBe(4);
  });

  it('ignores folders it cannot read', async () => {
    const parent = new FakeDir('root');
    fill(parent.mkdir('ok'), 'acct', '42', 2);
    parent.mkdir('gone').removed = true;
    const r = await scanForAccounts(asDir(parent), { signal });
    expect(r.candidates).toHaveLength(1);
  });

  it('rejects with AbortError when cancelled', async () => {
    const parent = new FakeDir('root');
    fill(parent.mkdir('a'), 'acct', '42', 2);
    const c = new AbortController();
    c.abort();
    await expect(scanForAccounts(asDir(parent), { signal: c.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
