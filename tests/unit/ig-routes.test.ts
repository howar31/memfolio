import { describe, expect, it } from 'vitest';
import { parseRoute, profileUrl } from '../../src/platforms/instagram/routes';
import { idToShortcode, shortcodeToId } from '../../src/platforms/instagram/shortcode';

const at = (path: string): ReturnType<typeof parseRoute> => parseRoute(`https://www.instagram.com${path}`);

describe('parseRoute', () => {
  it('recognises the home page', () => {
    expect(at('/')).toEqual({ kind: 'home' });
    expect(at('/?variant=following')).toEqual({ kind: 'home' });
  });

  it('recognises a profile with and without a trailing slash', () => {
    expect(at('/some.user_1/')).toEqual({ kind: 'profile', username: 'some.user_1', tab: 'posts' });
    expect(at('/some.user_1')).toEqual({ kind: 'profile', username: 'some.user_1', tab: 'posts' });
  });

  it('ignores share parameters and fragments on a profile', () => {
    expect(at('/someuser?igsh=abc123')).toEqual({ kind: 'profile', username: 'someuser', tab: 'posts' });
    expect(at('/someuser/?hl=zh-tw#x')).toEqual({ kind: 'profile', username: 'someuser', tab: 'posts' });
  });

  it('recognises the reels and tagged tabs of a profile', () => {
    expect(at('/someuser/reels/')).toEqual({ kind: 'profile', username: 'someuser', tab: 'reels' });
    expect(at('/someuser/tagged')).toEqual({ kind: 'profile', username: 'someuser', tab: 'tagged' });
  });

  it('recognises the saved tab separately', () => {
    expect(at('/someuser/saved/')).toEqual({ kind: 'saved' });
    expect(at('/someuser/saved/all-posts/')).toEqual({ kind: 'saved' });
  });

  it('recognises posts and reels in every URL form', () => {
    expect(at('/p/CuZ-abc_1/')).toEqual({ kind: 'post', shortcode: 'CuZ-abc_1' });
    expect(at('/p/CuZ-abc_1')).toEqual({ kind: 'post', shortcode: 'CuZ-abc_1' });
    expect(at('/reel/CuZ-abc_1/?igsh=x')).toEqual({ kind: 'post', shortcode: 'CuZ-abc_1' });
    expect(at('/someuser/p/CuZ-abc_1/')).toEqual({ kind: 'post', shortcode: 'CuZ-abc_1' });
    expect(at('/someuser/reel/CuZ-abc_1/')).toEqual({ kind: 'post', shortcode: 'CuZ-abc_1' });
    expect(at('/tv/CuZ-abc_1/')).toEqual({ kind: 'post', shortcode: 'CuZ-abc_1' });
    expect(at('/p/CuZ-abc_1/?img_index=3')).toEqual({ kind: 'post', shortcode: 'CuZ-abc_1' });
  });

  it('recognises the reels feed with and without a current reel', () => {
    expect(at('/reels/')).toEqual({ kind: 'reels-feed', shortcode: null });
    expect(at('/reels/CuZ-abc_1/')).toEqual({ kind: 'reels-feed', shortcode: 'CuZ-abc_1' });
  });

  it('recognises stories and highlights', () => {
    expect(at('/stories/someuser/')).toEqual({ kind: 'story', username: 'someuser', mediaId: null });
    expect(at('/stories/someuser/3141592653589793238/')).toEqual({
      kind: 'story',
      username: 'someuser',
      mediaId: '3141592653589793238',
    });
    expect(at('/stories/highlights/17912345678901234/')).toEqual({ kind: 'highlight', highlightId: '17912345678901234' });
  });

  it('recognises explore pages', () => {
    expect(at('/explore/')).toEqual({ kind: 'explore' });
    expect(at('/explore/tags/cats/')).toEqual({ kind: 'explore' });
  });

  it('does not mistake reserved paths for profiles', () => {
    for (const p of ['/direct/inbox/', '/direct/', '/accounts/edit/', '/reels', '/explore', '/about/', '/graphql/query']) {
      expect(at(p).kind).not.toBe('profile');
    }
  });

  it('treats other profile sub-pages as not downloadable', () => {
    expect(at('/someuser/followers/')).toEqual({ kind: 'other' });
  });

  it('rejects other hosts and malformed input', () => {
    expect(parseRoute('https://example.com/someuser/')).toEqual({ kind: 'other' });
    expect(parseRoute('not a url')).toEqual({ kind: 'other' });
  });
});

describe('profileUrl', () => {
  it('builds the profile address for a username', () => {
    expect(profileUrl('some.user_1')).toBe('https://www.instagram.com/some.user_1/');
  });
});

describe('shortcode conversion', () => {
  it('converts between a media pk and its shortcode', () => {
    // 64-based alphabet A-Z a-z 0-9 - _ ; "B" is 1, "BA" is 64.
    expect(shortcodeToId('B')).toBe('1');
    expect(shortcodeToId('BA')).toBe('64');
    expect(idToShortcode('64')).toBe('BA');
  });

  it('round-trips a 64-bit pk', () => {
    const pk = '3141592653589793238';
    expect(shortcodeToId(idToShortcode(pk))).toBe(pk);
  });

  it('ignores the 28-character suffix of private-profile shortcodes', () => {
    const base = idToShortcode('3141592653589793238');
    expect(shortcodeToId(base + 'x'.repeat(28))).toBe('3141592653589793238');
  });
});
