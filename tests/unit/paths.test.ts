import { describe, expect, it } from 'vitest';
import { cleanRelPath, cleanSegment } from '../../src/core/paths';

describe('cleanSegment', () => {
  it('keeps an ordinary name', () => {
    expect(cleanSegment('alice.b_1')).toBe('alice.b_1');
  });

  it('removes characters a file system refuses', () => {
    expect(cleanSegment('a<b>:"c|?*')).toBe('abc');
  });

  it('drops dots and spaces at both ends', () => {
    expect(cleanSegment(' ..name. ')).toBe('name');
  });

  it('marks a name Windows reserves for devices', () => {
    expect(cleanSegment('CON')).toBe('_CON');
    expect(cleanSegment('nul.txt')).toBe('_nul.txt');
    expect(cleanSegment('com1')).toBe('_com1');
    expect(cleanSegment('console')).toBe('console');
  });

  it('gives an empty string for a name with nothing left', () => {
    expect(cleanSegment('..')).toBe('');
    expect(cleanSegment(' ')).toBe('');
  });
});

describe('cleanRelPath', () => {
  it('accepts both separators and drops empty parts', () => {
    expect(cleanRelPath('/Memfolio\\friends//alice/')).toBe('Memfolio/friends/alice');
  });

  it('never leaves the folder it starts in', () => {
    expect(cleanRelPath('../a/./b/..')).toBe('a/b');
  });

  it('removes a drive prefix', () => {
    expect(cleanRelPath('c:\\photos\\alice')).toBe('c/photos/alice');
  });

  it('is empty for an empty input', () => {
    expect(cleanRelPath('  ')).toBe('');
  });
});
