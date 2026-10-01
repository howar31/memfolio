import { describe, expect, it } from 'vitest';
import { buildFileIndex } from '../../src/core/file-index';
import { FakeDir, asDir } from '../helpers/fake-fs';

describe('buildFileIndex', () => {
  it('indexes files by media id regardless of username and timestamp in the name', async () => {
    const dir = new FakeDir('acct');
    dir.put('oldname_1561829105_111111111111_42.jpg');
    const index = await buildFileIndex(asDir(dir));
    expect(await index.has('111111111111_42')).toBe(true);
    expect(index.nameOf('111111111111_42')).toBe('oldname_1561829105_111111111111_42.jpg');
  });

  it('treats a zero-byte file as not downloaded but remembers its name', async () => {
    const dir = new FakeDir('acct');
    dir.put('u_1561829105_222222222222_42.mp4', 0);
    const index = await buildFileIndex(asDir(dir));
    expect(await index.has('222222222222_42')).toBe(false);
    expect(index.nameOf('222222222222_42')).toBe('u_1561829105_222222222222_42.mp4');
  });

  it('reports unknown ids as missing', async () => {
    const index = await buildFileIndex(asDir(new FakeDir('acct')));
    expect(await index.has('1_2')).toBe(false);
    expect(index.nameOf('1_2')).toBeNull();
  });

  it('counts only files that follow the naming scheme', async () => {
    const dir = new FakeDir('acct');
    dir.put('u_1561829105_111111111111_42.jpg');
    dir.put('u_1561829106_111111111112_42.jpg');
    dir.put('notes.txt');
    dir.put('u_1561829105_111111111111_42.jpg.error.txt');
    dir.mkdir('sub');
    const index = await buildFileIndex(asDir(dir));
    expect(index.matchedCount).toBe(2);
  });

  it('counts files per owner id', async () => {
    const dir = new FakeDir('person');
    dir.put('a_1561829105_111111111111_42.jpg');
    dir.put('a_1561829106_111111111112_42.jpg');
    dir.put('b_1561829107_111111111113_77.jpg');
    const index = await buildFileIndex(asDir(dir));
    expect(index.countForOwner('42')).toBe(2);
    expect(index.countForOwner('77')).toBe(1);
    expect(index.countForOwner('5')).toBe(0);
  });

  it('prefers a non-empty file when two files share a media id', async () => {
    const dir = new FakeDir('acct');
    dir.put('new_1561829106_111111111111_42.jpg', 0);
    dir.put('old_1561829105_111111111111_42.jpg', 9);
    const index = await buildFileIndex(asDir(dir));
    expect(await index.has('111111111111_42')).toBe(true);
  });

  it('marks an id as present after a download is recorded', async () => {
    const index = await buildFileIndex(asDir(new FakeDir('acct')));
    index.markDownloaded('9_8', 'x_1_9_8.jpg');
    expect(await index.has('9_8')).toBe(true);
    expect(index.matchedCount).toBe(1);
  });
});
