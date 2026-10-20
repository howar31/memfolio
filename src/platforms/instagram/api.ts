import { requestJson, type RequestGate, type RequestHooks, type RetryPolicy } from '../../core/request';
import { StopError, type ListingPage, type ListingSource, type MediaItem } from '../../core/types';
import type { PageQueryResult } from './bridge-protocol';
import { legacyMediaFromShortcodeMedia, mediaFromNode, reelFromListingNode } from './parse';
import { shortcodeToId } from './shortcode';

type Json = Record<string, unknown>;

export const ORIGIN = 'https://www.instagram.com';
/**
 * Entries asked per listing page: the most each query answered, and what the
 * site's own page asks (used when the larger size is refused).
 */
const PAGE_SIZES = {
  posts: { max: 33, site: 12 },
  reels: { max: 12, site: 3 },
  tagged: { max: 21, site: 12 },
};

/**
 * Persisted queries of the web client, by their "friendly name". The id of a
 * query is read from the page at run time (the site rotates ids); `fallbackId`
 * is the last observed value and is used only when the page has none.
 * A query is sent through the page's own network layer, which adds whatever
 * fields and headers the site currently expects. When the page cannot send
 * it, the request is built here with the web client's session fields; the
 * site answers one without them with its home page.
 */
interface QueryDef {
  fallbackId: string | null;
}

const QUERIES = {
  PolarisProfilePostsTabContentQuery_connection: { fallbackId: '29298961806354817' },
  PolarisProfileReelsTabContentQuery_connection: { fallbackId: null },
  PolarisProfileTaggedTabContentQuery_connection: { fallbackId: null },
  PolarisPostRootQuery: { fallbackId: '28188170744199537' },
  PolarisStoriesV3ReelPageGalleryQuery: { fallbackId: '28262315486766731' },
  PolarisStoriesV3HighlightsPageQuery: { fallbackId: '28325328583775973' },
  PolarisSearchBoxRefetchableQuery: { fallbackId: '27706427925724183' },
} as const satisfies Record<string, QueryDef>;

export type QueryName = keyof typeof QUERIES;
export const QUERY_NAMES = Object.keys(QUERIES) as QueryName[];

/** Runs one persisted query and returns the `data` object of the response. */
export type GraphqlFn = (name: QueryName, variables: Json, signal: AbortSignal) => Promise<Json>;

export interface SessionInfo {
  appId: string;
  dtsg: string | null;
  lsd: string | null;
  wwwClaim: string | null;
}

export interface GraphqlDeps {
  gate: RequestGate;
  session(): Promise<SessionInfo>;
  csrf(): string | null;
  /** Query id from the page's module registry for this friendly name, or null. */
  docId(name: string): Promise<string | null>;
  /** Flags the page's definition of this query declares, with their current values; null when the page has none. */
  providedVariables(name: string): Promise<Json | null>;
  /** Runs the query through the page's own network layer. */
  pageQuery(name: string, docId: string, variables: Json, signal: AbortSignal): Promise<PageQueryResult>;
  fetch: typeof fetch;
  policy: RetryPolicy;
  hooks: RequestHooks;
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null;
}

export function createGraphql(deps: GraphqlDeps): GraphqlFn {
  return async (name, variables, signal) => {
    const def: QueryDef = QUERIES[name];
    const docId = (await deps.docId(name)) ?? def.fallbackId;
    if (!docId) throw new StopError('bad-response', `query id for ${name} is not available on this page`);
    // The site sends every flag its query definition declares and rejects a
    // request that lacks one, so the page's flags and values win over ours.
    const vars = { ...variables, ...(await deps.providedVariables(name)) };

    await deps.gate.pass(signal);
    const viaPage = await deps.pageQuery(name, docId, vars, signal);
    let body: unknown;
    if (viaPage.status === 'ok') body = viaPage.body;
    else if (viaPage.status === 'graphql') throw new StopError('graphql', viaPage.message);
    else {
      if (viaPage.status === 'failed') {
        // The direct request tells a login page, a challenge and throttling apart.
        console.warn(`[memfolio] the page could not send ${name}, sending it directly:`, viaPage.message);
        await deps.gate.pass(signal);
      }
      body = await sendDirect(deps, name, docId, vars, signal);
    }
    if (!isObject(body)) throw new StopError('bad-response', 'unexpected response');
    if (!isObject(body.data)) {
      const first = Array.isArray(body.errors) && isObject(body.errors[0]) ? body.errors[0].message : null;
      throw new StopError('graphql', typeof first === 'string' ? first : 'the query returned no data');
    }
    return body.data;
  };
}

/** The query as a request built here, with the web client's session fields. */
async function sendDirect(deps: GraphqlDeps, name: QueryName, docId: string, variables: Json, signal: AbortSignal): Promise<unknown> {
  const session = await deps.session();

  const form = new URLSearchParams();
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    'x-ig-app-id': session.appId,
  };
  const csrf = deps.csrf();
  if (csrf) headers['x-csrftoken'] = csrf;
  if (session.dtsg) form.set('fb_dtsg', session.dtsg);
  if (session.lsd) {
    form.set('lsd', session.lsd);
    headers['x-fb-lsd'] = session.lsd;
  }
  form.set('fb_api_caller_class', 'RelayModern');
  form.set('fb_api_req_friendly_name', name);
  form.set('server_timestamps', 'true');
  headers['x-fb-friendly-name'] = name;
  form.set('doc_id', docId);
  form.set('variables', JSON.stringify(variables));

  return requestJson(
    (s) => deps.fetch(`${ORIGIN}/graphql/query`, { method: 'POST', credentials: 'include', headers, body: form.toString(), signal: s }),
    deps.policy,
    deps.hooks,
    signal,
  );
}

// ---- listings ---------------------------------------------------------------

interface Connection {
  edges: unknown[];
  page_info?: unknown;
}

function isConnection(v: unknown): v is Connection {
  return isObject(v) && Array.isArray(v.edges);
}

/**
 * The connection under its known field name, or any field with the connection
 * shape if it was renamed. A query that refetches part of an object returns
 * the connection one level down, inside that object.
 */
function connectionFrom(data: Json, field: string): Connection {
  const holders = [data, ...Object.values(data).filter(isObject)];
  for (const h of holders) if (isConnection(h[field])) return h[field];
  for (const h of holders) for (const v of Object.values(h)) if (isConnection(v)) return v;
  const seen = Object.entries(data)
    .map(([k, v]) => (isObject(v) ? `${k}{${Object.keys(v).join(',')}}` : k))
    .join(', ');
  throw new StopError('bad-response', `the response does not contain a post list (fields: ${seen})`);
}

function toPage(conn: Connection, read: (node: unknown) => MediaItem[] = mediaFromNode): ListingPage {
  const items: MediaItem[] = [];
  let firstError: string | null = null;
  for (const edge of conn.edges) {
    const node = isObject(edge) ? edge.node : null;
    try {
      items.push(...read(node));
    } catch (e) {
      firstError ??= e instanceof Error ? e.message : String(e);
      console.warn('[memfolio] skipped a post that could not be read:', e instanceof Error ? e.message : e, node);
    }
  }
  // A page on which nothing is readable means the response shape changed, not that the account is empty.
  if (conn.edges.length > 0 && items.length === 0) {
    throw new StopError('bad-response', `none of the ${conn.edges.length} posts on the page could be read (${firstError})`);
  }
  const info = isObject(conn.page_info) ? conn.page_info : {};
  const next = info.has_next_page && typeof info.end_cursor === 'string' && info.end_cursor ? info.end_cursor : null;
  return { items, postCount: conn.edges.length, nextCursor: next };
}

/** Told once per listing when it falls back to smaller pages. */
export type SmallerPages = (from: number, to: number) => void;

/**
 * A listing that asks for `sizes.max` entries per page. When the platform
 * refuses that page, it is asked again with the site's own size, which is then
 * kept for the rest of the listing. A request to slow down is not a refusal.
 */
function sized(
  sizes: { max: number; site: number },
  fetchPage: (cursor: string | null, signal: AbortSignal, size: number) => Promise<ListingPage>,
  onSmaller?: SmallerPages,
): ListingSource {
  let size = sizes.max;
  return {
    async fetchPage(cursor, signal) {
      try {
        return await fetchPage(cursor, signal, size);
      } catch (e) {
        if (size === sizes.site || !isSoftStop(e) || signal.aborted) throw e;
        console.warn(`[memfolio] a page of ${size} was refused, asking for ${sizes.site}:`, e instanceof Error ? e.message : e);
        onSmaller?.(size, sizes.site);
        size = sizes.site;
        return fetchPage(cursor, signal, size);
      }
    },
  };
}

/** Main grid of a profile. */
export function postsSource(gql: GraphqlFn, username: string, onSmaller?: SmallerPages): ListingSource {
  return sized(PAGE_SIZES.posts, async (cursor, signal, size) => {
    const data = await gql(
      'PolarisProfilePostsTabContentQuery_connection',
      {
        after: cursor,
        before: null,
        data: {
          count: size,
          include_reel_media_seen_timestamp: true,
          include_relationship_info: true,
          latest_besties_reel_media: true,
          latest_reel_media: true,
        },
        first: size,
        include_multi_captions: true,
        last: null,
        username,
        __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: true,
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
        __relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider: false,
        __relay_internal__pv__PolarisReelsRecoDebugOverlayEnabledrelayprovider: false,
      },
      signal,
    );
    return toPage(connectionFrom(data, 'xdt_api__v1__feed__user_timeline_graphql_connection'));
  }, onSmaller);
}

/** Reels tab of a profile. Items come without a video URL and are resolved per reel before download. */
export function reelsSource(gql: GraphqlFn, userId: string, username: string, onSmaller?: SmallerPages): ListingSource {
  // `first` sets the size of the first page; `page_size` that of the following ones.
  return sized(PAGE_SIZES.reels, async (cursor, signal, size) => {
    const res = await gql(
      'PolarisProfileReelsTabContentQuery_connection',
      {
        after: cursor,
        data: { include_feed_video: true, page_size: PAGE_SIZES.reels.max, target_user_id: userId },
        first: size,
        id: userId,
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
      },
      signal,
    );
    return toPage(connectionFrom(res, 'xdt_api__v1__clips__user__connection_v2'), (node) => [reelFromListingNode(node, username)]);
  }, onSmaller);
}

/** Tagged tab of a profile: posts by other accounts in which this account is tagged. */
export function taggedSource(gql: GraphqlFn, userId: string, onSmaller?: SmallerPages): ListingSource {
  return sized(PAGE_SIZES.tagged, async (cursor, signal, size) => {
    const res = await gql(
      'PolarisProfileTaggedTabContentQuery_connection',
      {
        after: cursor,
        before: null,
        count: size,
        first: size,
        last: null,
        user_id: userId,
        __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
      },
      signal,
    );
    return toPage(connectionFrom(res, 'xdt_api__v1__usertags__user_id__feed_connection'));
  }, onSmaller);
}

// ---- account id -------------------------------------------------------------

export interface ResolveUserDeps {
  /** Id found in data the page already loaded (no request). */
  fromPage(username: string): Promise<string | null>;
  /** Id of a locally known account with this username. */
  known(username: string): string | null;
  gql: GraphqlFn;
  signal: AbortSignal;
}

export type UserIdSource = 'page' | 'registry' | 'search';

/** Numeric id of the account with this username, trying sources that cost no request first. */
export async function resolveUserId(
  username: string,
  deps: ResolveUserDeps,
): Promise<{ id: string; source: UserIdSource } | null> {
  const fromPage = await deps.fromPage(username).catch(() => null);
  if (fromPage) return { id: fromPage, source: 'page' };
  const known = deps.known(username);
  if (known) return { id: known, source: 'registry' };

  const data = await deps.gql(
    'PolarisSearchBoxRefetchableQuery',
    {
      data: { context: 'blended', include_reel: 'true', query: username, rank_token: '', search_surface: 'web_top_search' },
      hasQuery: true,
    },
    deps.signal,
  );
  const result = isObject(data.xdt_api__v1__fbsearch__topsearch_connection) ? data.xdt_api__v1__fbsearch__topsearch_connection : {};
  for (const entry of Array.isArray(result.users) ? result.users : []) {
    const user = isObject(entry) && isObject(entry.user) ? entry.user : null;
    if (!user || typeof user.username !== 'string') continue;
    if (user.username.toLowerCase() !== username.toLowerCase()) continue;
    const id = user.pk ?? user.id;
    if (typeof id === 'string' || typeof id === 'number') return { id: String(id), source: 'search' };
  }
  return null;
}

// ---- single post ------------------------------------------------------------

export interface PostDeps {
  gql: GraphqlFn;
  /** `/api/v1/media/<pk>/info/` item, null when the endpoint is switched off for this session. */
  mediaInfo(pk: string, signal: AbortSignal): Promise<unknown | null>;
  /** The page's own post loader (older response shape), null when unavailable. */
  relayPost(shortcode: string): Promise<unknown | null>;
  signal: AbortSignal;
}

/** Stops that mean "this source does not work", as opposed to "stop talking to the platform". */
export function isSoftStop(e: unknown): boolean {
  return e instanceof StopError && (e.reason === 'bad-response' || e.reason === 'http' || e.reason === 'graphql');
}

/** All media of one post, trying each known source in turn. */
export async function fetchPostMedia(shortcode: string, deps: PostDeps): Promise<MediaItem[]> {
  const attempts: Array<() => Promise<MediaItem[] | null>> = [
    async () => {
      const item = await deps.mediaInfo(shortcodeToId(shortcode), deps.signal);
      return item ? mediaFromNode(item) : null;
    },
    async () => {
      const data = await deps.gql(
        'PolarisPostRootQuery',
        {
          shortcode,
          __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
          __relay_internal__pv__PolarisThreadsStyleCommentsEnabledrelayprovider: false,
          __relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider: false,
        },
        deps.signal,
      );
      const info = isObject(data.xdt_api__v1__media__shortcode__web_info) ? data.xdt_api__v1__media__shortcode__web_info : null;
      const item = Array.isArray(info?.items) ? info.items[0] : null;
      return item ? mediaFromNode(item) : null;
    },
    async () => {
      const media = await deps.relayPost(shortcode);
      return media ? legacyMediaFromShortcodeMedia(media) : null;
    },
  ];

  for (const attempt of attempts) {
    try {
      const items = await attempt();
      if (items && items.length > 0) return items;
    } catch (e) {
      if (e instanceof StopError && !isSoftStop(e)) throw e;
      if (deps.signal.aborted) throw e;
      console.warn('[memfolio] post source failed, trying the next one:', e instanceof Error ? e.message : e);
    }
  }
  throw new Error('post not found');
}

// ---- stories ----------------------------------------------------------------

export type ReelRef = { kind: 'user'; userId: string } | { kind: 'highlight'; highlightId: string };

/** All items of a user's current story or of one highlight. */
export async function fetchReelMedia(ref: ReelRef, deps: { gql: GraphqlFn; signal: AbortSignal }): Promise<MediaItem[]> {
  const reelId = ref.kind === 'user' ? ref.userId : `highlight:${ref.highlightId}`;
  const data = await deps.gql(
    ref.kind === 'user' ? 'PolarisStoriesV3ReelPageGalleryQuery' : 'PolarisStoriesV3HighlightsPageQuery',
    {
      initial_reel_id: reelId,
      reel_ids: [reelId],
      first: 3,
      last: 2,
      __relay_internal__pv__PolarisCommunityNoteStoriesLabelEnabledrelayprovider: true,
    },
    deps.signal,
  );
  const conn = data.xdt_api__v1__feed__reels_media__connection;
  const edge = isConnection(conn) ? conn.edges[0] : null;
  const reel = isObject(edge) && isObject(edge.node) ? edge.node : null;
  if (!reel || !Array.isArray(reel.items)) return [];

  const user = isObject(reel.user) ? reel.user : {};
  // The requested id is the account id; on a highlight, `pk` of the reel's user is.
  const ownerId = ref.kind === 'user' ? ref.userId : user.pk;
  const ownerUsername = user.username;
  if ((typeof ownerId !== 'string' && typeof ownerId !== 'number') || typeof ownerUsername !== 'string') {
    throw new StopError('bad-response', 'the story response does not name its owner');
  }
  const owner = { ownerId: String(ownerId), ownerUsername };
  const items: MediaItem[] = [];
  for (const item of reel.items) {
    try {
      items.push(...mediaFromNode(item, owner));
    } catch (e) {
      console.warn('[memfolio] skipped a story item that could not be read:', e instanceof Error ? e.message : e);
    }
  }
  return items;
}
