import { describe, expect, it } from 'vitest';
import { indexFromList } from '../../src/core/listed-index';

function file(path: string, size = 10): { name: string; size: number; webkitRelativePath: string } {
  return { name: path.slice(path.lastIndexOf('/') + 1), size, webkitRelativePath: path };
}

const A1 = 'alice_1700000000_11111_42.jpg';
const A2 = 'alice_1700000500_11112_42.mp4';
const B1 = 'bob_1700000100_22222_77.jpg';

describe('indexFromList', () => {
  it('knows the media whose files are in the picked folder', async () => {
    const { root, index } = indexFromList([file(`alice/${A1}`), file(`alice/${B1}`), file('alice/notes.txt')]);
    expect(root).toBe('alice');
    expect(await index.has('11111_42')).toBe(true);
    expect(await index.has('22222_77')).toBe(true);
    expect(await index.has('11112_42')).toBe(false);
    expect(index.matchedCount).toBe(2);
    expect(index.countForOwner('42')).toBe(1);
  });

  it('leaves out files of subfolders', async () => {
    const { index } = indexFromList([file(`alice/${A1}`), file(`alice/old/${A2}`)]);
    expect(await index.has('11112_42')).toBe(false);
    expect(index.matchedCount).toBe(1);
  });

  it('takes an empty file for a missing one', async () => {
    const { index } = indexFromList([file(`alice/${A1}`, 0)]);
    expect(await index.has('11111_42')).toBe(false);
    expect(index.matchedCount).toBe(0);
  });

  it('gives an empty index and no name for an empty list', () => {
    const { root, index } = indexFromList([]);
    expect(root).toBe('');
    expect(index.matchedCount).toBe(0);
  });
});
