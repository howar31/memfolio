import { backoffDelay, parseRetryAfter, type BackoffPolicy, type Rng } from './pacing';
import { StopError, isAbortError } from './types';

export interface RetryPolicy {
  /** Retries after the first attempt, for 429 and 5xx only. */
  maxRetries: number;
  backoff: BackoffPolicy;
  /** Upper bound applied to a server-provided Retry-After. */
  retryAfterCapMs: number;
}

export interface RetryInfo {
  status: number;
  /** 1-based retry number. */
  attempt: number;
  max: number;
  delayMs: number;
}

export interface RequestHooks {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  rng: Rng;
  onRetry?(info: RetryInfo): void;
}

const LOGIN_PATH = /^\/accounts\/login/;
const CHALLENGE_PATH = /^\/(challenge|checkpoint|accounts\/suspended)/;

function classifyRedirect(res: Response): StopError | null {
  if (!res.redirected || !res.url) return null;
  let path: string;
  try {
    path = new URL(res.url).pathname;
  } catch {
    return null;
  }
  if (LOGIN_PATH.test(path)) return new StopError('login', 'redirected to the login page');
  if (CHALLENGE_PATH.test(path)) return new StopError('challenge', `redirected to ${path}`);
  return null;
}

/**
 * Sends a platform API request and returns its JSON body.
 * 429 and 5xx are retried with backoff; every other failure raises StopError
 * so the caller stops talking to the platform instead of trying again.
 */
export async function requestJson(
  send: (signal: AbortSignal) => Promise<Response>,
  policy: RetryPolicy,
  hooks: RequestHooks,
  signal: AbortSignal,
): Promise<unknown> {
  for (let retries = 0; ; retries++) {
    let res: Response;
    try {
      res = await send(signal);
    } catch (e) {
      if (isAbortError(e) || signal.aborted) throw e;
      throw new StopError('network', e instanceof Error ? e.message : String(e));
    }

    const redirect = classifyRedirect(res);
    if (redirect) throw redirect;

    if (res.status === 429 || res.status >= 500) {
      if (retries >= policy.maxRetries) throw new StopError('rate-limited', `HTTP ${res.status}`);
      const asked = parseRetryAfter(res.headers.get('retry-after'));
      const delayMs =
        asked !== null ? Math.min(asked, policy.retryAfterCapMs) : backoffDelay(retries, policy.backoff, hooks.rng);
      hooks.onRetry?.({ status: res.status, attempt: retries + 1, max: policy.maxRetries, delayMs });
      await hooks.sleep(delayMs, signal);
      continue;
    }

    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }

    if (!res.ok) {
      if ((body as { require_login?: boolean } | undefined)?.require_login) {
        throw new StopError('login', 'the platform asks to log in');
      }
      throw new StopError('http', `HTTP ${res.status}`);
    }
    if (body === undefined) {
      // A 200 that is not JSON is the platform's HTML shell, typically after a silent redirect.
      throw new StopError('bad-response', res.redirected ? `redirected to ${res.url}` : 'response is not JSON');
    }
    return body;
  }
}

export interface GateConfig {
  /** Minimum spacing between two API requests, picked uniformly from this range. */
  minGapMs: [number, number];
  /** API requests allowed per rolling hour. */
  hourlyBudget: number;
}

export interface BudgetStore {
  load(): Promise<number[]>;
  save(timestamps: number[]): Promise<void>;
}

export interface GateHooks {
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  rng: Rng;
  now(): number;
}

const HOUR_MS = 3_600_000;

/** Spaces API requests and enforces the hourly budget. One instance per page. */
export class RequestGate {
  private lastAt = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private cfg: GateConfig,
    private store: BudgetStore,
    private hooks: GateHooks,
  ) {}

  /** Resolves when the next request may be sent. Calls are served one at a time. */
  pass(signal: AbortSignal): Promise<void> {
    const run = this.chain.then(
      () => this.passNow(signal),
      () => this.passNow(signal),
    );
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async passNow(signal: AbortSignal): Promise<void> {
    const recent = (await this.store.load()).filter((t) => this.hooks.now() - t < HOUR_MS);
    if (recent.length >= this.cfg.hourlyBudget) {
      throw new StopError('budget', `hourly request budget of ${this.cfg.hourlyBudget} is used up`);
    }
    if (this.lastAt > 0) {
      const [min, max] = this.cfg.minGapMs;
      const gap = Math.round(min + (max - min) * this.hooks.rng());
      const wait = this.lastAt + gap - this.hooks.now();
      if (wait > 0) await this.hooks.sleep(wait, signal);
    }
    this.lastAt = this.hooks.now();
    recent.push(this.lastAt);
    await this.store.save(recent);
  }
}
