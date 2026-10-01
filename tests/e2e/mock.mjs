// A stand-in for the platform, served through request interception. It mimics
// only what the extension uses: profile and post pages, the module registry
// the page bridge reads, the persisted queries, and a media host.

export const ORIGIN = 'https://www.instagram.com';
export const CDN = 'https://cdn.memfolio.test';

export const DOC_IDS = {
  PolarisProfilePostsTabContentQuery_connection: '1001',
  PolarisProfileReelsTabContentQuery_connection: '1002',
  PolarisProfileTaggedTabContentQuery_connection: '1003',
  PolarisPostRootQuery: '1004',
  PolarisStoriesV3ReelPageGalleryQuery: '1005',
  PolarisStoriesV3HighlightsPageQuery: '1006',
  PolarisSearchBoxRefetchableQuery: '1007',
};
const NAME_OF_DOC = Object.fromEntries(Object.entries(DOC_IDS).map(([k, v]) => [v, k]));

const PAGE_SIZE = 12;
const pkOf = (n, child = 0) => String(3000000000000000000n + BigInt(n) * 10n + BigInt(child));

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Shortcode of a media pk, as the platform encodes it. */
function shortcodeOf(pk) {
  let id = BigInt(pk);
  let out = '';
  while (id > 0n) {
    out = ALPHABET[Number(id % 64n)] + out;
    id /= 64n;
  }
  return out;
}

function image(pk) {
  return { candidates: [{ url: `${CDN}/${pk}_small.jpg?stp=s320`, width: 320, height: 320 }, { url: `${CDN}/${pk}.jpg?stp=full`, width: 1080, height: 1080 }] };
}

/** One post in the v1 media shape. `n` orders posts: higher is newer. */
export function makePost(n, { owner = '42', username = 'acct', kind = 'image' } = {}) {
  const pk = pkOf(n);
  const base = { id: `${pk}_${owner}`, pk, code: shortcodeOf(pk), taken_at: 1700000000 + n * 1000, user: { username, pk: owner } };
  if (kind === 'video') {
    return { ...base, media_type: 2, image_versions2: image(pk), video_versions: [{ url: `${CDN}/${pk}.mp4?x=1`, width: 720, height: 1280 }] };
  }
  if (kind === 'carousel') {
    return {
      ...base,
      media_type: 8,
      carousel_media: [1, 2, 3].map((c) => {
        const cpk = pkOf(n, c);
        const child = { id: `${cpk}_${owner}`, pk: cpk, media_type: c === 3 ? 2 : 1, user: null, image_versions2: image(cpk) };
        if (c === 3) child.video_versions = [{ url: `${CDN}/${cpk}.mp4`, width: 720, height: 720 }];
        return child;
      }),
    };
  }
  return { ...base, media_type: 1, image_versions2: image(pk) };
}

/** Posts 1..count, newest first; every 5th is a carousel of three, every 7th a video. */
export function makeTimeline(count, opts = {}) {
  const posts = [];
  for (let n = count; n >= 1; n--) posts.push(makePost(n, { ...opts, kind: n % 5 === 0 ? 'carousel' : n % 7 === 0 ? 'video' : 'image' }));
  return posts;
}

/** File names the extension is expected to write for the given posts. */
export function expectedFiles(posts) {
  const names = [];
  for (const p of posts) {
    const username = p.user.username;
    const owner = p.user.pk;
    if (p.carousel_media) {
      for (const c of p.carousel_media) names.push(`${username}_${p.taken_at}_${c.pk}_${owner}.${c.media_type === 2 ? 'mp4' : 'jpg'}`);
    } else {
      names.push(`${username}_${p.taken_at}_${p.pk}_${owner}.${p.media_type === 2 ? 'mp4' : 'jpg'}`);
    }
  }
  return names.sort();
}

function pageHtml(state, body) {
  const registry = {
    docIds: DOC_IDS,
    relayUsers: state.relayUsers,
    appId: '936619743392459',
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>mock</title>
<script>
(() => {
  const reg = ${JSON.stringify(registry)};
  const records = Object.fromEntries(reg.relayUsers.map((u, i) => ['user' + i, u]));
  const modules = {
    PolarisConfig: { getIGAppID: () => reg.appId },
    DTSGInitialData: { token: 'DTSGTOKEN' },
    LSD: { token: 'LSDTOKEN' },
    PolarisWWWClaim: { getWWWClaim: () => 'hmac.claim' },
    PolarisRelayEnvironment: { getStore: () => ({ getSource: () => ({ getRecordIDs: () => Object.keys(records), get: (id) => records[id] }) }) },
  };
  for (const [name, id] of Object.entries(reg.docIds)) modules[name + '_instagramRelayOperation'] = id;
  window.require = (name) => {
    if (!(name in modules)) throw new Error('Requiring unknown module "' + name + '"');
    return modules[name];
  };
})();
</script></head><body style="background:#fff;margin:0">${body}
<script>
// Stand-in for the UI framework taking over the server-rendered markup.
window.__hydrate = () => { for (const el of document.querySelectorAll('[role="button"]')) el['__reactFiber$mock'] = { memoizedProps: {} }; };
if (!location.search.includes('late')) window.__hydrate();
</script></body></html>`;
}

const SAVE_ICON = '<svg width="24" height="24"><polygon points="20 21 12 13.44 4 21 4 3 20 3 20 21"></polygon></svg>';

/** A post page: permalink, the save-to-collection control, and carousel slides when the post has several media. */
function postPageBody(state, code) {
  const post = findPost(state, (p) => p.code === code);
  const slides = (post?.carousel_media ?? [])
    .map((c, i) => {
      const small = c.image_versions2.candidates[0].url;
      const media = c.media_type === 2 ? `<video poster="${small}" width="400" height="400"></video>` : `<img src="${small}" width="400" height="400">`;
      return `<li style="position: absolute; top: 0; left: 0; transform: translateX(${i * 400}px); width: 400px">${media}</li>`;
    })
    .join('');
  return `<main><article>
  <a href="/p/${code}/">permalink</a>
  ${slides ? `<div style="position:relative;height:400px;overflow:hidden"><ul style="list-style:none;margin:0;padding:0">${slides}</ul></div>` : ''}
  <section id="actions"><div><div role="button" id="save">${SAVE_ICON}</div></div></section>
</article></main>`;
}

/** A profile page with a grid of thumbnails linking to the newest posts. */
function profileBody(state) {
  const thumbs = state.posts
    .slice(0, 3)
    .map((p) => {
      const media = p.carousel_media?.[0] ?? p;
      return `<a href="/p/${p.code}/" style="display:inline-block"><img src="${media.image_versions2.candidates[0].url}" width="300" height="300"></a>`;
    })
    .join('');
  return `<main><header><h2>profile</h2></header><div id="grid">${thumbs}</div></main>`;
}

function connection(list, cursor, wrap = (n) => n) {
  const start = cursor ? Number(cursor) : 0;
  const slice = list.slice(start, start + PAGE_SIZE);
  const more = start + PAGE_SIZE < list.length;
  return { edges: slice.map((n) => ({ node: wrap(n) })), page_info: { end_cursor: more ? String(start + PAGE_SIZE) : null, has_next_page: more } };
}

function findPost(state, predicate) {
  return [...state.posts, ...state.reels, ...state.tagged, ...state.extraPosts].find(predicate) ?? null;
}

function graphql(state, name, vars) {
  switch (name) {
    case 'PolarisProfilePostsTabContentQuery_connection':
      return { xdt_api__v1__feed__user_timeline_graphql_connection: connection(state.posts, vars.after) };
    case 'PolarisProfileReelsTabContentQuery_connection':
      // The reels grid carries no direct video URL.
      return { xdt_api__v1__clips__user__connection_v2: connection(state.reels, vars.after, (n) => ({ media: { pk: n.pk, id: n.id, code: n.code, media_type: 2, image_versions2: n.image_versions2, video_versions: null } })) };
    case 'PolarisProfileTaggedTabContentQuery_connection':
      return { xdt_api__v1__usertags__user_id__feed_connection: connection(state.tagged, vars.after) };
    case 'PolarisPostRootQuery': {
      const post = findPost(state, (p) => p.code === vars.shortcode);
      return { xdt_api__v1__media__shortcode__web_info: { items: post ? [post] : [] } };
    }
    case 'PolarisSearchBoxRefetchableQuery':
      return { xdt_api__v1__fbsearch__topsearch_connection: { users: state.searchUsers.map((u) => ({ user: u })) } };
    case 'PolarisStoriesV3ReelPageGalleryQuery':
    case 'PolarisStoriesV3HighlightsPageQuery':
      return { xdt_api__v1__feed__reels_media__connection: { edges: state.story ? [{ node: state.story }] : [] } };
    default:
      return null;
  }
}

export function newState(overrides = {}) {
  return {
    posts: [],
    reels: [],
    tagged: [],
    extraPosts: [],
    story: null,
    relayUsers: [{ username: 'acct', pk: '42' }],
    searchUsers: [],
    /** Calls the extension made, in order: { name, vars, params }. */
    calls: [],
    mediaRequests: [],
    /** HTTP statuses to answer the next GraphQL requests with, before normal service resumes. */
    failStatuses: [],
    loginRedirect: false,
    mediaInfo: 'json', // 'json' | 'dead'
    mediaDelayMs: 0,
    ...overrides,
  };
}

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const html = (body) => ({ status: 200, contentType: 'text/html; charset=utf-8', body });

/** Installs the mock on a page. `state` may be mutated by the test between steps. */
export async function installMock(page, state) {
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    const url = new URL(req.url());
    try {
      if (url.origin === CDN) {
        state.mediaRequests.push(url.pathname);
        if (state.mediaDelayMs) await new Promise((r) => setTimeout(r, state.mediaDelayMs));
        const video = url.pathname.endsWith('.mp4');
        return await req.respond({
          status: 200,
          headers: { 'access-control-allow-origin': '*' },
          contentType: video ? 'video/mp4' : 'image/jpeg',
          body: Buffer.alloc(video ? 4096 : 1024, 7),
        });
      }
      if (url.origin !== ORIGIN) return await req.continue();

      if (url.pathname === '/graphql/query' && req.method() === 'POST') {
        const form = new URLSearchParams(req.postData() ?? '');
        const name = NAME_OF_DOC[form.get('doc_id')] ?? `unknown:${form.get('doc_id')}`;
        const vars = JSON.parse(form.get('variables') ?? '{}');
        state.calls.push({ name, vars, params: Object.fromEntries(form), headers: req.headers() });
        if (state.loginRedirect) return await req.respond({ status: 302, headers: { location: `${ORIGIN}/accounts/login/?next=%2F` } });
        const fail = state.failStatuses.shift();
        if (fail) return await req.respond({ status: fail, contentType: 'text/html', body: '<html>limited</html>' });
        const data = graphql(state, name, vars);
        return await req.respond(data ? json({ data, status: 'ok' }) : json({ errors: [{ message: 'unknown query' }], data: null }));
      }

      const info = /^\/api\/v1\/media\/(\d+)\/info\/$/.exec(url.pathname);
      if (info) {
        state.calls.push({ name: 'mediaInfo', vars: { pk: info[1] } });
        if (state.mediaInfo === 'dead') return await req.respond({ status: 302, headers: { location: `${ORIGIN}/` } });
        const post = findPost(state, (p) => p.pk === info[1]);
        return await req.respond(post ? json({ items: [post], status: 'ok' }) : json({ message: 'Media not found', status: 'fail' }, 404));
      }

      if (url.pathname.startsWith('/accounts/login')) return await req.respond(html('<html><body>login</body></html>'));
      const postPage = /^\/(?:p|reel)\/([^/]+)\/?$/.exec(url.pathname);
      if (postPage) return await req.respond(html(pageHtml(state, postPageBody(state, postPage[1]))));
      return await req.respond(html(pageHtml(state, profileBody(state))));
    } catch (e) {
      console.error('mock error', req.url(), e);
      try {
        await req.abort();
      } catch {
        // already handled
      }
    }
  });
}
