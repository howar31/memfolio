// Runs in the page's own JavaScript world. It answers a small set of questions
// that only that world can answer (the site's module registry and the data
// attached to DOM nodes) and changes nothing on the page.

import { RPC_TAG, type BridgeMethods, type BridgeSession, type RpcRequest, type RpcResponse } from './bridge-protocol';

type AnyRecord = Record<string, unknown>;
type RequireLazyFn = (names: string[], onReady: (...modules: unknown[]) => void) => void;

function pageRequireLazy(): RequireLazyFn | null {
  const r = (window as unknown as { requireLazy?: unknown }).requireLazy;
  return typeof r === 'function' ? (r as RequireLazyFn) : null;
}

// Modules are read through the loader's deferred form. It calls back once a
// module is defined and stays silent for a name the page has not loaded; the
// direct form reports such a name to the page's error handling. One request
// per name is left with the loader and reused.
const LOOKUP_WAIT_MS = 300;
const lookups = new Map<string, Promise<unknown>>();

function mod(name: string): Promise<AnyRecord | string | null> {
  let found = lookups.get(name);
  if (!found) {
    const lazy = pageRequireLazy();
    if (!lazy) return Promise.resolve(null);
    found = new Promise((resolve) => {
      try {
        lazy([name], (m) => resolve(m));
      } catch {
        // Stays unanswered, like an unknown name.
      }
    });
    lookups.set(name, found);
  }
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), LOOKUP_WAIT_MS));
  return Promise.race([found, timeout]).then((m) =>
    typeof m === 'string' || (typeof m === 'object' && m !== null) ? (m as AnyRecord | string) : null,
  );
}

async function objMod(name: string): Promise<AnyRecord | null> {
  const m = await mod(name);
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

async function relayEnvironment(): Promise<AnyRecord | null> {
  const m = await objMod('PolarisRelayEnvironment');
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
  async session(): Promise<BridgeSession> {
    const [config, dtsg, lsd, claim] = await Promise.all(['PolarisConfig', 'DTSGInitialData', 'LSD', 'PolarisWWWClaim'].map(objMod));
    return {
      appId: text(call(config ?? null, 'getIGAppID')),
      dtsg: text(dtsg?.token),
      lsd: text(lsd?.token),
      wwwClaim: text(call(claim ?? null, 'getWWWClaim')),
      hasRequire: pageRequireLazy() !== null,
    };
  },

  async docIds(names) {
    const ids = await Promise.all(names.map((name) => mod(`${name}_instagramRelayOperation`)));
    return Object.fromEntries(names.map((name, i) => [name, text(ids[i])]));
  },

  async findUserId(username) {
    const wanted = username.toLowerCase();
    try {
      const store = call(await relayEnvironment(), 'getStore') as AnyRecord | null;
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
    const [relay, env, loader] = await Promise.all([objMod('CometRelay'), relayEnvironment(), objMod('PolarisPostActionLoadPostQuery')]);
    const query = loader?.POST_QUERY;
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
