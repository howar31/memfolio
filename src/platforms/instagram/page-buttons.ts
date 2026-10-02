import { t } from '../../core/i18n';
import type { MediaItem } from '../../core/types';
import { ICONS, icon } from '../../ui/dom';
import { HOVER_BUTTON_SIZE, surface } from '../../ui/host';
import { fetchPostMedia } from './api';
import { bridge } from './bridge-client';
import { describeError, gql, mediaInfo } from './env';
import { parseRoute } from './routes';
import { savePostItems } from './save';
import { idToShortcode } from './shortcode';

const never = new AbortController().signal;

// The "save to collection" control of a post, recognised by the outline of its
// icon (unsaved and saved state). The icon shape does not depend on the UI language.
const BOOKMARK = [
  '[role="button"]:has(svg polygon[points="20 21 12 13.44 4 21 4 3 20 3 20 21"])',
  '[role="button"]:has(svg path[d^="M20 22a.999.999 0 0 1-.687-.273L12 14.815"])',
].join(',');
const POST_LINK = 'a[href*="/p/"], a[href*="/reel/"]';
const MIN_MEDIA_WIDTH = 150;

function makeButton(cls: string, title: string, paths: readonly string[], size: number, onClick: (el: HTMLElement) => Promise<void>): HTMLElement {
  const b = document.createElement('div');
  b.className = `memfolio-btn ${cls}`;
  b.setAttribute('role', 'button');
  b.setAttribute('tabindex', '0');
  b.setAttribute('aria-label', title);
  b.title = title;
  b.append(icon([...paths], size));
  const act = (ev: Event): void => {
    ev.preventDefault();
    ev.stopPropagation();
    if (b.classList.contains('memfolio-busy')) return;
    b.classList.add('memfolio-busy');
    void onClick(b).finally(() => b.classList.remove('memfolio-busy'));
  };
  b.addEventListener('click', act);
  b.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') act(ev);
  });
  return b;
}

function shortcodeOfHref(href: string | null): string | null {
  if (!href) return null;
  const route = parseRoute(new URL(href, location.href).href);
  return route.kind === 'post' ? route.shortcode : null;
}

/** Shortcode of the post an element belongs to: the page address, a permalink nearby, or the page's own data. */
async function shortcodeFor(el: Element): Promise<string | null> {
  const route = parseRoute(location.href);
  if (route.kind === 'post') return route.shortcode;
  const container = el.closest('article') ?? el.closest('[role="dialog"]');
  const link = container?.querySelector(POST_LINK);
  const fromLink = shortcodeOfHref(link?.getAttribute('href') ?? null);
  if (fromLink) return fromLink;
  const pk = await bridge.probeMediaId(container ?? el);
  return pk ? idToShortcode(pk) : null;
}

/** Fetches a post and saves all of it, or the one item `pick` selects. */
export async function downloadPost(shortcode: string | null, pick?: (items: MediaItem[]) => MediaItem | null): Promise<void> {
  if (!shortcode) {
    surface.toast(t('postNotFound'), 'warn');
    return;
  }
  const progress = surface.toast(t('fetchingPost'), 'info', null);
  let items: MediaItem[];
  try {
    items = await fetchPostMedia(shortcode, { gql, mediaInfo, relayPost: bridge.relayPost, signal: never });
  } catch (e) {
    console.error('[memfolio]', e);
    surface.toast(t('downloadFailed', describeError(e)), 'error', null);
    return;
  } finally {
    progress.close();
  }
  if (!pick) return savePostItems(items);
  const one = pick(items);
  if (!one) {
    surface.toast(t('slideNotFound'), 'warn');
    return;
  }
  return savePostItems([one]);
}

function basenameOf(url: string | null | undefined): string | null {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;
  try {
    return new URL(url, location.href).pathname.split('/').pop() || null;
  } catch {
    return null;
  }
}

/** File names of everything an element (or its media children) currently displays. */
export function displayedNames(root: Element): Set<string> {
  const names = new Set<string>();
  const add = (url: string | null | undefined): void => {
    const name = basenameOf(url);
    if (name) names.add(name);
  };
  const media = root.matches('img, video') ? [root] : [...root.querySelectorAll('img, video')];
  for (const el of media) {
    if (el instanceof HTMLImageElement) {
      add(el.currentSrc);
      add(el.src);
      for (const part of el.srcset.split(',')) add(part.trim().split(/\s+/)[0]);
    } else if (el instanceof HTMLVideoElement) {
      add(el.currentSrc);
      add(el.src);
      add(el.poster);
      for (const s of el.querySelectorAll('source')) add(s.src);
    }
  }
  return names;
}

export function matchByNames(items: MediaItem[], names: Set<string>): MediaItem | null {
  return items.find((i) => i.basenames?.some((b) => names.has(b))) ?? null;
}

/** Which item of a carousel a slide shows: by file name, then by the position dots, then by the address. */
function itemOfSlide(slide: Element, items: MediaItem[]): MediaItem | null {
  if (items.length === 1) return items[0]!;
  const byName = matchByNames(items, displayedNames(slide));
  if (byName) return byName;
  const scope = slide.closest('article') ?? slide.closest('[role="dialog"]') ?? document;
  const dots = [...scope.querySelectorAll('._acnb')];
  const active = dots.findIndex((d) => d.classList.contains('_acnf'));
  if (active >= 0 && dots.length === items.length) return items[active] ?? null;
  const fromUrl = Number(new URLSearchParams(location.search).get('img_index'));
  return fromUrl >= 1 ? (items[fromUrl - 1] ?? null) : null;
}

function hasLargeMedia(el: Element): boolean {
  for (const m of el.querySelectorAll('img, video')) {
    if (m.getBoundingClientRect().width >= MIN_MEDIA_WIDTH) return true;
  }
  return false;
}

// ---- button in the post's action row ----------------------------------------

let scanning = false;

/**
 * Adds the download control next to the save-to-collection control of each
 * post. Only markup the page's UI framework has already taken over is touched:
 * changing server-rendered markup earlier makes the framework rebuild it.
 */
async function scanPosts(): Promise<void> {
  // A reel in the feed has a save control too, in a narrow column, and no permalink; the feed has its own button.
  if (parseRoute(location.href).kind === 'reels-feed') return;
  if (scanning) return;
  scanning = true;
  try {
    const found = [...document.querySelectorAll(BOOKMARK)];
    if (found.every((b) => b.parentElement?.querySelector(':scope > .memfolio-post-btn'))) return;
    const ready = await bridge.hydrated(BOOKMARK);
    found.forEach((bookmark, i) => {
      if (!ready[i] || !bookmark.isConnected) return;
      // `:has()` also matches wrappers; act on the innermost control only.
      if (found.some((other) => other !== bookmark && bookmark.contains(other))) return;
      const parent = bookmark.parentElement;
      if (!parent || parent.querySelector(':scope > .memfolio-post-btn')) return;
      parent.style.display = 'flex';
      parent.style.alignItems = 'center';
      parent.prepend(
        makeButton('memfolio-post-btn', t('btnPost'), ICONS.downloadAll, 24, async (el) => downloadPost(await shortcodeFor(el))),
      );
    });
  } finally {
    scanning = false;
  }
}

/** Adds the post controls to whatever posts are on the page now. Safe to call repeatedly. */
export function scanPage(): void {
  void scanPosts().catch((e) => console.warn('[memfolio] page scan failed', e));
}

// ---- floating button over thumbnails and carousel slides --------------------

interface HoverTarget {
  owner: Element;
  corner: 'top' | 'bottom';
  title: string;
  icon: readonly string[];
  run(): Promise<void>;
}

function slideOf(el: Element): Element | null {
  const slide = el.closest('li');
  const list = slide?.parentElement;
  if (!slide || !list || list.tagName !== 'UL') return null;
  if (!slide.closest('article, [role="dialog"], main')) return null;
  // Carousel slides are positioned with a transform; other lists of pictures are not.
  const positioned = slide.style.transform.includes('translate');
  if (!positioned && list.children.length < 2) return null;
  return hasLargeMedia(slide) ? slide : null;
}

function thumbnailOf(el: Element): HTMLAnchorElement | null {
  const link = el.closest<HTMLAnchorElement>(POST_LINK);
  if (!link || !shortcodeOfHref(link.getAttribute('href'))) return null;
  const picture = link.querySelector('img, video, [style*="background-image"]');
  return picture && picture.getBoundingClientRect().width >= MIN_MEDIA_WIDTH ? link : null;
}

function hoverTargetFor(el: Element): HoverTarget | null {
  const slide = slideOf(el);
  if (slide) {
    return {
      owner: slide,
      corner: 'top',
      title: t('btnSlide'),
      icon: ICONS.download,
      run: async () => downloadPost(await shortcodeFor(slide), (items) => itemOfSlide(slide, items)),
    };
  }
  const link = thumbnailOf(el);
  if (link) {
    return {
      owner: link,
      corner: 'bottom',
      title: t('btnPost'),
      icon: ICONS.downloadAll,
      run: () => downloadPost(shortcodeOfHref(link.getAttribute('href'))),
    };
  }
  return null;
}

/** A page-wide layer such as the dimmed background of an open dialog: what lies under it is not reachable. */
function isBackdrop(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9 && getComputedStyle(el).position === 'fixed';
}

/**
 * The thumbnail or slide at a point. Looks through small layers the page puts
 * on top of a picture (hover effects, play icons), but not through a backdrop.
 * Returns 'self' when the point is on the floating button.
 */
function hoverTargetAt(x: number, y: number): HoverTarget | 'self' | null {
  for (const el of document.elementsFromPoint(x, y).slice(0, 8)) {
    if (surface.owns(el)) return 'self';
    const target = hoverTargetFor(el);
    if (target) return target;
    if (isBackdrop(el)) return null;
  }
  return null;
}

/**
 * Shows one floating download button over the thumbnail or carousel slide under
 * the pointer. The button is part of the extension's own surface; nothing is
 * inserted into the page's markup.
 */
export function watchHover(signal: AbortSignal): void {
  let owner: Element | null = null;
  let point: { x: number; y: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = (): void => {
    owner = null;
    surface.hideHover();
  };
  const update = (): void => {
    timer = undefined;
    if (!point) return;
    const target = hoverTargetAt(point.x, point.y);
    if (target === 'self') return;
    if (!target) return hide();
    if (target.owner === owner) return;
    owner = target.owner;
    const rect = target.owner.getBoundingClientRect();
    const margin = 10;
    const left = Math.min(rect.right, innerWidth) - HOVER_BUTTON_SIZE - margin;
    const top =
      target.corner === 'top' ? Math.max(rect.top, 0) + margin : Math.min(rect.bottom, innerHeight) - HOVER_BUTTON_SIZE - margin;
    surface.showHover({ left, top, title: target.title, icon: target.icon, onClick: target.run });
  };
  document.addEventListener(
    'mousemove',
    (ev) => {
      // Pointer moves arrive in bursts; the latest position is evaluated at most every 60 ms.
      point = { x: ev.clientX, y: ev.clientY };
      timer ??= setTimeout(update, 60);
    },
    { capture: true, passive: true, signal },
  );
  // The button's position is fixed to the viewport; it is recomputed on the next pointer move.
  document.addEventListener('scroll', hide, { capture: true, signal });
  window.addEventListener('resize', hide, { signal });
}
