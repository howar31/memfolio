export type Rng = () => number;

export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
  /** Extra random share added on top of the delay, 0..1. */
  jitterRatio: number;
}

/** Uniform value in [min, max]. */
export function jitter(min: number, max: number, rng: Rng = Math.random): number {
  return Math.round(min + (max - min) * rng());
}

/** Exponential delay for the given zero-based attempt, capped, plus optional jitter. */
export function backoffDelay(attempt: number, policy: BackoffPolicy, rng: Rng = Math.random): number {
  const base = Math.min(policy.baseMs * 2 ** attempt, policy.capMs);
  return Math.round(base + base * policy.jitterRatio * rng());
}

/** Milliseconds requested by a Retry-After header, or null when absent or unusable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // An HTTP-date always names the weekday and month; V8 would otherwise accept strings like "-5".
  if (!/[a-z]{3}/i.test(trimmed) || !/\d{4}/.test(trimmed)) return null;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  return delta >= 0 ? delta : null;
}

export function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
