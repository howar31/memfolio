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
  for (const key of ['downloadAll', 'fullScan', 'cardElsewhere']) RUN_LABELS.add(await ext.evaluate((k) => chrome.i18n.getMessage(k), key));

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
    /** Opens a profile page and expands the account panel, which starts as a ball. */
    async openProfile(path, state) {
      const page = await ctx.open(path, state);
      await clickBall(page);
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

const ballExpanded = (page) =>
  page.evaluate(() => document.querySelector('memfolio-surface')?.shadowRoot?.querySelector('.ball')?.getAttribute('aria-expanded') ?? null);

/** Presses the ball that shows or hides the account panel. */
async function clickBall(page) {
  const handle = await waitFor(async () => {
    const h = await page.evaluateHandle(() => document.querySelector('memfolio-surface')?.shadowRoot?.querySelector('.ball') ?? null);
    return h.asElement();
  }, 'the ball');
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

/** Presses Download All on a profile that has no folder yet and picks the default location. */
async function firstRun(ctx, page, rootName = 'root') {
  await setPick(page, rootName);
  await click(page, await ctx.msg('downloadAll'));
  await waitText(page, await ctx.msg('defaultPickTitle'));
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
  const page = await ctx.openProfile('/acct/', state);
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
  const tabPosts = await ctx.msg('tabPosts');
  assert((await surfaceText(page)).includes(await ctx.msg('resultNew', tabPosts, expected.length)), 'result message');
  assert((await surfaceText(page)).includes(await ctx.msg('resultFolder', 'root/acct', expected.length)), 'the result names the folder total');

  // Two new posts: page 1 has new media, page 2 is fully on disk, so listing stops there.
  await closeToasts(page);
  state.posts.unshift(makePost(32), makePost(31));
  state.calls.length = 0;
  await click(page, await ctx.msg('downloadAll'));
  const knownOnTwoPages = expectedFiles(state.posts.slice(2, 24)).length;
  await waitText(page, await ctx.msg('resultNew', tabPosts, 2));
  assert((await surfaceText(page)).includes(await ctx.msg('resultScopeEarly', 24, 2 + knownOnTwoPages)), 'the result says how much was checked');
  assertEqual(callsNamed(state, POSTS).length, 2, 'incremental run stops at the first fully known page');
  assertEqual((await opfs.names(page, 'root/acct')).length, expected.length + 2, 'two files added');

  // Nothing new: one request.
  const firstPageMedia = expectedFiles(state.posts.slice(0, 12)).length;
  await closeToasts(page);
  state.calls.length = 0;
  await click(page, await ctx.msg('downloadAll'));
  await waitText(page, await ctx.msg('resultScopeEarly', 12, firstPageMedia));
  assertEqual(callsNamed(state, POSTS).length, 1, 'one request when nothing is new');

  // The result stays on screen; the next run replaces it instead of adding another.
  const before = Number(await page.evaluate(() => document.documentElement.dataset.memfolioRunsDone));
  await click(page, await ctx.msg('downloadAll'));
  await waitFor(async () => Number(await page.evaluate(() => document.documentElement.dataset.memfolioRunsDone)) > before, 'the next run to end');
  assertEqual(
    await page.evaluate(() => document.querySelector('memfolio-surface').shadowRoot.querySelectorAll('.toast').length),
    1,
    'one result on screen',
  );

  // A gap in old media is invisible to an incremental run and filled by a full scan.
  const oldest = expectedFiles([state.posts.at(-1)])[0];
  await opfs.remove(page, 'root/acct', oldest);
  await closeToasts(page);
  state.calls.length = 0;
  await click(page, await ctx.msg('downloadAll'));
  await waitText(page, await ctx.msg('resultScopeEarly', 12, firstPageMedia));
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

scenario('the account panel starts as a ball and opens on a click', async (ctx) => {
  const page = await ctx.open('/acct/', newState({ posts: makeTimeline(1) }));
  const downloadAll = await ctx.msg('downloadAll');
  await waitFor(async () => (await ballExpanded(page)) === 'false', 'the ball, not expanded');
  assertEqual(await hasButton(page, downloadAll), false, 'no Download All while the panel is closed');
  assert(!(await surfaceText(page)).includes('@acct'), 'no account name while the panel is closed');

  await clickBall(page);
  await waitFor(() => hasButton(page, downloadAll), 'the panel after a click on the ball');
  await waitText(page, '@acct');
  assertEqual(await ballExpanded(page), 'true', 'the ball reports the open panel');

  // Moving inside the site keeps the panel as it is.
  await page.evaluate(() => history.pushState(null, '', '/acct/reels/'));
  await waitText(page, await ctx.msg('cardListing', await ctx.msg('tabReels')));
  assertEqual(await hasButton(page, downloadAll), true, 'still open on another tab of the profile');

  await clickBall(page);
  await waitFor(async () => !(await hasButton(page, downloadAll)), 'the panel to close on a second click');

  await clickBall(page);
  await waitFor(() => hasButton(page, downloadAll), 'the panel to open again');
  await page.reload({ waitUntil: 'load' });
  await waitFor(async () => (await ballExpanded(page)) === 'false', 'the ball after a reload');
  assertEqual(await hasButton(page, downloadAll), false, 'closed again after a reload');
});

scenario('a closed ball hides the messages and shows that one is waiting', async (ctx) => {
  const page = await ctx.openProfile('/acct/', newState({ posts: makeTimeline(1) }));
  const dock = () =>
    page.evaluate(() => {
      const root = document.querySelector('memfolio-surface').shadowRoot;
      const el = root.querySelector('.dock');
      const dot = getComputedStyle(root.querySelector('.ball'), '::after');
      return {
        shown: [...root.querySelectorAll('.toast')].filter((t) => t.offsetParent !== null).length,
        waiting: el.dataset.waiting ?? null,
        dot: dot.content !== 'none' && dot.display !== 'none',
      };
    });
  await firstRun(ctx, page);
  await runFinished(ctx, page);
  assertEqual(await dock(), { shown: 1, waiting: 'info', dot: false }, 'the result beside the open panel');

  await clickBall(page);
  await waitFor(async () => (await ballExpanded(page)) === 'false', 'the panel to close');
  assertEqual(await dock(), { shown: 0, waiting: 'info', dot: true }, 'nothing but the ball and its dot');

  await clickBall(page);
  await waitFor(async () => (await ballExpanded(page)) === 'true', 'the panel to open');
  assertEqual(await dock(), { shown: 1, waiting: 'info', dot: false }, 'the result is back with the panel');

  await closeToasts(page);
  await clickBall(page);
  await waitFor(async () => (await ballExpanded(page)) === 'false', 'the panel to close again');
  assertEqual(await dock(), { shown: 0, waiting: null, dot: false }, 'no dot without a message');
});

scenario('the open panel clears every message at once, and the dot can be switched off', async (ctx) => {
  const state = newState({ posts: makeTimeline(1) });
  const page = await ctx.openProfile('/acct/', state);
  const clear = await ctx.msg('clearMessages');
  const dock = () =>
    page.evaluate(() => {
      const root = document.querySelector('memfolio-surface').shadowRoot;
      const dot = getComputedStyle(root.querySelector('.ball'), '::after');
      return {
        shown: [...root.querySelectorAll('.toast')].filter((t) => t.offsetParent !== null).length,
        held: root.querySelectorAll('.toast').length,
        waiting: root.querySelector('.dock').dataset.waiting ?? null,
        dot: dot.content !== 'none' && dot.display !== 'none',
      };
    });
  // The button is always in the surface; what counts is whether it is drawn.
  const canClear = () =>
    page.evaluate((l) => {
      const root = document.querySelector('memfolio-surface').shadowRoot;
      return [...root.querySelectorAll('button')].some((b) => b.textContent.trim() === l && b.offsetParent !== null);
    }, clear);
  await waitText(page, '@acct');
  assertEqual(await canClear(), false, 'nothing to clear without a message');

  await firstRun(ctx, page);
  await runFinished(ctx, page);
  await clickHover(page, '#grid a:first-child');
  // The single download has ended, so no message of its own arrives after the clearing.
  await waitText(page, await ctx.msg('savedBrowser', expectedFiles([state.posts[0]]).length));
  assertEqual((await dock()).shown, 2, 'two messages beside the open panel');
  assertEqual(await canClear(), true, 'the button sits with the messages');
  assertEqual(
    await page.evaluate(() => {
      const root = document.querySelector('memfolio-surface').shadowRoot;
      return root.querySelector('.clear').compareDocumentPosition(root.querySelector('.toasts')) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below';
    }),
    'above',
    'it is placed above them',
  );

  await click(page, clear);
  assertEqual(await dock(), { shown: 0, held: 0, waiting: null, dot: false }, 'every message is gone');
  assertEqual(await canClear(), false, 'the button leaves with them');
  await clickBall(page);
  await waitFor(async () => (await ballExpanded(page)) === 'false', 'the panel to close');
  assertEqual((await dock()).dot, false, 'no dot after clearing');

  // With the setting off the closed ball still holds the messages back, without the dot.
  await ctx.ext.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, messageDot: false } });
  });
  // The stored change redraws the ball; pressing it waits for that.
  await waitFor(() => page.evaluate(() => document.querySelector('memfolio-surface').shadowRoot.querySelector('.dock').classList.contains('nodot')), 'the page to take the setting');
  await clickBall(page);
  await click(page, await ctx.msg('downloadAll'));
  await runFinished(ctx, page);
  assertEqual((await dock()).shown, 1, 'a new result beside the open panel');
  await clickBall(page);
  await waitFor(async () => (await ballExpanded(page)) === 'false', 'the panel to close again');
  assertEqual(await dock(), { shown: 0, held: 1, waiting: 'info', dot: false }, 'the message is held back and the ball has no dot');
  await clickBall(page);
  await waitFor(async () => (await ballExpanded(page)) === 'true', 'the panel to open');
  assertEqual((await dock()).shown, 1, 'the message is back with the panel');

  // Switched on again, an open page follows without a reload.
  await clickBall(page);
  await waitFor(async () => (await ballExpanded(page)) === 'false', 'the panel to close once more');
  await ctx.ext.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, messageDot: true } });
  });
  await waitFor(async () => (await dock()).dot === true, 'the dot to return');

  // A page without a ball has no such button; its messages show as before.
  await clickBall(page);
  await waitFor(canClear, 'the button beside the open panel');
  await page.evaluate(() => history.pushState(null, '', '/'));
  await waitFor(async () => (await ballExpanded(page)) === null, 'the ball to leave on the home page');
  assertEqual((await dock().catch(() => null)) === null && (await page.evaluate(() => document.querySelector('memfolio-surface').shadowRoot.querySelectorAll('.toast').length)), 1, 'the message stays');
  assertEqual(await canClear(), false, 'no clear button where there is no ball');
});

scenario('rate limiting is retried, a login redirect stops the run', async (ctx) => {
  const state = newState({ posts: makeTimeline(14), failStatuses: [429, 503] });
  const page = await ctx.openProfile('/acct/', state);
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
  const page = await ctx.openProfile('/acct/', state);
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
  const page = await ctx.openProfile('/acct/', state);
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
  assert((await surfaceText(page)).includes(await ctx.msg('resultNone', await ctx.msg('tabPosts'))), 'nothing is downloaded again');
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

  // One of the accounts was pasted before, pinned and put into a group.
  await ctx.ext.evaluate(() =>
    chrome.storage.local.set({
      'pending:instagram:acct': { platform: 'instagram', username: 'acct', addedAt: 1, pinned: true },
      layout: { groups: [{ id: 'g1', name: 'One', collapsed: false }], groupOf: { 'instagram:@acct': 'g1' } },
    }),
  );
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
  const afterImport = await ctx.storage();
  assertEqual(
    [acct.pinned, afterImport.layout.groupOf, 'pending:instagram:acct' in afterImport],
    [true, { 'instagram:42': 'g1' }, false],
    'the pasted entry of an imported account hands over its pin and its group',
  );
  assertEqual(await ctx.account('77'), null, 'minor owners of a folder are not imported');

  assertEqual('defaultFolder:instagram' in (await ctx.storage()), false, 'the import sets no default location');
  // The profile now downloads into the imported folder without asking for a default location.
  const profile = await ctx.openProfile('/acct/', state);
  await waitText(profile, '… › archive › alice › instagram');
  await click(profile, await ctx.msg('downloadAll'));
  await runFinished(ctx, profile);
  const names = await opfs.names(profile, 'archive/alice/instagram');
  assert(all.every((n) => names.includes(n)), 'missing files were added to the imported folder');
  assertEqual(mediaFetched(state).length, all.length - have.length, 'only missing media was requested');
});

scenario('the default location is chosen once, shown in the settings and can be changed', async (ctx) => {
  const state = newState({ posts: makeTimeline(2) });
  const page = await ctx.openProfile('/acct/', state);
  await waitText(page, await ctx.msg('cardNotManaged'));
  await firstRun(ctx, page, 'first');
  await runFinished(ctx, page);
  assertEqual((await ctx.storage())['defaultFolder:instagram'], { name: 'first' }, 'the name of the default location is kept for the popup');
  assertEqual(await opfs.names(page, 'first/acct'), expectedFiles(state.posts), 'the first account is saved inside it');

  const popup = await ctx.browser.newPage();
  await popup.goto(`chrome-extension://${ctx.extensionId}/popup.html`);
  await waitFor(async () => (await popup.$eval('#options', (e) => e.title)) === (await ctx.msg('popupOptions')), 'the popup');
  await popup.click('#options');
  assertEqual(
    await popup.evaluate(() => ['default-value', 'default-change'].map((id) => document.getElementById(id).textContent)),
    ['first', await ctx.msg('optDefaultChange')],
    'the settings name the default location',
  );

  // What the popup leaves behind when it has to open a new tab for the change.
  await ctx.ext.evaluate(() => chrome.storage.local.set({ pendingTool: { tool: 'default', at: Date.now() } }));
  const home = await ctx.open('/', state);
  await waitText(home, await ctx.msg('defaultCurrent', 'first'));
  assertEqual('pendingTool' in (await ctx.storage()), false, 'the request is taken');
  await setPick(home, 'second');
  await click(home, await ctx.msg('chooseFolder'));
  await waitText(home, await ctx.msg('defaultChanged', 'second'));
  await waitFor(async () => (await popup.$eval('#default-value', (e) => e.textContent)) === 'second', 'the settings to follow');

  // An account already on the list keeps its folder.
  state.posts.unshift(makePost(3));
  await page.bringToFront();
  await closeToasts(page);
  await click(page, await ctx.msg('downloadAll'));
  await runFinished(ctx, page);
  assertEqual(await opfs.names(page, 'first/acct'), expectedFiles(state.posts), 'the listed account still saves into its folder');
  assertEqual(await opfs.names(page, 'second'), [], 'nothing was moved or created in the new location');

  // An account seen for the first time goes to the new location, without a question.
  const other = newState({ posts: makeTimeline(2, { owner: '43', username: 'other' }), relayUsers: [{ username: 'other', pk: '43' }] });
  const later = await ctx.openProfile('/other/', other);
  await waitText(later, await ctx.msg('cardDefaultTarget', 'second/other'));
  await click(later, await ctx.msg('downloadAll'));
  await runFinished(ctx, later);
  assertEqual(await dialogText(later), '', 'no question for the new account');
  assertEqual(await opfs.names(later, 'second/other'), expectedFiles(other.posts), 'the new account is saved inside the new location');
});

scenario('a new account can be saved outside the default location', async (ctx) => {
  const state = newState({ posts: makeTimeline(2) });
  const page = await ctx.openProfile('/acct/', state);
  const elsewhere = await ctx.msg('cardElsewhere');
  await waitFor(() => hasButton(page, elsewhere), 'the link for another folder');

  // Backing out leaves the account as it was.
  await click(page, elsewhere);
  await waitText(page, await ctx.msg('elsewhereMessage', 'acct'));
  await click(page, await ctx.msg('cancel'));
  await runFinished(ctx, page);
  assertEqual([await ctx.account('42'), state.calls.filter((c) => c.name === POSTS).length], [null, 0], 'no account and no listing after backing out');

  await setPick(page, 'custom/place');
  await click(page, elsewhere);
  await click(page, await ctx.msg('chooseFolder'));
  await runFinished(ctx, page);
  assertEqual(await opfs.names(page, 'custom/place'), expectedFiles(state.posts), 'the files are in the chosen folder');
  assertEqual((await ctx.account('42')).folderName, 'place', 'the account uses that folder');
  assertEqual('defaultFolder:instagram' in (await ctx.storage()), false, 'no default location was set');
  assertEqual(await hasButton(page, elsewhere), false, 'the link is gone once the account has a folder');

  // An account that has a folder is not offered the link.
  const other = await ctx.openProfile('/acct/', state);
  await waitText(other, '… › place');
  assertEqual(await hasButton(other, elsewhere), false, 'no link for a managed account');
});

scenario('reels and tagged tabs list their own content', async (ctx) => {
  const reels = [makePost(9, { kind: 'video' }), makePost(8, { kind: 'video' })];
  const tagged = [makePost(20, { owner: '77', username: 'friend' }), makePost(19, { owner: '88', username: 'other' })];
  const state = newState({ posts: makeTimeline(3), reels, tagged, mediaInfo: 'dead' });

  const page = await ctx.openProfile('/acct/reels/', state);
  await waitText(page, await ctx.msg('tabReels'));
  await firstRun(ctx, page);
  await runFinished(ctx, page);
  assertEqual(await opfs.names(page, 'root/acct'), expectedFiles(reels), 'reels are saved after resolving each video');
  assertEqual(callsNamed(state, 'PolarisProfileReelsTabContentQuery_connection')[0].vars.data.target_user_id, '42', 'reels are listed by account id');
  assertEqual(callsNamed(state, POSTS).length, 0, 'the main grid is not listed from the reels tab');
  assertEqual(await page.evaluate(() => window.__directRequires), [], 'modules are read without the lookup the page reports');
  assertEqual(callsNamed(state, 'mediaInfo').length, 1, 'a dead info endpoint is tried once per session');
  assertEqual(callsNamed(state, 'PolarisPostRootQuery').length, 2, 'each new reel is resolved through the post query');
  const resolve = callsNamed(state, 'PolarisPostRootQuery')[0];
  assertEqual([resolve.params.fb_dtsg, resolve.params.lsd, resolve.params.fb_api_req_friendly_name], ['DTSGTOKEN', 'LSDTOKEN', 'PolarisPostRootQuery'], 'session parameters on other queries');

  const tab = await ctx.openProfile('/acct/tagged/', state);
  await waitText(tab, await ctx.msg('tabTagged'));
  await click(tab, await ctx.msg('downloadAll'));
  await runFinished(ctx, tab);
  const names = await opfs.names(tab, 'root/acct');
  assert(expectedFiles(tagged).every((n) => names.includes(n)), 'tagged posts keep their author in the file name');
  assertEqual(callsNamed(state, 'PolarisProfileTaggedTabContentQuery_connection')[0].vars.user_id, '42', 'tagged posts are listed by account id');
  const record = await ctx.account('42');
  assertEqual([record.needsFullScan.reels, record.needsFullScan.tagged, record.fileCount], [false, false, 4], 'summary covers both tabs');
});

scenario('the first run on the reels tab lists every page even when the newest reels are on disk', async (ctx) => {
  const reels = Array.from({ length: 14 }, (_, i) => makePost(40 - i, { kind: 'video' }));
  const state = newState({ posts: reels.slice(0, 12), reels, mediaInfo: 'dead' });

  const grid = await ctx.openProfile('/acct/', state);
  await firstRun(ctx, grid);
  await runFinished(ctx, grid);
  assertEqual((await opfs.names(grid, 'root/acct')).length, 12, 'the main grid holds the newest reels');

  const tab = await ctx.openProfile('/acct/reels/', state);
  await waitText(tab, await ctx.msg('tabReels'));
  await click(tab, await ctx.msg('downloadAll'));
  await runFinished(ctx, tab);
  assertEqual(await opfs.names(tab, 'root/acct'), expectedFiles(reels), 'reels that are not on the main grid are saved');
  assertEqual((await ctx.account('42')).needsFullScan.reels, false, 'later runs on the tab are incremental');
});

scenario('account id falls back to the search query when the page does not hold it', async (ctx) => {
  const state = newState({ posts: makeTimeline(2), relayUsers: [], searchUsers: [{ username: 'acct_fan', pk: '1' }, { username: 'acct', pk: '42' }] });
  const page = await ctx.openProfile('/acct/tagged/', state);
  await firstRun(ctx, page);
  await runFinished(ctx, page);
  assertEqual(callsNamed(state, 'PolarisSearchBoxRefetchableQuery').length, 1, 'one search request');
  assertEqual((await ctx.account('42'))?.username, 'acct', 'account registered under the id found by search');
});

scenario('a single download uses the browser unless the account folder is chosen in the settings', async (ctx) => {
  const state = newState({ posts: makeTimeline(5) });
  const profile = await ctx.openProfile('/acct/', state);
  await firstRun(ctx, profile);
  await runFinished(ctx, profile);
  await closeToasts(profile);
  await clickHover(profile, '#grid a:first-child');
  await waitText(profile, await ctx.msg('savedBrowser', expectedFiles([state.posts[0]]).length));
  await waitFor(() => ctx.browserDownloads.includes(expectedFiles([state.posts[0]])[0]), 'browser download of a managed account by default');
});

scenario('with the account folder setting a single post goes into the account folder when managed, else to browser downloads', async (ctx) => {
  await ctx.ext.evaluate(() => chrome.storage.local.set({ settings: { singleSave: 'folder' } }));
  const state = newState({ posts: makeTimeline(5) });
  const profile = await ctx.openProfile('/acct/', state);
  await firstRun(ctx, profile);
  await runFinished(ctx, profile);
  // Pointing at a thumbnail offers the whole post; the page's own markup is left as it was.
  const markup = await profile.evaluate(() => document.getElementById('grid').innerHTML);
  await closeToasts(profile);
  await clickHover(profile, '#grid a:first-child');
  const newest = expectedFiles([state.posts[0]]).length;
  await waitText(profile, await ctx.msg('savedFolderNone', 'root/acct', newest));
  assertEqual(await profile.evaluate(() => location.pathname), '/acct/', 'the thumbnail button does not follow the link');
  assertEqual(await profile.evaluate(() => document.getElementById('grid').innerHTML), markup, 'nothing is inserted into the grid');

  const before = await opfs.names(profile, 'root/acct');

  // A new carousel by the managed account.
  const fresh = makePost(40, { kind: 'carousel' });
  state.extraPosts.push(fresh);
  const post = await ctx.open(`/p/${fresh.code}/`, state);

  // Pointing at one slide offers that slide only.
  await clickHover(post, 'article li:nth-child(2)');
  await waitText(post, await ctx.msg('savedFolderNew', 'root/acct', 1));
  const second = expectedFiles([fresh])[1];
  assertEqual((await opfs.names(post, 'root/acct')).filter((n) => !before.includes(n)), [second], 'only the clicked slide is saved');

  // The post button saves the rest and skips what is there.
  await closeToasts(post);
  const button = await waitFor(() => post.$('.memfolio-post-btn'), 'the post button');
  await button.click();
  await waitText(post, await ctx.msg('savedFolderSome', 'root/acct', 2, 1));
  const after = await opfs.names(post, 'root/acct');
  assertEqual(after.length, before.length + 3, 'carousel saved into the account folder');
  assertEqual((await ctx.account('42')).fileCount, after.length, 'summary file count follows');

  // Pressing again skips what is there.
  await closeToasts(post);
  await (await post.$('.memfolio-post-btn')).click();
  await waitText(post, await ctx.msg('savedFolderNone', 'root/acct', 3));

  // A post by an account that is not managed uses the browser's download handling.
  const foreign = makePost(50, { owner: '555', username: 'stranger' });
  state.extraPosts.push(foreign);
  const other = await ctx.open(`/reel/${foreign.code}/`, state);
  await (await waitFor(() => other.$('.memfolio-post-btn'), 'the post button')).click();
  await waitText(other, await ctx.msg('savedBrowser', 1));
  const wanted = expectedFiles([foreign])[0];
  await waitFor(() => ctx.browserDownloads.includes(wanted), `browser download of ${wanted}`);
  assertEqual(await ctx.account('555'), null, 'a single download does not register an account');
  assertEqual(await other.evaluate(() => window.__directRequires), [], 'modules are read without the lookup the page reports');
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

scenario('the reels feed has its own button and no post button beside the save control', async (ctx) => {
  const reel = makePost(80, { kind: 'video', owner: '555', username: 'stranger' });
  const state = newState({ extraPosts: [reel] });
  const page = await ctx.open(`/reels/${reel.code}/`, state);
  const reelButton = await ctx.msg('btnReel');
  await waitFor(() => hasButton(page, reelButton), 'the reel button');
  // The page touches its markup the way the real one does; the scan that follows adds nothing.
  await page.evaluate(() => document.body.append(document.createElement('span')));
  await new Promise((r) => setTimeout(r, 1200));
  assertEqual(await page.$$eval('.memfolio-post-btn', (l) => l.length), 0, 'no post button in the column of a reel');
  assertEqual(await page.$eval('#column', (e) => e.firstElementChild.getAttribute('style')), null, 'the column is left as the page drew it');
  await click(page, reelButton);
  await waitText(page, await ctx.msg('savedBrowser', 1));
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
  const page = await ctx.openProfile('/acct/', state);
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
  assertEqual(await popup.$eval('footer', (e) => e.textContent), await popup.evaluate(() => `v${chrome.runtime.getManifest().version}`), 'the band at the bottom shows the version');
  assertEqual(await popup.$$eval('footer button, footer a', (els) => els.length), 0, 'the band holds no controls');
  assertEqual(await popup.$eval('#settings', (e) => e.hidden), true, 'the settings are closed at first');

  await popup.click('#options');
  assertEqual(await popup.$eval('#settings', (e) => e.hidden), false, 'the settings open inside the popup');
  assertEqual(await popup.$eval('#accounts', (e) => e.hidden), true, 'the account list makes room');
  assertEqual(await popup.$eval('#developer-mode-name', (e) => e.textContent), await ctx.msg('optDevMode'), 'the setting is named');
  assertEqual(await popup.$eval('#developer-mode', (e) => e.checked), false, 'developer mode is off by default');
  assertEqual(
    await popup.$eval('#page-link', (e) => [e.href, e.target, e.textContent]),
    ['https://donate.howar31.com/', '_blank', await ctx.msg('sponsorAction')],
    'the block at the top links to the sponsor page in a new tab',
  );
  assertEqual(await popup.evaluate(() => document.querySelector('#settings-body').firstElementChild.id), 'thanks', 'that block comes first');
  assertEqual(
    await popup.$$eval('#settings h3', (els) => els.map((e) => e.textContent)),
    [await ctx.msg('optGroupGeneral'), await ctx.msg('optGroupFolders'), await ctx.msg('optGroupAdvanced')],
    'the settings are grouped: general, folders, advanced',
  );
  assertEqual(
    await popup.evaluate(() => ['default-name', 'default-value', 'default-change'].map((id) => document.getElementById(id).textContent)),
    [await ctx.msg('optDefault'), await ctx.msg('optDefaultNone'), await ctx.msg('optDefaultChoose')],
    'the default location is listed as not chosen',
  );
  assertEqual(await popup.$('#import-hint'), null, 'the import entry has no hint line');
  // A popup is at most 600 px tall: the title and the version stay, the settings scroll between them.
  const fit = await popup.evaluate(() => {
    const body = document.getElementById('settings-body');
    const last = document.getElementById('developer-mode');
    last.scrollIntoView({ block: 'nearest' });
    const seen = last.getBoundingClientRect().bottom <= body.getBoundingClientRect().bottom + 1;
    const out = {
      height: document.documentElement.scrollHeight,
      title: document.getElementById('settings-title').getBoundingClientRect().top >= 0,
      version: Math.round(document.querySelector('footer').getBoundingClientRect().bottom),
      scrolls: getComputedStyle(body).overflowY,
      seen,
    };
    body.scrollTop = 0;
    return out;
  });
  assert(fit.height <= 600 && fit.version <= 600, `the popup is no taller than a popup can be (${fit.height} px, version line ends at ${fit.version} px)`);
  assertEqual([fit.title, fit.scrolls, fit.seen], [true, 'auto', true], 'the title stays, and the last setting is reached by scrolling the settings');
  assertEqual(
    await popup.evaluate(() => {
      const inputs = [...document.querySelectorAll('#settings input, #settings select, #settings button')];
      return inputs[inputs.length - 1].id;
    }),
    'developer-mode',
    'developer mode is the last setting',
  );
  assertEqual(await popup.evaluate(() => {
    const end = getComputedStyle(document.querySelector('footer'));
    const top = getComputedStyle(document.querySelector('header'));
    return end.borderBottomColor === top.borderBottomColor && end.borderBottomWidth === top.borderBottomWidth;
  }), true, 'the popup ends with the same line as the header');
  await popup.click('#developer-mode');
  await waitFor(async () => (await ctx.storage()).settings?.developerMode === true, 'the setting to be stored');

  assertEqual(await popup.$eval('#single-save', (e) => e.value), 'browser', 'single downloads use the browser by default');
  assertEqual(await popup.$eval('#single-save-name', (e) => e.textContent), await ctx.msg('optSingleSave'), 'the single download setting is named');
  assertEqual(await popup.$eval('#time-format', (e) => e.value), '24', 'times use the 24-hour clock by default');
  assertEqual(await popup.$eval('#time-format-name', (e) => e.textContent), await ctx.msg('optTimeFormat'), 'the time format setting is named');
  assertEqual(await popup.$eval('#message-dot-name', (e) => e.textContent), await ctx.msg('optMessageDot'), 'the dot setting is named');
  assertEqual(await popup.$eval('#message-dot', (e) => e.checked), true, 'the dot for waiting messages is on by default');
  await popup.click('#message-dot');
  await waitFor(async () => (await ctx.storage()).settings?.messageDot === false, 'the dot setting to be stored');
  await popup.select('#time-format', '12');
  await waitFor(async () => (await ctx.storage()).settings?.timeFormat === '12', 'the time format to be stored');
  await popup.select('#single-save', 'folder');
  await waitFor(async () => (await ctx.storage()).settings?.singleSave === 'folder', 'the single download setting to be stored');

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
  // So is a change of the default location.
  await popup.click('#default-change');
  await waitFor(async () => (await ctx.storage()).pendingTool?.tool === 'default', 'the request for the default location to be stored');
  await waitFor(async () => (await popup.evaluate(() => window.__opened.length)) === 2, 'a platform tab to be opened for it');
  await ctx.ext.evaluate(() => chrome.storage.local.remove('pendingTool'));

  const manifest = JSON.parse(await readFile(join(EXT_DIR, 'manifest.json'), 'utf8'));
  assertEqual('options_ui' in manifest || 'options_page' in manifest, false, 'no separate options page');
});

scenario('the language is chosen in the popup settings', async (ctx) => {
  const zh = JSON.parse(await readFile(join(EXT_DIR, '_locales/zh_TW/messages.json'), 'utf8'));
  const page = await ctx.openProfile('/acct/', newState({ posts: makeTimeline(1) }));
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
  const later = await ctx.openProfile('/acct/', newState({ posts: makeTimeline(1) }));
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
  const page = await ctx.openProfile('/acct/', state);
  await firstRun(ctx, page);
  await runFinished(ctx, page);

  const popup = await ctx.browser.newPage();
  await popup.goto(`chrome-extension://${ctx.extensionId}/popup.html`);
  await waitFor(() => popup.$('.row'), 'a popup row');
  const rowText = await popup.$eval('.row', (r) => r.innerText);
  for (const part of ['@acct', '… › root › acct', await ctx.msg('popupFiles', 3)]) assert(rowText.includes(part), `popup row shows "${part}"`);
  // The folder is shown as far as the browser tells it; the ellipsis stands for the rest and says so.
  assertEqual(
    await popup.$eval('.row .path', (e) => [e.querySelector('.gap').textContent, e.querySelector('.gap').title, e.querySelector('.leaf').textContent]),
    ['…', await ctx.msg('pathAbove'), 'acct'],
    'the folder line starts with an explained ellipsis and ends with the account folder',
  );
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

  assertEqual(await popup.$eval('.row .extra', (e) => e.hidden), true, 'the actions are folded away at first');
  await popup.mouse.move(2, 2);
  await new Promise((r) => setTimeout(r, 300));
  assertEqual(await popup.$eval('.row .more', (e) => [getComputedStyle(e).opacity, e.getAttribute('aria-expanded')]), ['0.4', 'false'], 'the button that unfolds them is always there, faint until needed');
  await popup.hover('.row');
  await waitFor(async () => (await popup.$eval('.row .more', (e) => getComputedStyle(e).opacity)) === '1', 'the button to show fully under the pointer');
  await popup.click('.row .more');
  assertEqual(await popup.$eval('.row .extra', (e) => e.hidden), false, 'the actions unfold under the entry');
  assertEqual(await popup.$eval('.row .more', (e) => e.getAttribute('aria-expanded')), 'true', 'the button says so');
  await popup.mouse.move(2, 2);
  await new Promise((r) => setTimeout(r, 300));
  assertEqual(await popup.$eval('.row .more', (e) => getComputedStyle(e).opacity), '1', 'and stays fully shown while the actions are open');
  assertEqual(await popup.$eval('.row .pin', (e) => e.textContent), await ctx.msg('popupPin'), 'an entry can be pinned');
  await popup.click('.row .pin');
  await waitFor(async () => (await ctx.account('42')).pinned === true, 'the pin to be stored');
  await waitFor(() => popup.$('.block[data-block="pinned"] .row'), 'the entry in the pinned block');
  await popup.click('.row .more');
  assertEqual(await popup.$eval('.row .pin', (e) => e.textContent), await ctx.msg('popupUnpin'), 'a pinned entry can be unpinned');
  assertEqual(await popup.$eval('.row .confirm', (e) => e.hidden), true, 'no question before the remove button is pressed');
  await popup.click('.row .remove');
  assert((await ctx.account('42')) !== null, 'the remove button only asks');
  const sideBefore = await popup.$eval('.row .side', (e) => e.getBoundingClientRect().width);
  assertEqual(await popup.$eval('.row .confirm', (e) => [e.hidden, e.querySelector('span').textContent]), [false, await ctx.msg('popupRemoveConfirm')], 'the question sits on its own line');
  assertEqual(await popup.$eval('.row .side', (e) => e.getBoundingClientRect().width), sideBefore, 'the entry keeps its layout while asking');
  await popup.click('.row .confirm .btn:not(.danger)');
  assertEqual(await popup.$eval('.row .confirm', (e) => e.hidden), true, 'cancel closes the question');
  assertEqual(await popup.$eval('.row .acts', (e) => e.hidden), false, 'and brings the actions back');
  assert((await ctx.account('42')) !== null, 'cancel removes nothing');
  await popup.click('.row .remove');
  await popup.click('.row .confirm .danger');
  await waitFor(async () => (await ctx.account('42')) === null, 'the account to be removed');
  await waitFor(async () => (await popup.$eval('#list', (l) => l.innerText)).includes(await ctx.msg('popupEmpty')), 'the empty state');
  assertEqual(await popup.$eval('#count', (e) => e.textContent), await ctx.msg('popupTitle'), 'the title without a count when the list is empty');

  // The files stay on disk; only the list entry and, on the next page load, the stored handle go away.
  assertEqual((await opfs.names(page, 'root/acct')).length, 3, 'files are untouched by removal');
});

scenario('profile addresses pasted into the popup become entries of the list', async (ctx) => {
  const popup = await ctx.browser.newPage();
  await popup.goto(`chrome-extension://${ctx.extensionId}/popup.html`);
  await waitFor(async () => (await popup.$eval('#transfer', (e) => e.title)) === (await ctx.msg('popupTransfer')), 'the popup');
  assertEqual(await popup.$$eval('#add, #export', (els) => els.length), 0, 'one button stands for adding and exporting');
  assertEqual(await popup.$eval('#transferring', (e) => e.hidden), true, 'the view for adding and exporting is closed at first');

  await popup.click('#transfer');
  assertEqual(await popup.$eval('#transferring', (e) => e.hidden), false, 'the view opens');
  assertEqual(
    await popup.$$eval('#tab-add, #tab-export', (els) => els.map((e) => [e.textContent, e.getAttribute('aria-selected')])),
    [[await ctx.msg('popupTabAdd'), 'true'], [await ctx.msg('popupTabExport'), 'false']],
    'two tabs, adding first',
  );
  assertEqual(await popup.$$eval('#adding, #exporting', (els) => els.map((e) => e.hidden)), [false, true], 'the paste box is shown');
  assertEqual(await popup.$eval('#accounts', (e) => e.hidden), true, 'the account list makes room');
  const pasted = [`${ORIGIN}/first.user/`, 'instagram.com/Second/reels/', `${ORIGIN}/p/ABC123/`, `${ORIGIN}/first.user/tagged/`].join('\n');
  assertEqual(await popup.$eval('#addresses', (e) => getComputedStyle(e).resize), 'vertical', 'the box can be made taller or shorter');
  await popup.$eval('#addresses', (e, v) => (e.value = v), pasted);
  await popup.click('#add-go');
  await waitFor(async () => (await popup.$eval('#add-result', (e) => e.textContent)) === (await ctx.msg('popupAddResult', 2, 0, 1)), 'the result of adding');
  assertEqual(
    Object.keys(await ctx.storage()).filter((k) => k.startsWith('pending:')).sort(),
    ['pending:instagram:first.user', 'pending:instagram:second'],
    'one stored entry per account',
  );
  assertEqual(await popup.$eval('#addresses', (e) => e.value), `${ORIGIN}/p/ABC123/`, 'the line that names no account stays for correction');

  // The same account again is not added twice.
  await popup.$eval('#addresses', (e, v) => (e.value = v), `${ORIGIN}/second/`);
  await popup.click('#add-go');
  await waitFor(async () => (await popup.$eval('#add-result', (e) => e.textContent)) === (await ctx.msg('popupAddResult', 0, 1, 0)), 'the result of adding a listed account');

  await popup.click('#back');
  assertEqual(await popup.$eval('#accounts', (e) => e.hidden), false, 'back to the account list');
  assertEqual(await popup.$eval('#count', (e) => e.textContent), await ctx.msg('popupCount', 2), 'pasted accounts are counted');
  const rows = await popup.$$eval('.row .open', (els) => els.map((e) => e.innerText));
  assertEqual(rows.map((r) => r.split('\n')[0]), ['@first.user', '@second'], 'one entry per account');
  assert(rows.every((r) => r.includes('\n')), 'each entry has a second line');
  assertEqual(await popup.$$eval('.row .path', (els) => els.map((e) => e.textContent)), Array(2).fill(await ctx.msg('popupNeverRun')), 'the second line says nothing was downloaded yet');
  assertEqual(await popup.$$eval('.row .files', (els) => els.length), 0, 'no file count before a folder exists');

  await popup.evaluate(() => {
    window.__opened = [];
    chrome.tabs.create = async (options) => {
      window.__opened.push(options.url);
      return {};
    };
  });
  await popup.click('.row .open');
  assertEqual(await popup.evaluate(() => window.__opened), [`${ORIGIN}/first.user/`], 'clicking an entry opens the profile');

  // A pinned entry goes to the top; the others stay sorted by name.
  const names = () => popup.$$eval('.row .name', (els) => els.map((e) => e.textContent));
  await popup.click('.row:nth-child(2) .more');
  await popup.click('.row:nth-child(2) .pin');
  await waitFor(async () => JSON.stringify(await names()) === JSON.stringify(['@second', '@first.user']), 'the pinned entry at the top');
  assertEqual((await ctx.storage())['pending:instagram:second'].pinned, true, 'the pin is stored');
  await popup.click('.row:nth-child(1) .more');
  await popup.click('.row:nth-child(1) .pin');
  await waitFor(async () => JSON.stringify(await names()) === JSON.stringify(['@first.user', '@second']), 'the order by name after unpinning');

  await popup.click('.row .more');
  await popup.click('.row .remove');
  await popup.click('.row .confirm .danger');
  await waitFor(async () => !('pending:instagram:first.user' in (await ctx.storage())), 'the entry to be removed');
  await waitFor(async () => (await popup.$$eval('.row', (els) => els.length)) === 1, 'the list without the removed entry');
});

scenario('the list is exported as profile addresses in the order it is shown', async (ctx) => {
  const record = (id, username, more = {}) => ({ platform: 'instagram', id, username, folderName: username, relPath: null, fileCount: 1, lastRunAt: null, lastStatus: 'ok', needsFullScan: {}, addedAt: 1, ...more });
  await ctx.ext.evaluate((entries) => chrome.storage.local.set(entries), {
    'account:instagram:1': record('1', 'alpha'),
    'account:instagram:3': record('3', 'charlie', { pinned: true }),
    'pending:instagram:bravo': { platform: 'instagram', username: 'bravo', addedAt: 1 },
  });
  const popup = await ctx.browser.newPage();
  await popup.goto(`chrome-extension://${ctx.extensionId}/popup.html`);
  await waitFor(async () => (await popup.$$eval('.row', (els) => els.length)) === 3, 'the popup list');
  const shown = await popup.$$eval('.row .name', (els) => els.map((e) => e.textContent.slice(1)));
  assertEqual(shown, ['charlie', 'alpha', 'bravo'], 'the list: pinned first, then by name');

  // The filter narrows the list on screen, not the export.
  await popup.type('#filter', 'alp');
  await waitFor(async () => (await popup.$$eval('.row', (els) => els.length)) === 1, 'the filtered list');
  await popup.click('#transfer');
  await popup.click('#tab-export');
  assertEqual(await popup.$$eval('#adding, #exporting', (els) => els.map((e) => e.hidden)), [true, false], 'the export tab shows the text to hand out');
  assertEqual(await popup.$eval('#tab-export', (e) => e.getAttribute('aria-selected')), 'true', 'the tab says so');
  assertEqual(await popup.$eval('#accounts', (e) => e.hidden), true, 'the account list makes room');
  const expected = ['# [pinned]', `${ORIGIN}/charlie/`, '# [ungrouped]', `${ORIGIN}/alpha/`, `${ORIGIN}/bravo/`].join('\n');
  assertEqual(await popup.$eval('#exported', (e) => [e.value, e.readOnly]), [expected, true], 'one address per entry, in the order of the list');

  await popup.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.writeText = async (text) => void window.__copied.push(text);
  });
  await popup.click('#export-copy');
  await waitFor(async () => (await popup.$eval('#export-result', (e) => e.textContent)) === (await ctx.msg('checkCopied')), 'the note about the copy');
  assertEqual(await popup.evaluate(() => window.__copied), [expected], 'the same text goes to the clipboard');

  await popup.click('#export-save');
  await waitFor(() => ctx.browserDownloads.some((name) => /^memfolio-accounts-\d{8}-\d{6}\.txt$/.test(name)), 'the exported file');

  // What was exported can be pasted back in.
  await ctx.ext.evaluate(() => chrome.storage.local.clear());
  await popup.click('#back');
  await popup.click('#transfer');
  assertEqual(await popup.$$eval('#adding, #exporting', (els) => els.map((e) => e.hidden)), [false, true], 'the view opens on the paste box every time');
  await popup.click('#tab-export');
  assertEqual(await popup.$eval('#exported', (e) => e.value), '', 'an empty list exports nothing');
  await popup.click('#tab-add');
  await popup.$eval('#addresses', (e, v) => (e.value = v), expected);
  await popup.click('#add-go');
  await waitFor(async () => (await popup.$eval('#add-result', (e) => e.textContent)) === (await ctx.msg('popupAddResult', 3, 0, 0)), 'every exported line to be taken');
});

// ---- groups and sorting ------------------------------------------------------

const listRecord = (id, username, more = {}) => ({ platform: 'instagram', id, username, folderName: username, relPath: null, fileCount: 1, lastRunAt: null, lastStatus: 'ok', needsFullScan: {}, addedAt: 1, ...more });

/** The popup list as [block name, [account names]] from top to bottom. */
const blocksOf = (popup) =>
  popup.$$eval('#list .block', (els) =>
    els.map((b) => [b.querySelector('.blockname').textContent, [...b.querySelectorAll('.row .name')].map((n) => n.textContent.slice(1))]),
  );
const waitBlocks = (popup, expected, what) =>
  waitFor(async () => JSON.stringify(await blocksOf(popup)) === JSON.stringify(expected), what).catch(async (e) => {
    throw new Error(`${e.message}\n   list shows: ${JSON.stringify(await blocksOf(popup))}`);
  });
const layoutOf = async (ctx) => (await ctx.storage()).layout;
const rowOf = (name) => `.row[data-name="${name}"]`;

async function openPopup(ctx) {
  const popup = await ctx.browser.newPage();
  await popup.setViewport({ width: 440, height: 600 });
  await popup.goto(`chrome-extension://${ctx.extensionId}/popup.html`);
  await waitFor(() => popup.$('#list > *'), 'the popup list');
  await popup.evaluate(() => {
    window.__opened = [];
    chrome.tabs.create = async (options) => {
      window.__opened.push(options.url);
      return {};
    };
  });
  return popup;
}

/** Presses on one element and lets go over another, a little above or below its middle. */
async function drag(popup, from, to, where = 'after') {
  // The list scrolls; what is pressed has to be in its visible part.
  await popup.$eval(from, (e) => e.scrollIntoView({ block: 'nearest' }));
  const a = await (await popup.$(from)).boundingBox();
  const b = await (await popup.$(to)).boundingBox();
  const target = { x: b.x + b.width / 3, y: b.y + (where === 'before' ? b.height * 0.25 : where === 'after' ? b.height * 0.75 : b.height / 2) };
  await popup.mouse.move(a.x + a.width / 3, a.y + a.height / 2);
  await popup.mouse.down();
  await popup.mouse.move(a.x + a.width / 3, a.y + a.height / 2 + 8, { steps: 2 });
  await popup.mouse.move(target.x, target.y, { steps: 6 });
  await popup.mouse.up();
}

scenario('groups split the list and sorting stays inside them', async (ctx) => {
  await ctx.ext.evaluate((entries) => chrome.storage.local.set(entries), {
    'account:instagram:1': listRecord('1', 'alpha', { fileCount: 5, lastRunAt: 100 }),
    'account:instagram:2': listRecord('2', 'bravo', { fileCount: 50, lastRunAt: 300 }),
    'account:instagram:3': listRecord('3', 'charlie', { fileCount: 1, lastRunAt: 200 }),
    'pending:instagram:delta': { platform: 'instagram', username: 'delta', addedAt: 1 },
  });
  const popup = await openPopup(ctx);
  const rest = await ctx.msg('popupBlockUngrouped');
  assertEqual(await blocksOf(popup), [[rest, ['alpha', 'bravo', 'charlie', 'delta']]], 'one block, sorted by name');
  assertEqual(await popup.$eval('.blockhead', (e) => e.hidden), true, 'a list without groups has no heading');
  assertEqual(await popup.$eval('#sort-by', (e) => e.value), 'name', 'sorted by name at first');

  // A new group exists only once its name is saved: Cancel and Escape make none.
  for (const leave of ['.gcancel', 'Escape']) {
    await popup.click('#new-group');
    await waitFor(() => popup.$('.gname'), 'the name box of the new group');
    if (leave === 'Escape') await popup.keyboard.press('Escape');
    else await popup.click(leave);
    await waitFor(async () => (await popup.$('.gname')) === null, 'the name box to close');
    assertEqual([(await layoutOf(ctx))?.groups ?? [], await blocksOf(popup)], [[], [[rest, ['alpha', 'bravo', 'charlie', 'delta']]]], `no group after leaving with ${leave}`);
  }

  // A new group starts with its name open for typing.
  await popup.click('#new-group');
  await waitFor(() => popup.$('.gname'), 'the name box of the new group');
  assertEqual((await layoutOf(ctx))?.groups ?? [], [], 'nothing is stored while the name is open');
  // Enter that only confirms an input method's composition does not save.
  await popup.$eval('.gname', (e) => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })));
  assertEqual(await popup.$eval('.gname', (e) => document.activeElement === e), true, 'the name box stays open during a composition');
  assertEqual(await popup.$eval('.gname', (e) => [e.value, document.activeElement === e]), [await ctx.msg('popupGroupDefault'), true], 'the name box holds a default and the focus');
  await popup.$eval('.gname', (e) => (e.value = ''));
  await popup.type('.gname', 'Fri');
  // A change stored elsewhere redraws the list; what was typed stays.
  await ctx.ext.evaluate((entry) => chrome.storage.local.set({ 'account:instagram:1': entry }), listRecord('1', 'alpha', { fileCount: 6, lastRunAt: 100 }));
  await waitFor(async () => (await popup.$eval(`${rowOf('alpha')} .files`, (e) => e.textContent)) === (await ctx.msg('popupFiles', 6)), 'the redrawn list');
  assertEqual(await popup.$eval('.gname', (e) => [e.value, document.activeElement === e]), ['Fri', true], 'the name being typed survives a redraw');
  await popup.type('.gname', 'ends');
  await popup.keyboard.press('Enter');
  await waitBlocks(popup, [['Friends', []], [rest, ['alpha', 'bravo', 'charlie', 'delta']]], 'the new group above the rest');
  assertEqual(await popup.$$eval('.blockhead', (els) => els.map((e) => e.hidden)), [false, false], 'headings appear once there is a group');
  const frames = await popup.$$eval('#list .block', (els) => els.map((e) => ({ radius: getComputedStyle(e).borderTopLeftRadius, border: getComputedStyle(e).borderTopWidth, top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom })));
  assertEqual(frames.map((f) => [f.radius, f.border]), [['8px', '1px'], ['8px', '1px']], 'every block has a frame of its own');
  assert(frames[1].top - frames[0].bottom >= 8, 'with room between the frames');
  assertEqual(await popup.$eval('#list', (e) => getComputedStyle(e).borderTopWidth), '0px', 'and no frame around all of them');
  const friends = (await layoutOf(ctx)).groups[0].id;

  // Entries move between groups through their actions.
  for (const name of ['bravo', 'charlie']) {
    await popup.click(`${rowOf(name)} .more`);
    await popup.select(`${rowOf(name)} .moveto`, friends);
    await waitFor(async () => (await blocksOf(popup))[0][1].includes(name), `${name} in the group`);
  }
  await waitBlocks(popup, [['Friends', ['bravo', 'charlie']], [rest, ['alpha', 'delta']]], 'two entries in the group');
  assertEqual(await popup.$$eval('.blockcount', (els) => els.map((e) => e.textContent)), ['2', '2'], 'each heading counts its entries');

  // Sorting orders each block by itself.
  await popup.select('#sort-by', 'files');
  await waitBlocks(popup, [['Friends', ['bravo', 'charlie']], [rest, ['alpha', 'delta']]], 'most files first, inside each block');
  await popup.click('#sort-dir');
  await waitBlocks(popup, [['Friends', ['charlie', 'bravo']], [rest, ['delta', 'alpha']]], 'the direction turned, still inside each block');
  assertEqual((await layoutOf(ctx)).sort, { by: 'files', desc: false }, 'the sort is stored');
  await popup.select('#sort-by', 'lastRun');
  await waitBlocks(popup, [['Friends', ['bravo', 'charlie']], [rest, ['alpha', 'delta']]], 'latest run first; an entry that never ran is last');
  await popup.select('#sort-by', 'name');

  // The filter keeps the headings of the blocks that still show something.
  await popup.type('#filter', 'cha');
  await waitBlocks(popup, [['Friends', ['charlie']]], 'only the block with a match');
  await popup.click('.block .fold');
  await new Promise((r) => setTimeout(r, 200));
  assertEqual((await layoutOf(ctx)).groups[0].collapsed, false, 'a heading does not fold while the filter is in use');
  await popup.$eval('#filter', (e) => {
    e.value = '';
    e.dispatchEvent(new Event('input'));
  });
  await waitBlocks(popup, [['Friends', ['bravo', 'charlie']], [rest, ['alpha', 'delta']]], 'the whole list again');

  // A folded block stays folded when the popup is opened again.
  await popup.click('.block .fold');
  await waitFor(async () => (await layoutOf(ctx)).groups[0].collapsed === true, 'the folded state to be stored');
  const again = await openPopup(ctx);
  assertEqual(await again.$eval('.block .rows', (e) => e.hidden), true, 'the group is still folded');
  assertEqual(await again.$eval('.block .fold', (e) => e.getAttribute('aria-expanded')), 'false', 'the heading says so');
  assertEqual(await again.$eval('.block .blockcount', (e) => e.textContent), '2', 'a folded group still counts its entries');
  await again.click('.block .fold');
  await waitFor(async () => (await again.$eval('.block .rows', (e) => e.hidden)) === false, 'the group to unfold');

  // A group is renamed and deleted through its heading; deleting keeps the entries.
  await again.click('.block .gmore');
  await again.click('.block .grename');
  await again.$eval('.gname', (e) => (e.value = ''));
  await again.type('.gname', 'Close friends');
  await again.click('.block .gsave');
  await waitBlocks(again, [['Close friends', ['bravo', 'charlie']], [rest, ['alpha', 'delta']]], 'the new name');
  await again.click('.block .gmore');
  await again.click('.block .gdelete');
  assertEqual(await again.$eval('.block .gextra .confirm span', (e) => e.textContent), await ctx.msg('popupGroupDeleteConfirm'), 'deleting asks first');
  await again.click('.block .gextra .confirm .danger');
  await waitBlocks(again, [[rest, ['alpha', 'bravo', 'charlie', 'delta']]], 'the entries are back in one block');
  assertEqual((await layoutOf(ctx)).groups, [], 'no group left');

  // An entry can also start a group of its own.
  await again.click(`${rowOf('delta')} .more`);
  await again.select(`${rowOf('delta')} .moveto`, '+');
  await waitFor(() => again.$('.gname'), 'the name box of the group made for the entry');
  await again.click('.gcancel');
  await waitBlocks(again, [[rest, ['alpha', 'bravo', 'charlie', 'delta']]], 'cancelled: no group, and the entry stays where it was');
  assertEqual((await layoutOf(ctx)).groups, [], 'nothing stored');
  await again.click(`${rowOf('delta')} .more`);
  await again.select(`${rowOf('delta')} .moveto`, '+');
  await waitFor(() => again.$('.gname'), 'the name box of the group made for the entry');
  await again.keyboard.press('Enter');
  await waitBlocks(again, [[await ctx.msg('popupGroupDefault'), ['delta']], [rest, ['alpha', 'bravo', 'charlie']]], 'the entry in its new group');
  assertEqual((await layoutOf(ctx)).groupOf['instagram:@delta'], (await layoutOf(ctx)).groups[0].id, 'an address-only entry is keyed by its name');
});

scenario('a group name is used once', async (ctx) => {
  await ctx.ext.evaluate(() =>
    chrome.storage.local.set({
      'pending:instagram:alpha': { platform: 'instagram', username: 'alpha', addedAt: 1 },
      layout: { groups: [{ id: 'g1', name: 'Friends', collapsed: false }, { id: 'g2', name: 'Work', collapsed: false }] },
    }),
  );
  const popup = await openPopup(ctx);
  const taken = await ctx.msg('popupGroupNameTaken');
  const fallback = await ctx.msg('popupGroupDefault');
  const remark = (block) => popup.$eval(`${block} .gerror`, (e) => (e.hidden ? '' : e.textContent));
  const groupNames = async () => (await layoutOf(ctx)).groups.map((g) => g.name);
  const retype = async (block, value) => {
    await popup.$eval(`${block} .gname`, (e) => (e.value = ''));
    await popup.type(`${block} .gname`, value);
  };
  const draft = '.block[data-kind="draft"]';

  // A new group cannot take a name in use, whatever its case.
  await popup.click('#new-group');
  await waitFor(() => popup.$(`${draft} .gname`), 'the name box of the new group');
  assertEqual(await remark(draft), '', 'no remark at first');
  await retype(draft, ' friends ');
  await popup.keyboard.press('Enter');
  await waitFor(async () => (await remark(draft)) === taken, 'the remark about the name');
  assertEqual([await groupNames(), await popup.$eval(`${draft} .gname`, (e) => e.value)], [['Friends', 'Work'], ' friends '], 'nothing is stored and the box stays open');
  await popup.type(`${draft} .gname`, 'x');
  await waitFor(async () => (await remark(draft)) === '', 'the remark to go once the name changes');
  await retype(draft, '[pinned]');
  await popup.click(`${draft} .gsave`);
  await waitFor(async () => (await remark(draft)) === taken, 'the remark for a heading the text form keeps');
  await retype(draft, 'Family');
  await popup.click(`${draft} .gsave`);
  await waitFor(async () => (await groupNames()).length === 3, 'the group with a free name');
  assertEqual(await groupNames(), ['Friends', 'Work', 'Family'], 'stored under the name typed');

  // Renaming follows the same rule; a group may write its own name another way.
  const work = '.block[data-block="g2"]';
  await popup.click(`${work} .gmore`);
  await popup.click(`${work} .grename`);
  await retype(work, 'FAMILY');
  await popup.keyboard.press('Enter');
  await waitFor(async () => (await remark(work)) === taken, 'the remark when renaming');
  assertEqual(await groupNames(), ['Friends', 'Work', 'Family'], 'the name is not changed');
  await retype(work, 'WORK');
  await popup.keyboard.press('Enter');
  await waitFor(async () => (await groupNames())[1] === 'WORK', 'its own name in capitals');

  // The name offered for a new group is one that is free.
  for (const expected of [fallback, `${fallback} 2`]) {
    await popup.click('#new-group');
    await waitFor(() => popup.$(`${draft} .gname`), 'the name box of the new group');
    assertEqual(await popup.$eval(`${draft} .gname`, (e) => e.value), expected, 'the offered name');
    await popup.click(`${draft} .gsave`);
    await waitFor(async () => (await groupNames()).includes(expected), `the group "${expected}"`);
  }

  // A pasted heading finds its group the same way.
  await popup.click('#transfer');
  await popup.$eval('#addresses', (e, v) => (e.value = v), ['# FRIENDS ', `${ORIGIN}/bravo/`].join('\n'));
  await popup.click('#add-go');
  await waitFor(async () => (await layoutOf(ctx)).groupOf['instagram:@bravo'] === 'g1', 'the pasted entry in the existing group');
  assertEqual((await groupNames()).length, 5, 'no group was made for the heading');
});

scenario('pinned entries form a block at the top and return to their group', async (ctx) => {
  await ctx.ext.evaluate((entries) => chrome.storage.local.set(entries), {
    'account:instagram:1': listRecord('1', 'alpha'),
    'account:instagram:2': listRecord('2', 'bravo'),
    layout: { groups: [{ id: 'g1', name: 'Friends', collapsed: false }], groupOf: { 'instagram:2': 'g1' } },
  });
  const popup = await openPopup(ctx);
  const [pinned, rest] = [await ctx.msg('popupBlockPinned'), await ctx.msg('popupBlockUngrouped')];
  assertEqual(await blocksOf(popup), [['Friends', ['bravo']], [rest, ['alpha']]], 'the list before pinning');
  await popup.click(`${rowOf('bravo')} .more`);
  await popup.click(`${rowOf('bravo')} .pin`);
  await waitBlocks(popup, [[pinned, ['bravo']], ['Friends', []], [rest, ['alpha']]], 'the pinned entry in the block at the top');
  assertEqual(await popup.$eval('.block[data-block="g1"] .hollow', (e) => e.textContent), await ctx.msg('popupGroupEmpty'), 'an empty group says so');
  await popup.click(`${rowOf('bravo')} .more`);
  await popup.click(`${rowOf('bravo')} .pin`);
  await waitBlocks(popup, [['Friends', ['bravo']], [rest, ['alpha']]], 'back in its group after unpinning');
});

scenario('the manual order is set with buttons and by dragging', async (ctx) => {
  await ctx.ext.evaluate((entries) => chrome.storage.local.set(entries), {
    'account:instagram:1': listRecord('1', 'alpha'),
    'account:instagram:2': listRecord('2', 'bravo'),
    'account:instagram:3': listRecord('3', 'charlie'),
    'account:instagram:4': listRecord('4', 'delta'),
    'account:instagram:5': listRecord('5', 'echo'),
    layout: {
      groups: [{ id: 'g1', name: 'One', collapsed: false }, { id: 'g2', name: 'Two', collapsed: false }],
      groupOf: { 'instagram:4': 'g1', 'instagram:5': 'g2' },
    },
  });
  const popup = await openPopup(ctx);
  const [pinned, rest] = [await ctx.msg('popupBlockPinned'), await ctx.msg('popupBlockUngrouped')];
  await popup.click(`${rowOf('alpha')} .more`);
  assertEqual(await popup.$(`${rowOf('alpha')} .up`), null, 'no moving up or down while the list sorts itself');
  await popup.click(`${rowOf('alpha')} .more`);

  // Sorted by name, dragging changes the group only.
  await drag(popup, `${rowOf('charlie')} .open`, rowOf('echo'));
  await waitBlocks(popup, [['One', ['delta']], ['Two', ['charlie', 'echo']], [rest, ['alpha', 'bravo']]], 'dropped into another group, placed by the sort');
  assertEqual(await popup.evaluate(() => window.__opened), [], 'a drag does not open the profile');

  // Manual order starts from what is on screen.
  await popup.select('#sort-by', 'manual');
  await waitFor(async () => (await layoutOf(ctx)).sort.by === 'manual', 'manual order to be stored');
  assertEqual(await popup.$eval('#sort-dir', (e) => e.disabled), true, 'manual order has no direction');
  await waitBlocks(popup, [['One', ['delta']], ['Two', ['charlie', 'echo']], [rest, ['alpha', 'bravo']]], 'the same order as before');

  await popup.click(`${rowOf('alpha')} .more`);
  await popup.click(`${rowOf('alpha')} .down`);
  await waitBlocks(popup, [['One', ['delta']], ['Two', ['charlie', 'echo']], [rest, ['bravo', 'alpha']]], 'moved down by its button');
  assertEqual(await popup.$eval(`${rowOf('alpha')} .extra`, (e) => e.hidden), false, 'the actions stay open after a move');
  assertEqual(await popup.$eval(`${rowOf('alpha')} .down`, (e) => e.disabled), true, 'the last entry cannot go further down');
  assertEqual(await popup.evaluate(() => document.activeElement?.className), 'btn up', 'the focus goes to the button that still works');
  await popup.click(`${rowOf('alpha')} .up`);
  await waitBlocks(popup, [['One', ['delta']], ['Two', ['charlie', 'echo']], [rest, ['alpha', 'bravo']]], 'moved up by its button');
  await popup.click(`${rowOf('alpha')} .more`);

  // Sorting another way and coming back finds the manual order as it was left.
  await popup.click(`${rowOf('bravo')} .more`);
  await popup.click(`${rowOf('bravo')} .up`);
  await waitBlocks(popup, [['One', ['delta']], ['Two', ['charlie', 'echo']], [rest, ['bravo', 'alpha']]], 'bravo above alpha');
  await popup.select('#sort-by', 'name');
  await waitBlocks(popup, [['One', ['delta']], ['Two', ['charlie', 'echo']], [rest, ['alpha', 'bravo']]], 'by name in between');
  await popup.select('#sort-by', 'manual');
  await waitBlocks(popup, [['One', ['delta']], ['Two', ['charlie', 'echo']], [rest, ['bravo', 'alpha']]], 'the manual order is back');
  await popup.click(`${rowOf('alpha')} .more`);
  await popup.click(`${rowOf('alpha')} .up`);
  await waitBlocks(popup, [['One', ['delta']], ['Two', ['charlie', 'echo']], [rest, ['alpha', 'bravo']]], 'alpha first again');
  await popup.click(`${rowOf('alpha')} .more`);

  // A drag given up with Escape, or ended by the browser, changes nothing and opens nothing.
  const untouched = JSON.stringify(await layoutOf(ctx));
  const box = await (await popup.$(`${rowOf('alpha')} .open`)).boundingBox();
  const over = await (await popup.$(rowOf('echo'))).boundingBox();
  for (const end of ['escape', 'cancel']) {
    await popup.mouse.move(box.x + 40, box.y + 20);
    await popup.mouse.down();
    await popup.mouse.move(box.x + 40, box.y + 30, { steps: 2 });
    await popup.mouse.move(over.x + 40, over.y + 20, { steps: 4 });
    assertEqual(await popup.$eval('#list', (e) => e.classList.contains('dragging')), true, 'a drag is under way');
    if (end === 'escape') await popup.keyboard.press('Escape');
    else await popup.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
    assertEqual(await popup.$eval('#list', (e) => e.classList.contains('dragging')), false, `the drag ends on ${end}`);
    await popup.mouse.move(box.x + 40, box.y + 20, { steps: 2 });
    await popup.mouse.up();
    await new Promise((r) => setTimeout(r, 200));
    assertEqual(JSON.stringify(await layoutOf(ctx)), untouched, `nothing moved after ${end}`);
    // A drag the browser ends has no release of its own; the one simulated here is an ordinary click.
    if (end === 'escape') assertEqual(await popup.evaluate(() => window.__opened), [], 'the release after Escape opens nothing');
    await popup.evaluate(() => (window.__opened.length = 0));
  }

  // Dragging places an entry where it is dropped: inside its block, or in another one.
  await drag(popup, `${rowOf('echo')} .open`, rowOf('charlie'), 'before');
  await waitBlocks(popup, [['One', ['delta']], ['Two', ['echo', 'charlie']], [rest, ['alpha', 'bravo']]], 'dragged above its neighbour');
  await drag(popup, `${rowOf('bravo')} .open`, rowOf('echo'), 'after');
  await waitBlocks(popup, [['One', ['delta']], ['Two', ['echo', 'bravo', 'charlie']], [rest, ['alpha']]], 'dragged between two entries of another group');
  assertEqual((await layoutOf(ctx)).groupOf['instagram:2'], 'g2', 'the group of the dragged entry is stored');
  await drag(popup, `${rowOf('charlie')} .open`, '.block[data-block="ungrouped"] .blockhead', 'middle');
  await waitBlocks(popup, [['One', ['delta']], ['Two', ['echo', 'bravo']], [rest, ['alpha', 'charlie']]], 'dropped on a heading: last in that block');

  // Dropping on a pinned entry pins; dragging out again unpins and sets the group.
  await popup.click(`${rowOf('alpha')} .more`);
  await popup.click(`${rowOf('alpha')} .pin`);
  await waitBlocks(popup, [[pinned, ['alpha']], ['One', ['delta']], ['Two', ['echo', 'bravo']], [rest, ['charlie']]], 'one pinned entry');
  await drag(popup, `${rowOf('echo')} .open`, rowOf('alpha'), 'before');
  await waitBlocks(popup, [[pinned, ['echo', 'alpha']], ['One', ['delta']], ['Two', ['bravo']], [rest, ['charlie']]], 'dragged into the pinned block');
  assertEqual((await ctx.account('5')).pinned, true, 'the dragged entry is pinned');
  await drag(popup, `${rowOf('alpha')} .open`, rowOf('delta'), 'after');
  await waitBlocks(popup, [[pinned, ['echo']], ['One', ['delta', 'alpha']], ['Two', ['bravo']], [rest, ['charlie']]], 'dragged out of the pinned block into a group');
  assertEqual([(await ctx.account('1')).pinned === true, (await layoutOf(ctx)).groupOf['instagram:1']], [false, 'g1'], 'unpinned and in the group it was dropped on');

  // Groups change places by their headings.
  await drag(popup, '.block[data-block="g2"] .fold', '.block[data-block="g1"] .blockhead', 'before');
  await waitFor(async () => JSON.stringify((await layoutOf(ctx)).groups.map((g) => g.id)) === JSON.stringify(['g2', 'g1']), 'the groups to change places');
  await waitBlocks(popup, [[pinned, ['echo']], ['Two', ['bravo']], ['One', ['delta', 'alpha']], [rest, ['charlie']]], 'the dragged group first');
  assertEqual((await layoutOf(ctx)).groups.map((g) => g.collapsed), [false, false], 'dragging a heading does not fold its group');

  // A narrowed list is not rearranged.
  await popup.type('#filter', 'a');
  await waitFor(async () => (await popup.$$eval('.row', (els) => els.length)) === 4, 'the filtered list');
  const before = JSON.stringify(await layoutOf(ctx));
  await drag(popup, `${rowOf('alpha')} .open`, rowOf('bravo'), 'after');
  await new Promise((r) => setTimeout(r, 300));
  assertEqual(JSON.stringify(await layoutOf(ctx)), before, 'no dragging while the filter is in use');
});

scenario('groups and pins travel with the exported text', async (ctx) => {
  await ctx.ext.evaluate((entries) => chrome.storage.local.set(entries), {
    'account:instagram:1': listRecord('1', 'alpha', { pinned: true }),
    'account:instagram:2': listRecord('2', 'bravo'),
    'account:instagram:3': listRecord('3', 'charlie'),
    'pending:instagram:delta': { platform: 'instagram', username: 'delta', addedAt: 1 },
    layout: {
      sort: { by: 'name', desc: false },
      groups: [{ id: 'g1', name: 'One', collapsed: true }, { id: 'g2', name: 'Empty', collapsed: false }],
      groupOf: { 'instagram:3': 'g1', 'instagram:@delta': 'g1' },
      order: ['instagram:@delta', 'instagram:3'],
    },
  });
  const popup = await openPopup(ctx);
  const [pinned, rest] = [await ctx.msg('popupBlockPinned'), await ctx.msg('popupBlockUngrouped')];
  await popup.click('#transfer');
  await popup.click('#tab-export');
  const expected = ['# [pinned]', `${ORIGIN}/alpha/`, '# One', `${ORIGIN}/delta/`, `${ORIGIN}/charlie/`, '# Empty', '# [ungrouped]', `${ORIGIN}/bravo/`].join('\n');
  assertEqual(await popup.$eval('#exported', (e) => e.value), expected, 'every block under its heading, folded or not, in the manual order whatever the list is sorted by');
  assertEqual(await popup.$eval('#exporting-hint', (e) => e.textContent), await ctx.msg('popupExportHint'), 'the view says which order it uses');

  // Pasted into an empty list, the text brings the groups and the pin back.
  await ctx.ext.evaluate(() => chrome.storage.local.clear());
  await popup.click('#back');
  await popup.click('#transfer');
  await popup.$eval('#addresses', (e, v) => (e.value = v), expected);
  await popup.click('#add-go');
  await waitFor(async () => (await popup.$eval('#add-result', (e) => e.textContent)) === (await ctx.msg('popupAddResult', 4, 0, 0)), 'every address to be taken');
  assertEqual(await popup.$eval('#addresses', (e) => e.value), '', 'headings are not handed back as unreadable lines');
  await popup.click('#back');
  await waitBlocks(popup, [[pinned, ['alpha']], ['One', ['charlie', 'delta']], ['Empty', []], [rest, ['bravo']]], 'the groups and the pin are back, shown by name');
  assertEqual((await layoutOf(ctx)).order, ['instagram:@alpha', 'instagram:@delta', 'instagram:@charlie', 'instagram:@bravo'], 'the pasted order is kept as the manual order');
  await popup.select('#sort-by', 'manual');
  await waitBlocks(popup, [[pinned, ['alpha']], ['One', ['delta', 'charlie']], ['Empty', []], [rest, ['bravo']]], 'manual order shows the entries as they were exported');
  await popup.select('#sort-by', 'name');
  await waitBlocks(popup, [[pinned, ['alpha']], ['One', ['charlie', 'delta']], ['Empty', []], [rest, ['bravo']]], 'by name again');
  assertEqual((await ctx.storage())['pending:instagram:alpha'].pinned, true, 'the pin is stored with the entry');

  // A group that already exists takes the new entries; entries already listed stay where they are.
  await popup.click('#transfer');
  await popup.$eval('#addresses', (e, v) => (e.value = v), ['# One', `${ORIGIN}/echo/`, `${ORIGIN}/bravo/`].join('\n'));
  await popup.click('#add-go');
  await waitFor(async () => (await popup.$eval('#add-result', (e) => e.textContent)) === (await ctx.msg('popupAddResult', 1, 1, 0)), 'one new, one already listed');
  await popup.click('#back');
  await waitBlocks(popup, [[pinned, ['alpha']], ['One', ['charlie', 'delta', 'echo']], ['Empty', []], [rest, ['bravo']]], 'the existing group grew; the listed entry did not move');
  assertEqual((await layoutOf(ctx)).groups.length, 2, 'no second group of the same name');
});

scenario('a pasted account becomes a managed one on its first run', async (ctx) => {
  await ctx.ext.evaluate(() => chrome.storage.local.set({ 'pending:instagram:acct': { platform: 'instagram', username: 'acct', addedAt: 1, pinned: true }, layout: { groups: [{ id: 'g1', name: 'One', collapsed: false }], groupOf: { 'instagram:@acct': 'g1' }, order: ['instagram:@other', 'instagram:@acct'] } }));
  const page = await ctx.openProfile('/acct/', newState({ posts: makeTimeline(2) }));
  await firstRun(ctx, page);
  await runFinished(ctx, page);
  assertEqual('pending:instagram:acct' in (await ctx.storage()), false, 'the pasted entry is gone');
  assertEqual((await ctx.account('42')).username, 'acct', 'the account is managed under its id');
  assertEqual((await ctx.account('42')).pinned, true, 'a pin set on the pasted entry stays');
  const moved = (await ctx.storage()).layout;
  assertEqual([moved.groupOf, moved.order], [{ 'instagram:42': 'g1' }, ['instagram:@other', 'instagram:42']], 'its group and its place in the manual order stay too');

  await closeToasts(page);
  await click(page, await ctx.msg('downloadAll'));
  await runFinished(ctx, page);
  assertEqual((await ctx.account('42')).pinned, true, 'later runs keep the pin');
});

scenario('a pasted new name of a managed account joins its record on the first run', async (ctx) => {
  const page = await ctx.openProfile('/acct/', newState({ posts: makeTimeline(2) }));
  await firstRun(ctx, page);
  await runFinished(ctx, page);

  await ctx.ext.evaluate(() => chrome.storage.local.set({ 'pending:instagram:renamed': { platform: 'instagram', username: 'renamed', addedAt: 1 } }));
  const posts = [3, 2, 1].map((n) => makePost(n, { username: 'renamed' }));
  const later = await ctx.openProfile('/renamed/', newState({ posts, relayUsers: [{ username: 'renamed', pk: '42' }] }));
  await click(later, await ctx.msg('downloadAll'));
  await runFinished(ctx, later);
  const stored = await ctx.storage();
  assertEqual(Object.keys(stored).filter((k) => k.startsWith('pending:') || k.startsWith('account:')), ['account:instagram:42'], 'one record, no pasted entry left');
  assertEqual([stored['account:instagram:42'].username, stored['account:instagram:42'].folderName], ['renamed', 'acct'], 'the record takes the new name and keeps its folder');
  assertEqual((await opfs.names(later, 'root/acct')).length, 3, 'new files go into the folder the account already had');
});

scenario('a page whose extension was reloaded stops quietly and asks for a refresh', async (ctx) => {
  const page = await ctx.openProfile('/acct/', newState({ posts: makeTimeline(1) }));
  await waitFor(async () => hasButton(page, await ctx.msg('downloadAll')), 'the account panel');
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const notice = await ctx.msg('pageStale');

  // The page that asks for the reload goes away with the old extension.
  await ctx.ext.evaluate(() => chrome.runtime.reload()).catch(() => {});
  // Moving inside the site is what makes the old script call into its extension again.
  await new Promise((r) => setTimeout(r, 500));
  await page.evaluate(() => history.pushState(null, '', '/acct/reels/'));

  await waitText(page, notice);
  assertEqual(await page.evaluate(() => document.querySelector('memfolio-surface').shadowRoot.querySelector('.ball') === null), true, 'the button of the old script is gone');
  // Long enough for several of the script's periodic checks.
  await new Promise((r) => setTimeout(r, 2500));
  assertEqual(errors.filter((m) => m.includes('Extension context invalidated')), [], 'no error from calls into the extension that is gone');
  assertEqual((await surfaceText(page)).split(notice).length - 1, 1, 'the notice is shown once');
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
