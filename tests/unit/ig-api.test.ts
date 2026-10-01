import { describe, expect, it } from 'vitest';
import {
  createGraphql,
  fetchPostMedia,
  fetchReelMedia,
  postsSource,
  reelsSource,
  resolveUserId,
  taggedSource,
  type GraphqlFn,
  type SessionInfo,
} from '../../src/platforms/instagram/api';
import { RequestGate } from '../../src/core/request';
import { StopError } from '../../src/core/types';

const signal = new AbortController().signal;

function node(n: number, owner = '42', username = 'acct') {
  return {
    id: `${3000000000000000000n + BigInt(n)}_${owner}`,
    pk: `${3000000000000000000n + BigInt(n)}`,
    code: `C${n}`,
    taken_at: 1700000000 + n,
    media_type: 1,
    user: { username, pk: owner },
    image_versions2: { candidates: [{ url: `https://cdn.test/${n}.jpg`, width: 1080, height: 1080 }] },
  };
}

function recorder(responses: Array<Record<string, unknown>>) {
  const calls: Array<{ name: string; variables: Record<string, unknown> }> = [];
  const gql: GraphqlFn = async (name, variables) => {
    calls.push({ name, variables });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return next;
  };
  return { gql, calls };
}

describe('postsSource', () => {
  const connection = (edges: unknown[], end: string | null, more: boolean) => ({
    xdt_api__v1__feed__user_timeline_graphql_connection: {
      edges: edges.map((n) => ({ node: n })),
      page_info: { end_cursor: end, has_next_page: more },
    },
  });

  it('asks for the first page by username with a null cursor', async () => {
    const r = recorder([connection([node(2), node(1)], 'CUR', true)]);
    const page = await postsSource(r.gql, 'acct').fetchPage(null, signal);
    expect(r.calls[0]!.name).toBe('PolarisProfilePostsTabContentQuery_connection');
    expect(r.calls[0]!.variables).toMatchObject({ username: 'acct', after: null, first: 12, data: { count: 12 } });
    expect(page.postCount).toBe(2);
    expect(page.items.map((i) => i.shortcode)).toEqual(['C2', 'C1']);
    expect(page.nextCursor).toBe('CUR');
  });

  it('passes the cursor on and ends when there is no next page', async () => {
    const r = recorder([connection([node(1)], 'ignored', false)]);
    const page = await postsSource(r.gql, 'acct').fetchPage('CUR', signal);
    expect(r.calls[0]!.variables).toMatchObject({ after: 'CUR' });
    expect(page.nextCursor).toBeNull();
  });

  it('skips a malformed post and keeps the rest of the page', async () => {
    const r = recorder([connection([node(2), { id: 'broken' }, node(1)], null, false)]);
    const page = await postsSource(r.gql, 'acct').fetchPage(null, signal);
    expect(page.items).toHaveLength(2);
    expect(page.postCount).toBe(3);
  });

  it('finds the connection by shape when its field name changes', async () => {
    const r = recorder([{ renamed_connection: { edges: [{ node: node(1) }], page_info: { end_cursor: null, has_next_page: false } } }]);
    const page = await postsSource(r.gql, 'acct').fetchPage(null, signal);
    expect(page.items).toHaveLength(1);
  });

  it('stops when the response holds no connection', async () => {
    const r = recorder([{ something_else: true }]);
    await expect(postsSource(r.gql, 'acct').fetchPage(null, signal)).rejects.toMatchObject({ reason: 'bad-response' });
  });
});

describe('reelsSource', () => {
  // The listing names the reel but carries no author name, timestamp or video URL.
  const reelNode = (n: number) => {
    const { pk, id, code, image_versions2 } = node(n);
    return { __typename: 'XDTClipsItemDict', media: { pk, id, code, media_type: 2, image_versions2, video_versions: null } };
  };
  const data = { xdt_api__v1__clips__user__connection_v2: { edges: [{ node: reelNode(1) }], page_info: { end_cursor: 'R', has_next_page: true } } };

  it('lists by user id and returns items that still need a URL', async () => {
    const r = recorder([data]);
    const page = await reelsSource(r.gql, '42', 'acct').fetchPage(null, signal);
    expect(r.calls[0]!.name).toBe('PolarisProfileReelsTabContentQuery_connection');
    expect(r.calls[0]!.variables).toEqual({
      after: null,
      data: { include_feed_video: true, page_size: 12, target_user_id: '42' },
      first: 3,
      id: '42',
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
    });
    expect(page.items[0]).toMatchObject({ id: '3000000000000000001_42', ownerId: '42', ownerUsername: 'acct', kind: 'video', url: null, shortcode: 'C1' });
    expect(page.nextCursor).toBe('R');
  });

  it('finds the connection when the response nests it under another object', async () => {
    const r = recorder([{ node: { __typename: 'XDTUserDict', ...data } }]);
    const page = await reelsSource(r.gql, '42', 'acct').fetchPage(null, signal);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe('R');
  });

  it('stops when no entry of a page can be read', async () => {
    const broken = { xdt_api__v1__clips__user__connection_v2: { edges: [{ node: { media: { pk: '1' } } }], page_info: {} } };
    const r = recorder([broken]);
    await expect(reelsSource(r.gql, '42', 'acct').fetchPage(null, signal)).rejects.toMatchObject({
      reason: 'bad-response',
      message: expect.stringContaining('reel without media id'),
    });
  });

  it('names the fields it received when there is no connection', async () => {
    const r = recorder([{ node: { other: 1 }, extensions: null }]);
    await expect(reelsSource(r.gql, '42', 'acct').fetchPage(null, signal)).rejects.toMatchObject({
      reason: 'bad-response',
      message: expect.stringContaining('node{other}'),
    });
  });

  it('passes the cursor from the second page on', async () => {
    const r = recorder([data]);
    await reelsSource(r.gql, '42', 'acct').fetchPage('R', signal);
    expect(r.calls[0]!.variables).toEqual({
      after: 'R',
      data: { include_feed_video: true, page_size: 12, target_user_id: '42' },
      first: 3,
      id: '42',
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
    });
  });
});

describe('taggedSource', () => {
  const data = { xdt_api__v1__usertags__user_id__feed_connection: { edges: [{ node: node(1, '77', 'other') }], page_info: { end_cursor: null, has_next_page: false } } };

  it('lists by user id and keeps the author of each tagged post as owner', async () => {
    const r = recorder([data]);
    const page = await taggedSource(r.gql, '42').fetchPage(null, signal);
    expect(r.calls[0]!.name).toBe('PolarisProfileTaggedTabContentQuery_connection');
    expect(r.calls[0]!.variables).toEqual({
      after: null,
      before: null,
      count: 12,
      first: 12,
      last: null,
      user_id: '42',
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
    });
    expect(page.items[0]).toMatchObject({ ownerId: '77', ownerUsername: 'other' });
  });

  it('passes the cursor from the second page on', async () => {
    const r = recorder([data]);
    await taggedSource(r.gql, '42').fetchPage('T', signal);
    expect(r.calls[0]!.variables).toEqual({
      after: 'T',
      before: null,
      count: 12,
      first: 12,
      last: null,
      user_id: '42',
      __relay_internal__pv__PolarisShortDramaEnabledrelayprovider: false,
    });
  });
});

describe('resolveUserId', () => {
  const noBridge = async (): Promise<string | null> => null;

  it('uses the id the page already holds without a request', async () => {
    const r = recorder([{}]);
    const id = await resolveUserId('acct', { fromPage: async () => '42', known: () => null, gql: r.gql, signal });
    expect(id).toEqual({ id: '42', source: 'page' });
    expect(r.calls).toHaveLength(0);
  });

  it('falls back to the locally known account for that username', async () => {
    const r = recorder([{}]);
    const id = await resolveUserId('acct', { fromPage: noBridge, known: () => '42', gql: r.gql, signal });
    expect(id).toEqual({ id: '42', source: 'registry' });
    expect(r.calls).toHaveLength(0);
  });

  it('asks the search query and takes the exact username match', async () => {
    const r = recorder([
      {
        xdt_api__v1__fbsearch__topsearch_connection: {
          users: [{ user: { username: 'acct_fan', id: '1' } }, { user: { username: 'acct', pk: '42' } }],
        },
      },
    ]);
    const id = await resolveUserId('acct', { fromPage: noBridge, known: () => null, gql: r.gql, signal });
    expect(id).toEqual({ id: '42', source: 'search' });
    expect(r.calls[0]!.name).toBe('PolarisSearchBoxRefetchableQuery');
    expect(r.calls[0]!.variables).toMatchObject({ data: { query: 'acct' }, hasQuery: true });
  });

  it('returns null when the search has no exact match', async () => {
    const r = recorder([{ xdt_api__v1__fbsearch__topsearch_connection: { users: [{ user: { username: 'acct_fan', id: '1' } }] } }]);
    expect(await resolveUserId('acct', { fromPage: noBridge, known: () => null, gql: r.gql, signal })).toBeNull();
  });
});

describe('fetchPostMedia', () => {
  const item = node(5);

  it('reads the post from the media info endpoint first', async () => {
    const r = recorder([{}]);
    const items = await fetchPostMedia('C5', {
      gql: r.gql,
      mediaInfo: async () => item,
      relayPost: async () => null,
      signal,
    });
    expect(items.map((i) => i.id)).toEqual([`${3000000000000000005n}_42`]);
    expect(r.calls).toHaveLength(0);
  });

  it('falls back to the post query when the info endpoint is unusable', async () => {
    const r = recorder([{ xdt_api__v1__media__shortcode__web_info: { items: [item] } }]);
    const items = await fetchPostMedia('C5', {
      gql: r.gql,
      mediaInfo: async () => {
        throw new StopError('bad-response', 'response is not JSON');
      },
      relayPost: async () => null,
      signal,
    });
    expect(r.calls[0]!.name).toBe('PolarisPostRootQuery');
    expect(r.calls[0]!.variables).toMatchObject({ shortcode: 'C5' });
    expect(items).toHaveLength(1);
  });

  it('falls back to the page loader last', async () => {
    const gql: GraphqlFn = async () => {
      throw new StopError('http', 'HTTP 403');
    };
    const items = await fetchPostMedia('C5', {
      gql,
      mediaInfo: async () => null,
      relayPost: async () => ({
        id: '3000000000000000005',
        shortcode: 'C5',
        taken_at_timestamp: 1700000005,
        is_video: false,
        owner: { id: '42', username: 'acct' },
        display_url: 'https://cdn.test/5.jpg',
      }),
      signal,
    });
    expect(items[0]).toMatchObject({ id: '3000000000000000005_42', url: 'https://cdn.test/5.jpg' });
  });

  it('does not try further sources after a rate limit or login stop', async () => {
    let relayCalls = 0;
    const gql: GraphqlFn = async () => {
      throw new Error('must not be called');
    };
    await expect(
      fetchPostMedia('C5', {
        gql,
        mediaInfo: async () => {
          throw new StopError('rate-limited', 'HTTP 429');
        },
        relayPost: async () => {
          relayCalls += 1;
          return null;
        },
        signal,
      }),
    ).rejects.toMatchObject({ reason: 'rate-limited' });
    expect(relayCalls).toBe(0);
  });

  it('fails when no source returns the post', async () => {
    const r = recorder([{}]);
    await expect(
      fetchPostMedia('C5', { gql: r.gql, mediaInfo: async () => null, relayPost: async () => null, signal }),
    ).rejects.toThrow(/post not found/);
  });
});

describe('fetchReelMedia', () => {
  const storyItem = (n: number) => {
    const { user: _u, ...rest } = node(n);
    return { ...rest, id: rest.pk };
  };
  const data = {
    xdt_api__v1__feed__reels_media__connection: {
      edges: [{ node: { id: '42', user: { username: 'acct', pk: '42' }, items: [storyItem(1), storyItem(2)] } }],
    },
  };

  it('loads the stories of a user by reel id', async () => {
    const r = recorder([data]);
    const items = await fetchReelMedia({ kind: 'user', userId: '42' }, { gql: r.gql, signal });
    expect(r.calls[0]!.name).toBe('PolarisStoriesV3ReelPageGalleryQuery');
    expect(r.calls[0]!.variables).toMatchObject({ initial_reel_id: '42', reel_ids: ['42'] });
    expect(items.map((i) => [i.pk, i.ownerId, i.ownerUsername])).toEqual([
      ['3000000000000000001', '42', 'acct'],
      ['3000000000000000002', '42', 'acct'],
    ]);
  });

  it('loads a highlight by its id', async () => {
    const r = recorder([data]);
    await fetchReelMedia({ kind: 'highlight', highlightId: '179' }, { gql: r.gql, signal });
    expect(r.calls[0]!.name).toBe('PolarisStoriesV3HighlightsPageQuery');
    expect(r.calls[0]!.variables).toMatchObject({ initial_reel_id: 'highlight:179', reel_ids: ['highlight:179'] });
  });

  it('uses the requested account id as owner, not the app-scoped id on the user object', async () => {
    const r = recorder([
      { xdt_api__v1__feed__reels_media__connection: { edges: [{ node: { user: { username: 'acct', id: '17841400000000000' }, items: [storyItem(1)] } }] } },
    ]);
    const items = await fetchReelMedia({ kind: 'user', userId: '42' }, { gql: r.gql, signal });
    expect(items[0]!.ownerId).toBe('42');
  });

  it('takes the owner of a highlight from the pk of its user', async () => {
    const r = recorder([
      { xdt_api__v1__feed__reels_media__connection: { edges: [{ node: { user: { username: 'acct', pk: '42', id: '17841400000000000' }, items: [storyItem(1)] } }] } },
    ]);
    const items = await fetchReelMedia({ kind: 'highlight', highlightId: '179' }, { gql: r.gql, signal });
    expect(items[0]!.ownerId).toBe('42');
  });

  it('stops when a highlight does not name its owner by pk', async () => {
    const r = recorder([
      { xdt_api__v1__feed__reels_media__connection: { edges: [{ node: { user: { username: 'acct', id: '17841400000000000' }, items: [storyItem(1)] } }] } },
    ]);
    await expect(fetchReelMedia({ kind: 'highlight', highlightId: '179' }, { gql: r.gql, signal })).rejects.toMatchObject({ reason: 'bad-response' });
  });

  it('returns nothing when the reel is empty or missing', async () => {
    const r = recorder([{ xdt_api__v1__feed__reels_media__connection: { edges: [] } }]);
    expect(await fetchReelMedia({ kind: 'user', userId: '42' }, { gql: r.gql, signal })).toEqual([]);
  });
});

describe('createGraphql', () => {
  const session: SessionInfo = { appId: '936619743392459', dtsg: 'DTSG', lsd: 'LSD', wwwClaim: 'hmac.x' };

  function transport(body: unknown, docIds: Record<string, string | null> = {}) {
    const sent: Array<{ url: string; init: RequestInit }> = [];
    const gate = new RequestGate(
      { minGapMs: [0, 0], hourlyBudget: 100 },
      { load: async () => [], save: async () => {} },
      { sleep: async () => {}, rng: () => 0, now: () => Date.now() },
    );
    const gql = createGraphql({
      gate,
      session: async () => session,
      csrf: () => 'CSRF',
      docId: async (name) => docIds[name] ?? null,
      fetch: async (url, init) => {
        sent.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify(body), { status: 200 });
      },
      policy: { maxRetries: 0, backoff: { baseMs: 1, capMs: 1, jitterRatio: 0 }, retryAfterCapMs: 1 },
      hooks: { sleep: async () => {}, rng: () => 0 },
    });
    return { gql, sent };
  }

  const params = (init: RequestInit) => new URLSearchParams(String(init.body));
  const headers = (init: RequestInit) => new Headers(init.headers);

  it('sends the posts query with the minimal parameter set', async () => {
    const t = transport({ data: { ok: 1 } }, { PolarisProfilePostsTabContentQuery_connection: '111' });
    const data = await t.gql('PolarisProfilePostsTabContentQuery_connection', { username: 'acct' }, signal);
    expect(data).toEqual({ ok: 1 });
    const { url, init } = t.sent[0]!;
    expect(url).toBe('https://www.instagram.com/graphql/query');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect([...params(init).keys()].sort()).toEqual(['doc_id', 'variables']);
    expect(params(init).get('doc_id')).toBe('111');
    expect(JSON.parse(params(init).get('variables')!)).toEqual({ username: 'acct' });
    expect(headers(init).get('x-csrftoken')).toBe('CSRF');
    expect(headers(init).get('x-ig-app-id')).toBe('936619743392459');
    expect(headers(init).get('content-type')).toBe('application/x-www-form-urlencoded');
  });

  it('adds the session parameters for the other queries', async () => {
    const t = transport({ data: {} }, { PolarisPostRootQuery: '222' });
    await t.gql('PolarisPostRootQuery', { shortcode: 'C5' }, signal);
    const { init } = t.sent[0]!;
    expect(params(init).get('fb_dtsg')).toBe('DTSG');
    expect(params(init).get('lsd')).toBe('LSD');
    expect(params(init).get('fb_api_req_friendly_name')).toBe('PolarisPostRootQuery');
    expect(params(init).get('fb_api_caller_class')).toBe('RelayModern');
    expect(headers(init).get('x-fb-friendly-name')).toBe('PolarisPostRootQuery');
    expect(headers(init).get('x-fb-lsd')).toBe('LSD');
  });

  it('uses the recorded query id when the page does not provide one', async () => {
    const t = transport({ data: {} });
    await t.gql('PolarisProfilePostsTabContentQuery_connection', {}, signal);
    expect(params(t.sent[0]!.init).get('doc_id')).toBe('28844755988451916');
  });

  it('uses the alternate query name when the page has loaded only that one', async () => {
    const t = transport({ data: {} }, { PolarisProfileReelsTabContentQuery: '77' });
    await t.gql('PolarisProfileReelsTabContentQuery_connection', {}, signal);
    const { init } = t.sent[0]!;
    expect(params(init).get('doc_id')).toBe('77');
    expect(params(init).get('fb_api_req_friendly_name')).toBe('PolarisProfileReelsTabContentQuery');
  });

  it('prefers the primary query name when both are loaded', async () => {
    const t = transport({ data: {} }, { PolarisProfileReelsTabContentQuery: '77', PolarisProfileReelsTabContentQuery_connection: '78' });
    await t.gql('PolarisProfileReelsTabContentQuery_connection', {}, signal);
    expect(params(t.sent[0]!.init).get('doc_id')).toBe('78');
  });

  it('stops without a request when no query id is known', async () => {
    const t = transport({ data: {} });
    await expect(t.gql('PolarisProfileTaggedTabContentQuery_connection', {}, signal)).rejects.toMatchObject({
      reason: 'bad-response',
    });
    expect(t.sent).toHaveLength(0);
  });

  it('stops on a GraphQL error response', async () => {
    const t = transport({ errors: [{ message: 'Execution error' }], data: null }, { PolarisPostRootQuery: '1' });
    await expect(t.gql('PolarisPostRootQuery', {}, signal)).rejects.toMatchObject({
      reason: 'graphql',
      message: 'Execution error',
    });
  });
});
