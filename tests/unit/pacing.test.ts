import { describe, expect, it } from 'vitest';
import { backoffDelay, jitter, parseRetryAfter, sleep } from '../../src/core/pacing';

describe('jitter', () => {
  it('returns a value inside the range for the extremes of the random source', () => {
    expect(jitter(1500, 3000, () => 0)).toBe(1500);
    expect(jitter(1500, 3000, () => 0.999999)).toBeLessThanOrEqual(3000);
    expect(jitter(1500, 3000, () => 0.5)).toBe(2250);
  });
});

describe('backoffDelay', () => {
  const policy = { baseMs: 30_000, capMs: 600_000, jitterRatio: 0 };

  it('doubles from the base and stops at the cap', () => {
    const delays = [0, 1, 2, 3, 4, 5].map((n) => backoffDelay(n, policy, () => 0.5));
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000]);
  });

  it('adds a random share on top when jitter is configured', () => {
    const d = backoffDelay(0, { ...policy, jitterRatio: 0.2 }, () => 1);
    expect(d).toBe(36_000);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta seconds', () => {
    expect(parseRetryAfter('120', 0)).toBe(120_000);
  });

  it('reads an HTTP date relative to now', () => {
    const now = Date.parse('2026-09-30T00:00:00Z');
    expect(parseRetryAfter('Wed, 30 Sep 2026 00:01:00 GMT', now)).toBe(60_000);
  });

  it('returns null for a missing or unusable value', () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter('-5', 0)).toBeNull();
  });
});

describe('sleep', () => {
  it('rejects with AbortError when the signal fires first', async () => {
    const c = new AbortController();
    const p = sleep(60_000, c.signal);
    c.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects immediately for an already aborted signal', async () => {
    const c = new AbortController();
    c.abort();
    await expect(sleep(1, c.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resolves after the delay', async () => {
    await expect(sleep(1, new AbortController().signal)).resolves.toBeUndefined();
  });
});
