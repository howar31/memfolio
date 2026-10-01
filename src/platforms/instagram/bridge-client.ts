import { RPC_TAG, type BridgeMethod, type BridgeMethods, type BridgeSession, type RpcRequest, type RpcResponse } from './bridge-protocol';

const DEFAULT_TIMEOUT_MS = 3000;

function rpc<M extends BridgeMethod>(
  method: M,
  params: Parameters<BridgeMethods[M]>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Awaited<ReturnType<BridgeMethods[M]>>> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error(`page bridge did not answer "${method}"`));
    }, timeoutMs);
    channel.port1.onmessage = (ev: MessageEvent<RpcResponse>) => {
      clearTimeout(timer);
      channel.port1.close();
      if (ev.data.ok) resolve(ev.data.value as Awaited<ReturnType<BridgeMethods[M]>>);
      else reject(new Error(ev.data.error));
    };
    const message: RpcRequest = { [RPC_TAG]: true, method, params };
    window.postMessage(message, location.origin, [channel.port2]);
  });
}

const EMPTY_SESSION: BridgeSession = { appId: null, dtsg: null, lsd: null, wwwClaim: null, hasRequire: false };

/** Isolated-world access to the page bridge. Every call degrades to "unknown" when the bridge is silent. */
export const bridge = {
  session: (): Promise<BridgeSession> => rpc('session', []).catch(() => EMPTY_SESSION),

  async docIds(names: string[]): Promise<Record<string, string | null>> {
    return rpc('docIds', [names]).catch(() => ({}));
  },

  findUserId: (username: string): Promise<string | null> => rpc('findUserId', [username]).catch(() => null),

  relayPost: (shortcode: string): Promise<unknown | null> => rpc('relayPost', [shortcode], 15_000).catch(() => null),

  hydrated: (selector: string): Promise<boolean[]> => rpc('hydrated', [selector]).catch(() => []),

  /** Asks the page which media an element shows. The marker attribute exists only for the duration of the call. */
  async probeMediaId(el: Element): Promise<string | null> {
    const token = Math.random().toString(36).slice(2);
    el.setAttribute('data-memfolio-probe', token);
    try {
      return await rpc('probeMediaId', [token]).catch(() => null);
    } finally {
      el.removeAttribute('data-memfolio-probe');
    }
  },
};
