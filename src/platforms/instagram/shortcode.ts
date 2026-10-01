const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Media pk encoded by a post shortcode. Private-profile shortcodes carry a 28-character suffix that is not part of the pk. */
export function shortcodeToId(shortcode: string): string {
  const code = shortcode.length > 28 ? shortcode.slice(0, shortcode.length - 28) : shortcode;
  let id = 0n;
  for (const ch of code) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid shortcode character "${ch}"`);
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}

export function idToShortcode(pk: string): string {
  let id = BigInt(pk);
  let out = '';
  while (id > 0n) {
    out = ALPHABET[Number(id % 64n)]! + out;
    id /= 64n;
  }
  return out;
}
