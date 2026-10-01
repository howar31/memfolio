import { describe, expect, it } from 'vitest';
import { extFromUrl, fileNameFor, parseFileName } from '../../src/core/naming';
import type { MediaItem } from '../../src/core/types';

const item = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: '3141592653589793238_1234567',
  pk: '3141592653589793238',
  ownerId: '1234567',
  ownerUsername: 'some.user_01',
  takenAt: 1561829106,
  kind: 'image',
  url: 'https://scontent.cdninstagram.com/v/t51.2885-15/123_456_n.jpg?stp=dst-jpg_e35&_nc_ht=x',
  shortcode: 'CuZ',
  ...over,
});

describe('extFromUrl', () => {
  it('takes the extension from the URL path, ignoring the query string', () => {
    expect(extFromUrl('https://x.fbcdn.net/v/t51.2885-15/1_n.jpg?stp=a.b&x=1', 'image')).toBe('jpg');
  });

  it('reads a video extension', () => {
    expect(extFromUrl('https://x.fbcdn.net/o1/v/t16/f2/m86/AQ.mp4?efg=abc', 'video')).toBe('mp4');
  });

  it('lower-cases the extension', () => {
    expect(extFromUrl('https://x.fbcdn.net/a/B.WEBP', 'image')).toBe('webp');
  });

  it('falls back to the media kind when the path has no extension', () => {
    expect(extFromUrl('https://x.fbcdn.net/a/b?file=c.png', 'image')).toBe('jpg');
    expect(extFromUrl('https://x.fbcdn.net/a/b', 'video')).toBe('mp4');
  });
});

describe('fileNameFor', () => {
  it('builds <username>_<takenAt>_<pk>_<ownerId>.<ext>', () => {
    expect(fileNameFor(item())).toBe('some.user_01_1561829106_3141592653589793238_1234567.jpg');
  });

  it('removes characters that are invalid in Windows file names', () => {
    expect(fileNameFor(item({ ownerUsername: 'a<b>c:d"e/f\\g|h?i*j' }))).toBe(
      'abcdefghij_1561829106_3141592653589793238_1234567.jpg',
    );
  });
});

describe('parseFileName', () => {
  it('parses a name produced by fileNameFor', () => {
    expect(parseFileName(fileNameFor(item()))).toEqual({
      username: 'some.user_01',
      takenAt: 1561829106,
      pk: '3141592653589793238',
      ownerId: '1234567',
      id: '3141592653589793238_1234567',
      ext: 'jpg',
    });
  });

  it('keeps digits and underscores that belong to the username', () => {
    const parsed = parseFileName('user_2024_99_1561829106_3141592653589793238_1234567.mp4');
    expect(parsed?.username).toBe('user_2024_99');
    expect(parsed?.id).toBe('3141592653589793238_1234567');
  });

  it('rejects names without an owner id segment', () => {
    expect(parseFileName('someuser_1561829106_3141592653589793238.jpg')).toBeNull();
  });

  it('rejects error reports and unrelated files', () => {
    expect(parseFileName('u_1561829106_3141592653589793238_1234567.jpg.error.txt')).toBeNull();
    expect(parseFileName('desktop.ini')).toBeNull();
    expect(parseFileName('u_1561829106_3141592653589793238_1234567.jpg.crswap')).toBeNull();
  });
});
