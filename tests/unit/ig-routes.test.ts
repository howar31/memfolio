import { describe, expect, it } from 'vitest';
import { parseRoute, profileNamesIn, profileUrl } from '../../src/platforms/instagram/routes';
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

describe('profileNamesIn', () => {
  const plain = (...usernames: string[]) => usernames.map((username) => ({ username, group: null, pinned: false }));

  it('takes one profile address per line, whatever tab or query it carries', () => {
    const text = [
      'https://www.instagram.com/first.user/',
      'https://instagram.com/second_user',
      'https://www.instagram.com/third/reels/',
      'https://www.instagram.com/fourth/tagged/?hl=en#top',
    ].join('\n');
    expect(profileNamesIn(text)).toEqual({ entries: plain('first.user', 'second_user', 'third', 'fourth'), groups: [], rejected: [] });
  });

  it('accepts an address without the scheme', () => {
    expect(profileNamesIn('www.instagram.com/some.user/\ninstagram.com/other').entries).toEqual(plain('some.user', 'other'));
  });

  it('ignores blank lines and surrounding spaces', () => {
    expect(profileNamesIn('\n  https://www.instagram.com/some.user/  \r\n\n')).toEqual({ entries: plain('some.user'), groups: [], rejected: [] });
  });

  it('names an account once, in lower case', () => {
    const text = 'https://www.instagram.com/Some.User/\nhttps://www.instagram.com/some.user/reels/';
    expect(profileNamesIn(text).entries).toEqual(plain('some.user'));
  });

  it('hands back the lines that are not a profile address', () => {
    const text = [
      'https://www.instagram.com/p/ABC123/',
      'https://www.instagram.com/some.user/',
      'https://www.instagram.com/stories/some.user/123/',
      'https://example.com/some.user/',
      'some.user',
      'https://www.instagram.com/explore/',
    ].join('\n');
    expect(profileNamesIn(text)).toEqual({
      entries: plain('some.user'),
      groups: [],
      rejected: [
        'https://www.instagram.com/p/ABC123/',
        'https://www.instagram.com/stories/some.user/123/',
        'https://example.com/some.user/',
        'some.user',
        'https://www.instagram.com/explore/',
      ],
    });
  });

  it('reads a line that starts with # as the group of the addresses below it', () => {
    const text = [
      'https://www.instagram.com/loose/',
      '# [pinned]',
      'https://www.instagram.com/top/',
      '#First group',
      'https://www.instagram.com/one/',
      'https://www.instagram.com/two/',
      '#   Empty  ',
      '# [ungrouped]',
      'https://www.instagram.com/rest/',
      '#',
      'https://www.instagram.com/more/',
    ].join('\n');
    expect(profileNamesIn(text)).toEqual({
      entries: [
        { username: 'loose', group: null, pinned: false },
        { username: 'top', group: null, pinned: true },
        { username: 'one', group: 'First group', pinned: false },
        { username: 'two', group: 'First group', pinned: false },
        { username: 'rest', group: null, pinned: false },
        { username: 'more', group: null, pinned: false },
      ],
      groups: ['First group', 'Empty'],
      rejected: [],
    });
  });

  it('keeps the first place of an account named under two headings', () => {
    const text = '# A\nhttps://www.instagram.com/one/\n# B\nhttps://www.instagram.com/one/';
    expect(profileNamesIn(text)).toEqual({ entries: [{ username: 'one', group: 'A', pinned: false }], groups: ['A', 'B'], rejected: [] });
  });
});
