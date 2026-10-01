export type ProfileTab = 'posts' | 'reels' | 'tagged';

export type Route =
  | { kind: 'home' }
  | { kind: 'post'; shortcode: string }
  | { kind: 'profile'; username: string; tab: ProfileTab }
  | { kind: 'saved' }
  | { kind: 'explore' }
  | { kind: 'reels-feed'; shortcode: string | null }
  | { kind: 'story'; username: string; mediaId: string | null }
  | { kind: 'highlight'; highlightId: string }
  | { kind: 'other' };

const HOSTS = new Set(['www.instagram.com', 'instagram.com']);
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
const POST_SEGMENTS = new Set(['p', 'reel', 'tv']);
// First path segments that are site sections, not usernames.
const RESERVED = new Set([
  'about', 'accounts', 'api', 'ar', 'challenge', 'checkpoint', 'developer', 'direct', 'emails', 'explore',
  'graphql', 'legal', 'notifications', 'oauth', 'p', 'press', 'privacy', 'reel', 'reels', 'session', 'static',
  'stories', 'terms', 'tv', 'web', 'your_activity',
]);

/** Classifies an address. Trailing slashes, query strings and fragments do not matter. */
export function parseRoute(href: string): Route {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { kind: 'other' };
  }
  if (!HOSTS.has(url.hostname)) return { kind: 'other' };
  const seg = url.pathname.split('/').filter(Boolean);
  const [a, b, c] = seg;

  if (!a) return { kind: 'home' };
  if (POST_SEGMENTS.has(a)) return b ? { kind: 'post', shortcode: b } : { kind: 'other' };
  if (a === 'explore') return { kind: 'explore' };
  if (a === 'reels') return { kind: 'reels-feed', shortcode: b ?? null };
  if (a === 'stories') {
    if (b === 'highlights') return c ? { kind: 'highlight', highlightId: c } : { kind: 'other' };
    if (b && USERNAME.test(b)) return { kind: 'story', username: b, mediaId: c && /^\d+$/.test(c) ? c : null };
    return { kind: 'other' };
  }
  if (RESERVED.has(a) || !USERNAME.test(a)) return { kind: 'other' };

  if (!b) return { kind: 'profile', username: a, tab: 'posts' };
  if (POST_SEGMENTS.has(b)) return c ? { kind: 'post', shortcode: c } : { kind: 'other' };
  if (b === 'reels' && !c) return { kind: 'profile', username: a, tab: 'reels' };
  if (b === 'tagged' && !c) return { kind: 'profile', username: a, tab: 'tagged' };
  if (b === 'saved') return { kind: 'saved' };
  return { kind: 'other' };
}

export function profileUrl(username: string): string {
  return `https://www.instagram.com/${encodeURIComponent(username)}/`;
}

/**
 * Account names in pasted text with one profile address per line. The scheme may be
 * left out. Lines that are not a profile address come back untouched.
 */
export function profileNamesIn(text: string): { usernames: string[]; rejected: string[] } {
  const usernames = new Set<string>();
  const rejected: string[] = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const route = parseRoute(/^https?:\/\//i.test(line) ? line : `https://${line}`);
    if (route.kind === 'profile') usernames.add(route.username.toLowerCase());
    else rejected.push(line);
  }
  return { usernames: [...usernames], rejected };
}
