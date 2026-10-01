// End-to-end suite: the built extension (dist-e2e) running in Chrome against a
// mocked platform. Folder picks are served from the origin-private file system,
// which gives real FileSystemDirectoryHandle objects without a native dialog.
//
//   npm run test:e2e            all scenarios
//   npm run test:e2e -- import  scenarios whose name contains "import"

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { DOC_IDS, ORIGIN, expectedFiles, installMock, makePost, makeTimeline, newState } from './mock.mjs';

const EXT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../dist-e2e');
const only = process.argv[2];

// ---- harness ----------------------------------------------------------------

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n   expected: ${e}\n   actual:   ${a}`);
}

async function waitFor(fn, what, timeout = 15000) {
  if (process.env.E2E_VERBOSE) console.log(`   ${String(Date.now() % 100000).padStart(5)} wait: ${what}`);
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * macOS only. Chrome looks at the user's Desktop, Documents and Downloads folders on its own
 * (sensitive-folder checks of the File System Access API, default download location). The
 * suite has no business there, so the browser runs under a system sandbox profile that
 * refuses those folders. Returns the path of a wrapper script to launch instead of the browser.
 */
async function sandboxedBrowser(dir) {
  if (process.platform !== 'darwin' || process.env.MEMFOLIO_E2E_NO_SANDBOX) return undefined;
  const home = homedir();
  const folders = ['Desktop', 'Documents', 'Downloads', 'Pictures', 'Movies', 'Music'].map((f) => `(subpath "${join(home, f)}")`).join(' ');
  const profile = join(dir, 'browser.sb');
  const wrapper = join(dir, 'browser.sh');
  await writeFile(profile, `(version 1)\n(allow default)\n(deny file-read* file-write* ${folders})\n`);
  await writeFile(wrapper, `#!/bin/sh\nexec /usr/bin/sandbox-exec -f "${profile}" "${puppeteer.executablePath()}" "$@"\n`);
  await chmod(wrapper, 0o755);
  return wrapper;
}

async function launch() {
  const downloads = await mkdtemp(join(tmpdir(), 'memfolio-dl-'));
  const profile = await mkdtemp(join(tmpdir(), 'memfolio-profile-'));
  // Chrome asks once before a site saves several files in a row; the test profile answers "allow".
  await mkdir(join(profile, 'Default'), { recursive: true });
  await writeFile(
    join(profile, 'Default', 'Preferences'),
    JSON.stringify({ profile: { default_content_setting_values: { automatic_downloads: 1 } } }),
  );
  // The browser also gets a throwaway home folder, so its crash-reporter settings and default
  // download location do not land in the real one.
  const home = await mkdtemp(join(tmpdir(), 'memfolio-home-'));
  const browser = await puppeteer.launch({
    headless: true,
    pipe: true,
    enableExtensions: true,
    userDataDir: profile,
    args: ['--no-sandbox'],
    env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home },
    executablePath: process.env.MEMFOLIO_E2E_BROWSER || (await sandboxedBrowser(home)),
  });
  const extensionId = await browser.installExtension(EXT_DIR);
  // Downloads the browser starts are observed by name. With request interception active the
  // files themselves do not always finish writing, so the suite does not wait for them on disk.
  const begun = [];
  const session = await browser.target().createCDPSession();
  await session.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  session.on('Browser.downloadWillBegin', (e) => begun.push(e.suggestedFilename));
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${extensionId}/popup.html`);
  for (const key of ['downloadAll', 'fullScan']) RUN_LABELS.add(await ext.evaluate((k) => chrome.i18n.getMessage(k), key));

  const ctx = {
    browser,
    ext,
    extensionId,
    /** File names of downloads handed to the browser so far. */
    browserDownloads: begun,
    /** Localised UI text, read from the extension itself so the suite runs under any UI language. */
    msg: (key, ...subs) => ext.evaluate((k, s) => chrome.i18n.getMessage(k, s), key, subs.map(String)),
    storage: () => ext.evaluate(() => chrome.storage.local.get(null)),
    account: async (id) => (await ctx.storage())[`account:instagram:${id}`] ?? null,
    async open(path, state) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 900 });
      page.on('pageerror', (e) => console.log('   [page error]', e.message));
      page.on('console', (m) => {
        if (process.env.E2E_VERBOSE) console.log(`   ${String(Date.now() % 100000).padStart(5)} [${m.type()}]`, m.text());
      });
      await installMock(page, state);
      await browser.setCookie({ name: 'csrftoken', value: 'CSRFTOKEN', domain: 'www.instagram.com', path: '/', secure: true });
      await page.goto(ORIGIN + path, { waitUntil: 'load' });
      return page;
    },
    async close() {
      // Unfinished downloads can keep the browser from closing; do not wait for it indefinitely.
      await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 3000))]);
      browser.process()?.kill('SIGKILL');
      await rm(downloads, { recursive: true, force: true });
      await rm(profile, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
  return ctx;
}

// ---- page helpers -----------------------------------------------------------

/** Visible text of the extension's in-page surface (toasts, card, dialogs). */
const surfaceText = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('memfolio-surface')?.shadowRoot;
    return root ? [...root.querySelectorAll('.dock, .overlay')].map((e) => e.innerText).join('\n') : '';
  });

const dialogText = (page) =>
  page.evaluate(() => document.querySelector('memfolio-surface')?.shadowRoot?.querySelector('.overlay')?.innerText ?? '');

const waitText = (page, text, timeout) =>
  waitFor(async () => (await surfaceText(page)).includes(text), `text "${text}"`, timeout).catch(async (e) => {
    throw new Error(`${e.message}\n   surface shows: ${JSON.stringify(await surfaceText(page))}`);
  });

/** Media files the extension asked the media host for (page thumbnails use the "_small" rendition). */
const mediaFetched = (state) => state.mediaRequests.filter((p) => !p.includes('_small'));

/** Labels of the buttons that start an account run; filled in at launch. */
const RUN_LABELS = new Set();
const runsDone = (page) => page.evaluate(() => Number(document.documentElement.dataset.memfolioRunsDone ?? 0));
/** Runs finished on a page at the moment the last run was started there. */
const runsAtStart = new WeakMap();

async function click(page, label) {
  if (RUN_LABELS.has(label)) runsAtStart.set(page, await runsDone(page));
  const handle = await waitFor(async () => {
    const h = await page.evaluateHandle((l) => {
      const root = document.querySelector('memfolio-surface')?.shadowRoot;
      // An open dialog covers everything else, as it does for a person.
      const scope = root?.querySelector('.overlay') ?? root;
      return [...(scope?.querySelectorAll('button') ?? [])].find((b) => b.innerText.trim() === l) ?? null;
    }, label);
    return h.asElement();
  }, `button "${label}"`);
  await handle.click();
}

/** Points at an element and presses the floating download button that appears over it. */
async function clickHover(page, selector) {
  await page.hover(selector);
  const handle = await waitFor(async () => {
    const h = await page.evaluateHandle(() => document.querySelector('memfolio-surface')?.shadowRoot?.querySelector('.hoverbtn') ?? null);
    return h.asElement();
  }, `the floating button over ${selector}`).catch(async (e) => {
    const at = await page.evaluate((sel) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      return { x, y, stack: document.elementsFromPoint(x, y).slice(0, 5).map((el) => el.tagName + (el.className ? '.' + el.className : '')) };
    }, selector);
    throw new Error(`${e.message}; at the element centre: ${JSON.stringify(at)}`);
  });
  await handle.click();
}

const setPick = (page, name) => page.evaluate((n) => (document.documentElement.dataset.memfolioPick = n), name);

const closeToasts = (page) =>
  page.evaluate(() => document.querySelector('memfolio-surface')?.shadowRoot?.querySelectorAll('.toast .x').forEach((b) => b.click()));

const opfs = {
  list: (page, path) =>
    page.evaluate(async (p) => {
      let dir = await navigator.storage.getDirectory();
      try {
        for (const part of p.split('/')) dir = await dir.getDirectoryHandle(part);
      } catch {
        return null;
      }
      const out = [];
      for await (const [name, h] of dir.entries()) out.push({ name, size: h.kind === 'file' ? (await h.getFile()).size : -1 });
      return out.sort((a, b) => a.name.localeCompare(b.name));
    }, path),
  names: async (page, path) => (await opfs.list(page, path))?.map((f) => f.name) ?? null,
  seed: (page, path, names, size = 16) =>
    page.evaluate(
      async (p, ns, s) => {
        let dir = await navigator.storage.getDirectory();
        for (const part of p.split('/')) dir = await dir.getDirectoryHandle(part, { create: true });
        for (const name of ns) {
          const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
          await w.write(new Uint8Array(s));
          await w.close();
        }
      },
      path,
      names,
      size,
    ),
  remove: (page, parentPath, name) =>
    page.evaluate(
      async (p, n) => {
        let dir = await navigator.storage.getDirectory();
        for (const part of p.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part);
        await dir.removeEntry(n, { recursive: true });
      },
      parentPath,
      name,
    ),
};

const callsNamed = (state, name) => state.calls.filter((c) => c.name === name);
const POSTS = 'PolarisProfilePostsTabContentQuery_connection';

/** Presses Download All on a profile that has no folder yet and picks the download root. */
async function firstRun(ctx, page, rootName = 'root') {
  await setPick(page, rootName);
  await click(page, await ctx.msg('downloadAll'));
  await waitText(page, await ctx.msg('pickRootTitle'));
  await click(page, await ctx.msg('chooseFolder'));
}

const hasButton = (page, label) =>
  page.evaluate((l) => {
    const root = document.querySelector('memfolio-surface')?.shadowRoot;
    return [...(root?.querySelectorAll('button') ?? [])].some((b) => b.innerText.trim() === l);
  }, label);

/** Waits for the run started by the last press of Download All or Full scan on this page to end. */
const runFinished = (ctx, page) =>
  waitFor(async () => (await runsDone(page)) > (runsAtStart.get(page) ?? 0) && (await hasButton(page, await ctx.msg('downloadAll'))), 'the run to finish', 30000);

// ---- scenarios --------------------------------------------------------------

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('first run downloads every file, then runs are incremental', async (ctx) => {
  const state = newState({ posts: makeTimeline(30) });
  const page = await ctx.open('/acct/', state);
  await waitText(page, '@acct');
  await waitText(page, await ctx.msg('cardNotManaged'));

  await firstRun(ctx, page);
  await runFinished(ctx, page);

  const expected = expectedFiles(state.posts);
  assertEqual(await opfs.names(page, 'root/acct'), expected, 'files written on the first run');
  assert((await opfs.list(page, 'root/acct')).every((f) => f.size > 0), 'no empty files');
  assertEqual(callsNamed(state, POSTS).length, 3, 'listing requests for 30 posts');
  assertEqual(callsNamed(state, 'PolarisSearchBoxRefetchableQuery').length, 0, 'no search when the page knows the account id');
  const first = callsNamed(state, POSTS)[0];
  assertEqual(Object.keys(first.params).sort(), ['doc_id', 'variables'], 'posts query is sent with the minimal parameter set');
  assertEqual(first.params.doc_id, DOC_IDS[POSTS], 'query id comes from the page');
  assertEqual(first.headers['x-csrftoken'], 'CSRFTOKEN', 'csrf header');
  assertEqual(first.vars.username, 'acct', 'listing by username');

  let record = await ctx.account('42');
  assertEqual(
    [record.username, record.folderName, record.relPath, record.fileCount, record.lastStatus, record.needsFullScan.posts],
    ['acct', 'acct', 'root/acct', expected.length, 'ok', false],
    'summary after the first run',
  );
  assert((await surfaceText(page)).includes(await ctx.msg('resultSaved', 'root/acct', expected.length, 0)), 'result message');

  // Two new posts: page 1 has new media, page 2 is fully on disk, so listing stops there.
  await closeToasts(page);
  state.posts.unshift(makePost(32), makePost(31));
  state.calls.length = 0;
  await click(page, await ctx.msg('downloadAll'));
  const knownOnTwoPages = expectedFiles(state.posts.slice(2, 24)).length;
  await waitText(page, await ctx.msg('resultSaved', 'root/acct', 2, knownOnTwoPages));
  assertEqual(callsNamed(state, POSTS).length, 2, 'incremental run stops at the first fully known page');
  assertEqual((await opfs.names(page, 'root/acct')).length, expected.length + 2, 'two files added');

  // Nothing new: one request.
  const firstPageMedia = expectedFiles(state.posts.slice(0, 12)).length;
  await closeToasts(page);
  state.calls.length = 0;
  await click(page, await ctx.msg('downloadAll'));
  await waitText(page, await ctx.msg('resultSaved', 'root/acct', 0, firstPageMedia));
  assertEqual(callsNamed(state, POSTS).length, 1, 'one request when nothing is new');

  // A gap in old media is invisible to an incremental run and filled by a full scan.
  const oldest = expectedFiles([state.posts.at(-1)])[0];
  await opfs.remove(page, 'root/acct', oldest);
  await closeToasts(page);
  state.calls.length = 0;
  await click(page, await ctx.msg('downloadAll'));
  await waitText(page, await ctx.msg('resultSaved', 'root/acct', 0, firstPageMedia));
  assert(!(await opfs.names(page, 'root/acct')).includes(oldest), 'incremental run does not reach the old gap');

  await closeToasts(page);
  state.calls.length = 0;
  await click(page, await ctx.msg('fullScan'));
  await runFinished(ctx, page);
  assertEqual(callsNamed(state, POSTS).length, 3, 'full scan lists every page');
  assert((await opfs.names(page, 'root/acct')).includes(oldest), 'full scan restores the missing file');

  record = await ctx.account('42');
  assertEqual(record.fileCount, expected.length + 2, 'file count in the summary');
});

scenario('rate limiting is retried, a login redirect stops the run', async (ctx) => {
  const state = newState({ posts: makeTimeline(14), failStatuses: [429, 503] });
  const page = await ctx.open('/acct/', state);
  await firstRun(ctx, page);
  await runFinished(ctx, page);
  assertEqual(callsNamed(state, POSTS).length, 4, 'two failed attempts, then two pages');
  assertEqual((await opfs.names(page, 'root/acct')).length, expectedFiles(state.posts).length, 'all files after retries');

  await closeToasts(page);
  state.posts.unshift(makePost(15));
  state.loginRedirect = true;
  state.calls.length = 0;
  await click(page, await ctx.msg('downloadAll'));
  await runFinished(ctx, page);
  assertEqual(callsNamed(state, POSTS).length, 1, 'no retry after a login redirect');
  assert((await surfaceText(page)).includes((await ctx.msg('stopLogin', '')).split('(')[0].trim()), 'login stop is explained');
  const record = await ctx.account('42');
  assertEqual([record.lastStatus, record.needsFullScan.posts], ['stopped', true], 'summary after the stop');

  // The interrupted listing forces the next run to walk every page.
  await closeToasts(page);
  state.loginRedirect = false;
  state.calls.length = 0;
  await click(page, await ctx.msg('downloadAll'));
  await runFinished(ctx, page);
  assertEqual(callsNamed(state, POSTS).length, 2, 'forced full scan lists both pages');
  assertEqual((await ctx.account('42')).needsFullScan.posts, false, 'flag cleared after a complete run');
});

scenario('cancelling leaves no partial file and the next run completes', async (ctx) => {
  const state = newState({ posts: makeTimeline(12), mediaDelayMs: 150 });
  const page = await ctx.open('/acct/', state);
  await firstRun(ctx, page);
  await waitFor(async () => (await opfs.names(page, 'root/acct'))?.length >= 2, 'the first downloads');
  await click(page, await ctx.msg('cancel'));
  await waitText(page, await ctx.msg('resultCancelled'));
  await runFinished(ctx, page);

  const expected = expectedFiles(state.posts);
  const after = await opfs.list(page, 'root/acct');
  assert(after.length < expected.length, 'run was cut short');
  assert(after.every((f) => f.size > 0 && expected.includes(f.name)), 'only complete, expected files remain');
  // Oldest media is downloaded first.
  assert(after.some((f) => f.name === expectedFiles([state.posts.at(-1)])[0]), 'oldest file is among those written');

  state.mediaDelayMs = 0;
  await closeToasts(page);
  await click(page, await ctx.msg('downloadAll'));
  await runFinished(ctx, page);
  assertEqual(await opfs.names(page, 'root/acct'), expected, 'second run fills in the rest');
});

scenario('a missing folder is reported before any request and can be reconnected', async (ctx) => {
  const state = newState({ posts: makeTimeline(6) });
  const page = await ctx.open('/acct/', state);
  await firstRun(ctx, page);
  await runFinished(ctx, page);
  const expected = expectedFiles(state.posts);

  await opfs.remove(page, 'root', 'acct');
  await closeToasts(page);
  state.calls.length = 0;
  await click(page, await ctx.msg('downloadAll'));
  await waitText(page, await ctx.msg('folderMissingTitle'));
  assertEqual(state.calls.length, 0, 'no request is sent while the folder is missing');
  assertEqual(await opfs.names(page, 'root'), [], 'no replacement folder is created');
  await click(page, await ctx.msg('cancel'));
  await runFinished(ctx, page);
  assertEqual((await ctx.account('42')).lastStatus, 'folder-missing', 'summary records the missing folder');

  // Picking a folder without this account's files asks first.
  await opfs.seed(page, 'moved/empty', []);
  await setPick(page, 'moved/empty');
  await click(page, await ctx.msg('downloadAll'));
  await waitText(page, await ctx.msg('folderMissingTitle'));
  await click(page, await ctx.msg('chooseFolder'));
  await waitText(page, await ctx.msg('wrongFolderTitle'));
  assertEqual(state.calls.length, 0, 'still no request');

  // Picking the folder where the files now live continues without downloading again.
  await opfs.seed(page, 'moved/acct', expected);
  await setPick(page, 'moved/acct');
  await click(page, await ctx.msg('chooseAnother'));
  await runFinished(ctx, page);
  assert((await surfaceText(page)).includes(await ctx.msg('resultSaved', 'acct', 0, expected.length)), 'nothing is downloaded again');
  assertEqual(mediaFetched(state).length, expected.length, 'media was requested only during the first run');
  assertEqual((await ctx.account('42')).lastStatus, 'ok', 'summary is back to ok');
});

scenario('import registers existing folders and shows their relative path', async (ctx) => {
  const state = newState({ posts: makeTimeline(8) });
  const page = await ctx.open('/', state);
  const all = expectedFiles(state.posts);
  const have = all.slice(0, 5);
  await opfs.seed(page, 'archive/alice/instagram', [...have, 'guest_1700000001_3000000000000009999_77.jpg', 'notes.txt']);
  await opfs.seed(page, 'archive/bob/instagram', ['bob.b_1700000002_3000000000000008888_99.jpg']);
  await opfs.seed(page, 'archive/copy', have.slice(0, 2));

  // What the popup leaves behind when it has to open a new tab for the import.
  await ctx.ext.evaluate(() => chrome.storage.local.set({ pendingTool: { tool: 'import', at: Date.now() } }));
  await page.reload({ waitUntil: 'load' });
  await waitText(page, await ctx.msg('importTitle'));
  assertEqual('pendingTool' in (await ctx.storage()), false, 'the import request is taken');
  await setPick(page, 'archive');
  await click(page, await ctx.msg('chooseFolder'));
  await waitText(page, await ctx.msg('importConfirm'));
  const text = await dialogText(page);
  for (const expectedText of ['@acct', 'archive/alice/instagram', '@bob.b', 'archive/bob/instagram', 'archive/copy', await ctx.msg('importFlagDuplicate')]) {
    assert(text.includes(expectedText), `import table shows "${expectedText}"`);
  }
  await click(page, await ctx.msg('importConfirm'));
  await waitText(page, await ctx.msg('importDone', 2));

  const acct = await ctx.account('42');
  assertEqual(
    [acct.username, acct.relPath, acct.fileCount, acct.lastStatus],
    ['acct', 'archive/alice/instagram', 6, 'imported'],
    'imported account (the folder with most files wins)',
  );
  assertEqual((await ctx.account('99')).relPath, 'archive/bob/instagram', 'second imported account');
  assertEqual(await ctx.account('77'), null, 'minor owners of a folder are not imported');

  // The profile now downloads into the imported folder without asking for a root.
  const profile = await ctx.open('/acct/', state);
  await waitText(profile, 'archive/alice/instagram');
  await click(profile, await ctx.msg('downloadAll'));
  await runFinished(ctx, profile);
  const names = await opfs.names(profile, 'archive/alice/instagram');
  assert(all.every((n) => names.includes(n)), 'missing files were added to the imported folder');
  assertEqual(mediaFetched(state).length, all.length - have.length, 'only missing media was requested');
});

scenario('reels and tagged tabs list their own content', async (ctx) => {
  const reels = [makePost(9, { kind: 'video' }), makePost(8, { kind: 'video' })];
  const tagged = [makePost(20, { owner: '77', username: 'friend' }), makePost(19, { owner: '88', username: 'other' })];
  const state = newState({ posts: makeTimeline(3), reels, tagged, mediaInfo: 'dead' });

  const page = await ctx.open('/acct/reels/', state);
  await waitText(page, await ctx.msg('tabReels'));
  await firstRun(ctx, page);
  await runFinished(ctx, page);
  assertEqual(await opfs.names(page, 'root/acct'), expectedFiles(reels), 'reels are saved after resolving each video');
  assertEqual(callsNamed(state, 'PolarisProfileReelsTabContentQuery_connection')[0].vars.data.target_user_id, '42', 'reels are listed by account id');
  assertEqual(callsNamed(state, POSTS).length, 0, 'the main grid is not listed from the reels tab');
  assertEqual(callsNamed(state, 'mediaInfo').length, 1, 'a dead info endpoint is tried once per session');
  assertEqual(callsNamed(state, 'PolarisPostRootQuery').length, 2, 'each new reel is resolved through the post query');
  const resolve = callsNamed(state, 'PolarisPostRootQuery')[0];
  assertEqual([resolve.params.fb_dtsg, resolve.params.lsd, resolve.params.fb_api_req_friendly_name], ['DTSGTOKEN', 'LSDTOKEN', 'PolarisPostRootQuery'], 'session parameters on other queries');

  const tab = await ctx.open('/acct/tagged/', state);
  await waitText(tab, await ctx.msg('tabTagged'));
  await click(tab, await ctx.msg('downloadAll'));
  await runFinished(ctx, tab);
  const names = await opfs.names(tab, 'root/acct');
  assert(expectedFiles(tagged).every((n) => names.includes(n)), 'tagged posts keep their author in the file name');
  assertEqual(callsNamed(state, 'PolarisProfileTaggedTabContentQuery_connection')[0].vars.user_id, '42', 'tagged posts are listed by account id');
  const record = await ctx.account('42');
  assertEqual([record.needsFullScan.reels, record.needsFullScan.tagged, record.fileCount], [false, false, 4], 'summary covers both tabs');
});

scenario('account id falls back to the search query when the page does not hold it', async (ctx) => {
  const state = newState({ posts: makeTimeline(2), relayUsers: [], searchUsers: [{ username: 'acct_fan', pk: '1' }, { username: 'acct', pk: '42' }] });
  const page = await ctx.open('/acct/tagged/', state);
  await firstRun(ctx, page);
  await runFinished(ctx, page);
  assertEqual(callsNamed(state, 'PolarisSearchBoxRefetchableQuery').length, 1, 'one search request');
  assertEqual((await ctx.account('42'))?.username, 'acct', 'account registered under the id found by search');
});

scenario('a single post goes into the account folder when managed, else to browser downloads', async (ctx) => {
  const state = newState({ posts: makeTimeline(5) });
  const profile = await ctx.open('/acct/', state);
  await firstRun(ctx, profile);
  await runFinished(ctx, profile);
  // Pointing at a thumbnail offers the whole post; the page's own markup is left as it was.
  const markup = await profile.evaluate(() => document.getElementById('grid').innerHTML);
  await closeToasts(profile);
  await clickHover(profile, '#grid a:first-child');
  const newest = expectedFiles([state.posts[0]]).length;
  await waitText(profile, await ctx.msg('savedFolder', 'root/acct', 0, newest));
  assertEqual(await profile.evaluate(() => location.pathname), '/acct/', 'the thumbnail button does not follow the link');
  assertEqual(await profile.evaluate(() => document.getElementById('grid').innerHTML), markup, 'nothing is inserted into the grid');

  const before = await opfs.names(profile, 'root/acct');

  // A new carousel by the managed account.
  const fresh = makePost(40, { kind: 'carousel' });
  state.extraPosts.push(fresh);
  const post = await ctx.open(`/p/${fresh.code}/`, state);

  // Pointing at one slide offers that slide only.
  await clickHover(post, 'article li:nth-child(2)');
  await waitText(post, await ctx.msg('savedFolder', 'root/acct', 1, 0));
  const second = expectedFiles([fresh])[1];
  assertEqual((await opfs.names(post, 'root/acct')).filter((n) => !before.includes(n)), [second], 'only the clicked slide is saved');

  // The post button saves the rest and skips what is there.
  await closeToasts(post);
  const button = await waitFor(() => post.$('.memfolio-post-btn'), 'the post button');
  await button.click();
  await waitText(post, await ctx.msg('savedFolder', 'root/acct', 2, 1));
  const after = await opfs.names(post, 'root/acct');
  assertEqual(after.length, before.length + 3, 'carousel saved into the account folder');
  assertEqual((await ctx.account('42')).fileCount, after.length, 'summary file count follows');

  // Pressing again skips what is there.
  await closeToasts(post);
  await (await post.$('.memfolio-post-btn')).click();
  await waitText(post, await ctx.msg('savedFolder', 'root/acct', 0, 3));

  // A post by an account that is not managed uses the browser's download handling.
  const foreign = makePost(50, { owner: '555', username: 'stranger' });
  state.extraPosts.push(foreign);
  const other = await ctx.open(`/reel/${foreign.code}/`, state);
  await (await waitFor(() => other.$('.memfolio-post-btn'), 'the post button')).click();
  await waitText(other, await ctx.msg('savedBrowser', 1));
  const wanted = expectedFiles([foreign])[0];
  await waitFor(() => ctx.browserDownloads.includes(wanted), `browser download of ${wanted}`);
  assertEqual(await ctx.account('555'), null, 'a single download does not register an account');
});

scenario('the post button waits until the page has taken over its markup', async (ctx) => {
  const post = makePost(70);
  const state = newState({ extraPosts: [post] });
  const page = await ctx.open(`/p/${post.code}/?late`, state);
  await new Promise((r) => setTimeout(r, 1200));
  assertEqual(await page.$$eval('.memfolio-post-btn', (l) => l.length), 0, 'server-rendered markup is not modified');
  // The framework takes over and, as it does on the real page, touches the DOM.
  await page.evaluate(() => {
    window.__hydrate();
    document.body.append(document.createElement('span'));
  });
  await waitFor(() => page.$('.memfolio-post-btn'), 'the post button after hydration');
});

scenario('stories are saved through the browser download', async (ctx) => {
  const item = (n, video) => {
    const { user: _user, ...rest } = makePost(n, { kind: video ? 'video' : 'image' });
    return { ...rest, id: rest.pk };
  };
  const state = newState({ story: { id: '42', user: { username: 'acct', pk: '42' }, items: [item(61, false), item(62, true)] } });
  const page = await ctx.open(`/stories/acct/${item(62).pk}/`, state);
  await click(page, await ctx.msg('btnStory'));
  await waitText(page, await ctx.msg('savedBrowser', 1));
  const second = `acct_${1700000000 + 62 * 1000}_${item(62).pk}_42.mp4`;
  await waitFor(() => ctx.browserDownloads.includes(second), 'the current story');
  assertEqual(ctx.browserDownloads, [second], 'only the story on screen is saved');
  assertEqual(callsNamed(state, 'PolarisStoriesV3ReelPageGalleryQuery')[0].vars.reel_ids, ['42'], 'stories are requested by account id');

  await closeToasts(page);
  await click(page, await ctx.msg('btnStoryAll'));
  await waitText(page, await ctx.msg('savedBrowser', 2));
  const first = `acct_${1700000000 + 61 * 1000}_${item(61).pk}_42.jpg`;
  await waitFor(() => ctx.browserDownloads.length === 3, 'all stories');
  assertEqual(ctx.browserDownloads.slice(1), [first, second], 'every story item is saved, oldest first');
});

scenario('the folder check reports what the browser exposes for a picked folder', async (ctx) => {
  const state = newState({ posts: makeTimeline(4) });
  const page = await ctx.open('/acct/', state);
  await firstRun(ctx, page);
  await runFinished(ctx, page);
  const files = await opfs.names(page, 'root/acct');
  await closeToasts(page);

  // The tool is offered only in developer mode.
  assertEqual(await hasButton(page, await ctx.msg('checkOpen')), false, 'hidden by default');
  await ctx.ext.evaluate(() => chrome.storage.local.set({ settings: { developerMode: true } }));
  await waitFor(async () => hasButton(page, await ctx.msg('checkOpen')), 'the folder check link in developer mode');

  // The account's own folder, reached from the download folder through ordinary folders.
  await click(page, await ctx.msg('checkOpen'));
  await waitText(page, await ctx.msg('checkIntro').then((m) => m.split('\n')[0]));
  await setPick(page, 'root/acct');
  await click(page, await ctx.msg('chooseFolder'));
  await waitText(page, await ctx.msg('checkKindReal', 'root'));
  let text = await dialogText(page);
  for (const part of ['@acct', await ctx.msg('checkLocInside', 'root/acct'), await ctx.msg('checkReadOk', files.length, files.length, 0), await ctx.msg('checkWriteNotRun')]) {
    assert(text.includes(part), `folder check shows "${part}"`);
  }

  await click(page, await ctx.msg('checkBtnWrite'));
  await waitText(page, await ctx.msg('checkWriteOk'));
  assertEqual(await opfs.names(page, 'root/acct'), files, 'the write test leaves nothing behind');

  await click(page, await ctx.msg('checkBtnCompare'));
  await waitText(page, await ctx.msg('checkCmpSameEntry'));

  // A copy elsewhere: nothing known contains it, so its kind cannot be told until a parent is picked.
  await opfs.seed(page, 'copy/acct', files);
  await setPick(page, 'copy/acct');
  await click(page, await ctx.msg('checkBtnAgain'));
  await waitText(page, await ctx.msg('checkKindUnknown'));
  await setPick(page, 'root');
  await click(page, await ctx.msg('checkBtnParent'));
  await waitText(page, await ctx.msg('checkParentOutside', 'root'));
  await setPick(page, 'copy');
  await click(page, await ctx.msg('checkBtnParent'));
  await waitText(page, await ctx.msg('checkKindReal', 'copy'));

  // Same file names as the account folder, yet a separate place.
  await setPick(page, 'root/acct');
  await click(page, await ctx.msg('checkBtnCompare'));
  await waitText(page, await ctx.msg('checkCmpSameListing', files.length));
  await click(page, await ctx.msg('checkBtnMarker'));
  await waitText(page, await ctx.msg('checkMarkerSeparate'));
  assertEqual(await opfs.names(page, 'root/acct'), files, 'no marker left in the account folder');
  assertEqual(await opfs.names(page, 'copy/acct'), files, 'no marker left in the copy');

  // The results leave as a JSON file; the dialog stays open.
  await click(page, await ctx.msg('checkBtnExport'));
  await waitFor(() => ctx.browserDownloads.some((name) => /^memfolio-folder-check-\d{8}-\d{6}\.json$/.test(name)), 'the exported JSON file');
  assert((await dialogText(page)).includes(await ctx.msg('checkMarkerSeparate')), 'the results are still shown after exporting');

  await click(page, await ctx.msg('close'));
  assertEqual(await dialogText(page), '', 'the check closes');
});

scenario('developer mode is switched in the popup settings', async (ctx) => {
  const popup = await ctx.browser.newPage();
  await popup.goto(`chrome-extension://${ctx.extensionId}/popup.html`);
  await waitFor(async () => (await popup.$eval('#options', (e) => e.title)) === (await ctx.msg('popupOptions')), 'the popup');
  assertEqual(await popup.$('#check'), null, 'the popup has no folder check entry');
  assertEqual(await popup.$('footer'), null, 'the popup has no bottom row');
  assertEqual(await popup.$eval('#settings', (e) => e.hidden), true, 'the settings are closed at first');

  await popup.click('#options');
  assertEqual(await popup.$eval('#settings', (e) => e.hidden), false, 'the settings open inside the popup');
  assertEqual(await popup.$eval('#accounts', (e) => e.hidden), true, 'the account list makes room');
  assertEqual(await popup.$eval('#developer-mode-name', (e) => e.textContent), await ctx.msg('optDevMode'), 'the setting is named');
  assertEqual(await popup.$eval('#developer-mode', (e) => e.checked), false, 'developer mode is off by default');
  await popup.click('#developer-mode');
  await waitFor(async () => (await ctx.storage()).settings?.developerMode === true, 'the setting to be stored');

  await popup.click('#back');
  assertEqual(await popup.$eval('#accounts', (e) => e.hidden), false, 'back to the account list');
  assertEqual(await popup.$eval('#options', (e) => e.hidden), false, 'the settings button is back');

  // The import is started from the settings; without a platform tab in front it leaves a request for a new one.
  await popup.evaluate(() => {
    window.__opened = [];
    chrome.tabs.create = async (options) => {
      window.__opened.push(options.url);
      return {};
    };
    window.close = () => {};
  });
  await popup.click('#options');
  assertEqual(await popup.$eval('#import', (e) => e.textContent), await ctx.msg('popupImportStart'), 'the import entry sits in the settings');
  await popup.click('#import');
  await waitFor(async () => (await ctx.storage()).pendingTool?.tool === 'import', 'the import request to be stored');
  await waitFor(async () => (await popup.evaluate(() => window.__opened.length)) === 1, 'a platform tab to be opened');
  assertEqual(await popup.evaluate(() => window.__opened), [`${ORIGIN}/`], 'the new tab is the platform home, without a marker in the address');
  await ctx.ext.evaluate(() => chrome.storage.local.remove('pendingTool'));

  const manifest = JSON.parse(await readFile(join(EXT_DIR, 'manifest.json'), 'utf8'));
  assertEqual('options_ui' in manifest || 'options_page' in manifest, false, 'no separate options page');
});

scenario('the language is chosen in the popup settings', async (ctx) => {
  const zh = JSON.parse(await readFile(join(EXT_DIR, '_locales/zh_TW/messages.json'), 'utf8'));
  const page = await ctx.open('/acct/', newState({ posts: makeTimeline(1) }));
  await waitFor(async () => hasButton(page, await ctx.msg('downloadAll')), 'the account card');

  const popup = await ctx.browser.newPage();
  await popup.goto(`chrome-extension://${ctx.extensionId}/popup.html`);
  await waitFor(async () => (await popup.$eval('#options', (e) => e.title)) === (await ctx.msg('popupOptions')), 'the popup');
  await popup.click('#options');
  assertEqual(await popup.$eval('#language', (e) => e.value), 'auto', 'the language follows the browser by default');
  assertEqual(await popup.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'the settings do not scroll sideways');

  await popup.select('#language', 'zh_TW');
  await waitFor(async () => (await ctx.storage()).settings?.language === 'zh_TW', 'the setting to be stored');
  await waitFor(async () => (await popup.$eval('#developer-mode-name', (e) => e.textContent)) === zh.optDevMode.message, 'the settings in the chosen language');
  assertEqual(await popup.$eval('#import', (e) => e.textContent), zh.popupImportStart.message, 'the import entry in the chosen language');

  // A tab that was already open follows the change.
  await waitFor(() => hasButton(page, zh.downloadAll.message), 'the open account card in the chosen language');
  // A tab loaded afterwards starts in the chosen language, and so does a popup opened afterwards.
  const later = await ctx.open('/acct/', newState({ posts: makeTimeline(1) }));
  await waitFor(() => hasButton(later, zh.downloadAll.message), 'a new account card in the chosen language');
  const popupLater = await ctx.browser.newPage();
  await popupLater.goto(`chrome-extension://${ctx.extensionId}/popup.html`);
  await waitFor(async () => (await popupLater.$eval('#options', (e) => e.title)) === zh.popupOptions.message, 'a new popup in the chosen language');

  await popup.select('#language', 'auto');
  await waitFor(async () => (await ctx.storage()).settings?.language === 'auto', 'the setting to be restored');
  await waitFor(async () => (await popup.$eval('#developer-mode-name', (e) => e.textContent)) === (await ctx.msg('optDevMode')), 'the settings in the browser language');
  await waitFor(async () => hasButton(page, await ctx.msg('downloadAll')), 'the open account card back in the browser language');
});

scenario('popup lists accounts, opens profiles and removes entries', async (ctx) => {
  const state = newState({ posts: makeTimeline(3) });
  const page = await ctx.open('/acct/', state);
  await firstRun(ctx, page);
  await runFinished(ctx, page);

  const popup = await ctx.browser.newPage();
  await popup.goto(`chrome-extension://${ctx.extensionId}/popup.html`);
  await waitFor(() => popup.$('.row'), 'a popup row');
  const rowText = await popup.$eval('.row', (r) => r.innerText);
  for (const part of ['@acct', 'root/acct', await ctx.msg('popupFiles', 3)]) assert(rowText.includes(part), `popup row shows "${part}"`);
  assertEqual(await popup.$eval('#count', (e) => e.textContent), await ctx.msg('popupCount', 1), 'account count');

  // Record the tab the popup asks for instead of letting it load the real site.
  await popup.evaluate(() => {
    window.__opened = [];
    chrome.tabs.create = async (options) => {
      window.__opened.push(options.url);
      return {};
    };
  });
  await popup.click('.row .open');
  assertEqual(await popup.evaluate(() => window.__opened), [`${ORIGIN}/acct/`], 'clicking a row opens the profile');

  await popup.hover('.row');
  await popup.click('.row .remove');
  assert((await ctx.account('42')) !== null, 'first click only asks');
  await popup.click('.row .remove');
  await waitFor(async () => (await ctx.account('42')) === null, 'the account to be removed');
  await waitFor(async () => (await popup.$eval('#list', (l) => l.innerText)).includes(await ctx.msg('popupEmpty')), 'the empty state');

  // The files stay on disk; only the list entry and, on the next page load, the stored handle go away.
  assertEqual((await opfs.names(page, 'root/acct')).length, 3, 'files are untouched by removal');
});

// ---- runner -----------------------------------------------------------------

let failed = 0;
for (const { name, fn } of scenarios) {
  if (only && !name.includes(only)) continue;
  const ctx = await launch();
  const started = Date.now();
  let timer;
  try {
    await Promise.race([
      fn(ctx),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('scenario exceeded 120 s')), 120_000))),
    ]);
    console.log(`ok    ${name} (${Date.now() - started} ms)`);
  } catch (e) {
    failed += 1;
    console.log(`FAIL  ${name}\n   ${e.stack ?? e}`);
  } finally {
    clearTimeout(timer);
    await Promise.race([ctx.close(), new Promise((r) => setTimeout(r, 5000))]);
  }
}
console.log(failed === 0 ? '\nall scenarios passed' : `\n${failed} scenario(s) failed`);
process.exit(failed === 0 ? 0 : 1);
