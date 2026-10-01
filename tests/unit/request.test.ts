import { describe, expect, it } from 'vitest';
import { RequestGate, requestJson, type BudgetStore, type RetryPolicy } from '../../src/core/request';
import { StopError } from '../../src/core/types';

const policy: RetryPolicy = {
  maxRetries: 6,
  backoff: { baseMs: 30_000, capMs: 600_000, jitterRatio: 0 },
  retryAfterCapMs: 900_000,
};

interface FakeResponseInit {
  status?: number;
  body?: string;
  url?: string;
  redirected?: boolean;
  headers?: Record<string, string>;
}

function res(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: init.redirected ?? false,
    url: init.url ?? 'https://www.instagram.com/graphql/query',
    headers: new Headers(init.headers ?? {}),
    text: async () => init.body ?? '{}',
  } as unknown as Response;
}

function harness(responses: Array<Response | Error>) {
  const slept: number[] = [];
  const retries: number[] = [];
  let calls = 0;
  const run = (signal = new AbortController().signal) =>
    requestJson(
      async () => {
        const next = responses[Math.min(calls, responses.length - 1)]!;
        calls += 1;
        if (next instanceof Error) throw next;
        return next;
      },
      policy,
      {
        sleep: async (ms) => {
          slept.push(ms);
        },
        rng: () => 0.5,
        onRetry: (info) => retries.push(info.attempt),
      },
      signal,
    );
  return { run, slept, retries, calls: () => calls };
}

async function stopReason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof StopError) return e.reason;
    throw e;
  }
  throw new Error('expected a StopError');
}

describe('requestJson', () => {
  it('returns the parsed body of a successful response', async () => {
    const h = harness([res({ body: '{"data":{"x":1}}' })]);
    expect(await h.run()).toEqual({ data: { x: 1 } });
    expect(h.calls()).toBe(1);
  });

  it('retries 429 with doubling delays and then succeeds', async () => {
    const h = harness([res({ status: 429 }), res({ status: 429 }), res({ body: '{"ok":true}' })]);
    expect(await h.run()).toEqual({ ok: true });
    expect(h.slept).toEqual([30_000, 60_000]);
    expect(h.retries).toEqual([1, 2]);
  });

  it('retries server errors', async () => {
    const h = harness([res({ status: 502 }), res({ body: '{}' })]);
    await h.run();
    expect(h.calls()).toBe(2);
  });

  it('prefers Retry-After over the computed delay and caps it', async () => {
    const h = harness([
      res({ status: 429, headers: { 'retry-after': '90' } }),
      res({ status: 429, headers: { 'retry-after': '99999' } }),
      res({ body: '{}' }),
    ]);
    await h.run();
    expect(h.slept).toEqual([90_000, 900_000]);
  });

  it('stops as rate-limited after the retry limit', async () => {
    const h = harness([res({ status: 429 })]);
    expect(await stopReason(h.run())).toBe('rate-limited');
    expect(h.calls()).toBe(7);
    expect(h.slept).toHaveLength(6);
  });

  it('does not retry other client errors', async () => {
    const h = harness([res({ status: 404 })]);
    expect(await stopReason(h.run())).toBe('http');
    expect(h.calls()).toBe(1);
  });

  it('stops without retry when redirected to the login page', async () => {
    const h = harness([res({ redirected: true, url: 'https://www.instagram.com/accounts/login/?next=%2F', body: '<html>' })]);
    expect(await stopReason(h.run())).toBe('login');
    expect(h.calls()).toBe(1);
  });

  it('stops without retry on a challenge or checkpoint redirect', async () => {
    for (const path of ['/challenge/?next=/', '/checkpoint/123/', '/accounts/suspended/']) {
      const h = harness([res({ redirected: true, url: `https://www.instagram.com${path}`, body: '<html>' })]);
      expect(await stopReason(h.run())).toBe('challenge');
    }
  });

  it('reports a login requirement sent as JSON', async () => {
    const h = harness([res({ status: 401, body: '{"message":"Please wait","require_login":true}' })]);
    expect(await stopReason(h.run())).toBe('login');
  });

  it('stops on a body that is not JSON', async () => {
    const h = harness([res({ body: '<!DOCTYPE html><html></html>' })]);
    expect(await stopReason(h.run())).toBe('bad-response');
  });

  it('stops on a network failure', async () => {
    const h = harness([new TypeError('Failed to fetch')]);
    expect(await stopReason(h.run())).toBe('network');
  });

  it('propagates cancellation instead of converting it', async () => {
    const c = new AbortController();
    c.abort();
    const h = harness([new DOMException('Aborted', 'AbortError')]);
    await expect(h.run(c.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('RequestGate', () => {
  function gate(budget: number, stored: number[] = []) {
    let now = 1_000_000;
    const slept: number[] = [];
    const store: BudgetStore = {
      load: async () => stored,
      save: async (ts) => {
        stored = ts;
      },
    };
    const g = new RequestGate({ minGapMs: [1500, 3000], hourlyBudget: budget }, store, {
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
      rng: () => 0,
      now: () => now,
    });
    return { g, slept, stored: () => stored, advance: (ms: number) => (now += ms) };
  }

  it('lets the first request through without waiting', async () => {
    const t = gate(10);
    await t.g.pass(new AbortController().signal);
    expect(t.slept).toEqual([]);
    expect(t.stored()).toHaveLength(1);
  });

  it('spaces consecutive requests by the configured gap', async () => {
    const t = gate(10);
    const s = new AbortController().signal;
    await t.g.pass(s);
    await t.g.pass(s);
    expect(t.slept).toEqual([1500]);
  });

  it('waits only for the remaining part of the gap', async () => {
    const t = gate(10);
    const s = new AbortController().signal;
    await t.g.pass(s);
    t.advance(1000);
    await t.g.pass(s);
    expect(t.slept).toEqual([500]);
  });

  it('stops when the hourly budget is used up', async () => {
    const t = gate(2, [999_000, 999_500]);
    await expect(t.g.pass(new AbortController().signal)).rejects.toMatchObject({ reason: 'budget' });
  });

  it('forgets requests older than one hour', async () => {
    const t = gate(1, [1_000_000 - 3_600_001]);
    await t.g.pass(new AbortController().signal);
    expect(t.stored()).toEqual([1_000_000]);
  });
});
