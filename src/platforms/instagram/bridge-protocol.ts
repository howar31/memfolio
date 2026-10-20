// Messages between the isolated content script and the page-world bridge.
// The bridge only returns data the page itself already holds.

export const RPC_TAG = '__memfolio_rpc__';

export interface BridgeSession {
  appId: string | null;
  dtsg: string | null;
  lsd: string | null;
  wwwClaim: string | null;
  hasRequire: boolean;
}

/** Outcome of a query run through the page's own network layer. */
export type PageQueryResult =
  | { status: 'ok'; body: unknown }
  /** The platform answered with a GraphQL error. */
  | { status: 'graphql'; message: string }
  /** The page offers no network layer; nothing was sent. */
  | { status: 'unavailable' }
  /** The request failed in another way, after it may have been sent. */
  | { status: 'failed'; message: string };

export interface BridgeMethods {
  session(): Promise<BridgeSession>;
  /** Ids of persisted queries by friendly name; null for names the page does not know. */
  docIds(names: string[]): Promise<Record<string, string | null>>;
  /** Flags the page's query definitions declare, with their current values; null for definitions the page has not loaded. */
  providedVariables(names: string[]): Promise<Record<string, Record<string, unknown> | null>>;
  /** Runs a persisted query through the page's own network layer, which adds the fields the site sends. */
  pageQuery(name: string, docId: string, variables: Record<string, unknown>): Promise<PageQueryResult>;
  /** Numeric id of a user found in data the page has already loaded. */
  findUserId(username: string): Promise<string | null>;
  /** The page's own post loader (older response shape). */
  relayPost(shortcode: string): Promise<unknown | null>;
  /** Media pk attached to the element carrying `data-memfolio-probe="<token>"`. */
  probeMediaId(token: string): string | null;
  /**
   * For each element matching `selector`, in document order: whether the page's
   * UI framework has taken it over. Server-rendered markup must not be modified
   * before that, or the framework discards and rebuilds it.
   */
  hydrated(selector: string): boolean[];
}

export type BridgeMethod = keyof BridgeMethods;

export interface RpcRequest {
  [RPC_TAG]: true;
  method: BridgeMethod;
  params: unknown[];
}

export type RpcResponse = { ok: true; value: unknown } | { ok: false; error: string };
