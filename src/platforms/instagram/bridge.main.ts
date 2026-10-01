// Runs in the page's own JavaScript world. It answers a small set of questions
// that only that world can answer (the site's module registry and the data
// attached to DOM nodes) and changes nothing on the page.

import { RPC_TAG, type BridgeMethods, type BridgeSession, type RpcRequest, type RpcResponse } from './bridge-protocol';

type AnyRecord = Record<string, unknown>;
type RequireFn = (name: string) => unknown;

function pageRequire(): RequireFn | null {
  const r = (window as unknown as { require?: unknown }).require;
  return typeof r === 'function' ? (r as RequireFn) : null;
}

function mod(name: string): AnyRecord | string | null {
  const req = pageRequire();
  if (!req) return null;
  try {
    const m = req(name);
    return typeof m === 'string' || (typeof m === 'object' && m !== null) ? (m as AnyRecord | string) : null;
  } catch {
    return null;
  }
}

function objMod(name: string): AnyRecord | null {
  const m = mod(name);
  return typeof m === 'object' ? m : null;
}

function call(target: AnyRecord | null, method: string): unknown {
  const fn = target?.[method];
  try {
    return typeof fn === 'function' ? (fn as () => unknown).call(target) : null;
  } catch {
    return null;
  }
}

function text(v: unknown): string | null {
  if (typeof v === 'string' && v) return v;
  if (typeof v === 'number') return String(v);
  return null;
}

const NUMERIC = /^\d+$/;

function relayEnvironment(): AnyRecord | null {
  const m = objMod('PolarisRelayEnvironment');
  if (!m) return null;
  if (typeof m.getStore === 'function') return m;
  const d = m.default;
  return typeof d === 'object' && d !== null && typeof (d as AnyRecord).getStore === 'function' ? (d as AnyRecord) : null;
}

function fiberOf(el: Element): AnyRecord | null {
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactFiber$')) return (el as unknown as AnyRecord)[key] as AnyRecord;
  }
  return null;
}

function mediaPkFromProps(props: unknown): string | null {
  if (typeof props !== 'object' || props === null) return null;
  const p = props as AnyRecord;
  const nested = (o: unknown, k: string): unknown => (typeof o === 'object' && o !== null ? (o as AnyRecord)[k] : undefined);
  const candidates = [
    nested(p.post, 'pk'),
    nested(p.post, 'id'),
    nested(p.media, 'pk'),
    nested(p.media, 'id'),
    p.postId,
    p.mediaId,
    p.id,
  ];
  for (const c of candidates) {
    const s = text(c)?.split('_')[0];
    // Media pks are long numbers; short ones are unrelated component ids.
    if (s && NUMERIC.test(s) && s.length >= 15) return s;
  }
  return null;
}

const methods: BridgeMethods = {
  session(): BridgeSession {
    return {
      appId: text(call(objMod('PolarisConfig'), 'getIGAppID')),
      dtsg: text(objMod('DTSGInitialData')?.token),
      lsd: text(objMod('LSD')?.token),
      wwwClaim: text(call(objMod('PolarisWWWClaim'), 'getWWWClaim')),
      hasRequire: pageRequire() !== null,
    };
  },

  docIds(names) {
    const out: Record<string, string | null> = {};
    for (const name of names) out[name] = text(mod(`${name}_instagramRelayOperation`));
    return out;
  },

  findUserId(username) {
    const wanted = username.toLowerCase();
    try {
      const store = call(relayEnvironment(), 'getStore') as AnyRecord | null;
      const source = call(store, 'getSource') as AnyRecord | null;
      const ids = call(source, 'getRecordIDs');
      if (!source || !Array.isArray(ids) || typeof source.get !== 'function') return null;
      for (const recordId of ids) {
        const rec = (source.get as (id: unknown) => unknown).call(source, recordId) as AnyRecord | null | undefined;
        if (!rec || typeof rec.username !== 'string' || rec.username.toLowerCase() !== wanted) continue;
        // `pk` is the account id. `id` on the same record is a different, app-scoped number.
        const pk = text(rec.pk);
        if (pk && NUMERIC.test(pk)) return pk;
      }
    } catch {
      // The store layout changed; the caller falls back to other sources.
    }
    return null;
  },

  async relayPost(shortcode) {
    const relay = objMod('CometRelay');
    const env = relayEnvironment();
    const query = objMod('PolarisPostActionLoadPostQuery')?.POST_QUERY;
    if (!relay || !env || !query || typeof relay.fetchQuery !== 'function') return null;
    const observable = (relay.fetchQuery as (...a: unknown[]) => AnyRecord)(env, query, {
      shortcode,
      child_comment_count: 3,
      fetch_comment_count: 40,
      has_threaded_comments: true,
      parent_comment_count: 24,
    });
    const result = (await (observable.toPromise as () => Promise<unknown>).call(observable)) as AnyRecord | null;
    const media = result?.xdt_shortcode_media as AnyRecord | undefined;
    const fragments = media?.__fragments as AnyRecord | undefined;
    const inline =
      fragments?.PolarisPostActionLoadPostQueryInlineFragment ??
      fragments?.PolarisPostActionLoadPostQueryInlineFragmentWithoutRelatedProfiles ??
      media;
    // Strip anything that cannot be cloned across the message port.
    return inline ? JSON.parse(JSON.stringify(inline)) : null;
  },

  probeMediaId(token) {
    const el = document.querySelector(`[data-memfolio-probe="${CSS.escape(token)}"]`);
    if (!el) return null;
    let fiber = fiberOf(el);
    for (let depth = 0; fiber && depth < 25; depth++) {
      const pk = mediaPkFromProps(fiber.memoizedProps);
      if (pk) return pk;
      const key = text(fiber.key);
      if (key && /^\d{15,}(_\d+)?$/.test(key)) return key.split('_')[0]!;
      fiber = (fiber.return as AnyRecord | null) ?? null;
    }
    return null;
  },

  hydrated(selector) {
    return [...document.querySelectorAll(selector)].map((el) => fiberOf(el) !== null);
  },
};

window.addEventListener('message', (ev: MessageEvent) => {
  if (ev.source !== window || ev.origin !== location.origin) return;
  const data = ev.data as Partial<RpcRequest> | null;
  const port = ev.ports[0];
  if (!data || data[RPC_TAG] !== true || !port || typeof data.method !== 'string') return;
  const method = methods[data.method] as ((...a: unknown[]) => unknown) | undefined;
  const reply = (r: RpcResponse): void => port.postMessage(r);
  if (!method) {
    reply({ ok: false, error: `unknown method ${data.method}` });
    return;
  }
  Promise.resolve()
    .then(() => method(...(Array.isArray(data.params) ? data.params : [])))
    .then(
      (value) => reply({ ok: true, value }),
      (e) => reply({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
});
