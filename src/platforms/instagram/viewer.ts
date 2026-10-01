// Stories, highlights and the reels feed are full-screen viewers whose markup
// offers no stable place for a button, so their controls float in the corner.

import { t } from '../../core/i18n';
import { findAccountByUsername } from '../../core/records';
import type { MediaItem } from '../../core/types';
import { ICONS } from '../../ui/dom';
import { surface, type FloatingButton } from '../../ui/host';
import { fetchReelMedia, resolveUserId, type ReelRef } from './api';
import { bridge } from './bridge-client';
import { PLATFORM, describeError, gql } from './env';
import { displayedNames, downloadPost, matchByNames } from './page-buttons';
import { parseRoute, type Route } from './routes';
import { saveViaBrowser } from './save';
import { idToShortcode } from './shortcode';

const never = new AbortController().signal;

/** Media elements covering the middle of the window: what the viewer is showing now. */
function centredMedia(): Element[] {
  const x = innerWidth / 2;
  const y = innerHeight / 2;
  return [...document.querySelectorAll('img, video')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 200 && r.left <= x && r.right >= x && r.top <= y && r.bottom >= y;
  });
}

async function currentStoryItem(route: Route, items: MediaItem[]): Promise<MediaItem | null> {
  if (route.kind === 'story' && route.mediaId) {
    const byId = items.find((i) => i.pk === route.mediaId);
    if (byId) return byId;
  }
  const shown = centredMedia();
  for (const el of shown) {
    const byName = matchByNames(items, displayedNames(el));
    if (byName) return byName;
  }
  for (const el of shown) {
    const pk = await bridge.probeMediaId(el);
    const byProbe = pk ? items.find((i) => i.pk === pk) : null;
    if (byProbe) return byProbe;
  }
  return items.length === 1 ? items[0]! : null;
}

async function reelRef(route: Route): Promise<ReelRef | null> {
  if (route.kind === 'highlight') return { kind: 'highlight', highlightId: route.highlightId };
  if (route.kind !== 'story') return null;
  const known = await findAccountByUsername(PLATFORM, route.username);
  const resolved = await resolveUserId(route.username, {
    fromPage: bridge.findUserId,
    known: () => known?.id ?? null,
    gql,
    signal: never,
  });
  return resolved ? { kind: 'user', userId: resolved.id } : null;
}

/** Saves the story on screen, or every item of the current story or highlight. */
export async function downloadStory(all: boolean): Promise<void> {
  const route = parseRoute(location.href);
  const progress = surface.toast(t('fetchingStory'), 'info', null);
  try {
    const ref = await reelRef(route);
    if (!ref) {
      surface.toast(t('storyNotFound'), 'warn');
      return;
    }
    const items = (await fetchReelMedia(ref, { gql, signal: never })).filter((i) => i.url);
    if (items.length === 0) {
      surface.toast(t('storyNotFound'), 'warn');
      return;
    }
    if (all) return await saveViaBrowser(items);
    const one = await currentStoryItem(route, items);
    if (!one) {
      surface.toast(t('storyCurrentNotFound'), 'warn');
      return;
    }
    await saveViaBrowser([one]);
  } catch (e) {
    console.error('[memfolio]', e);
    surface.toast(t('downloadFailed', describeError(e)), 'error', null);
  } finally {
    progress.close();
  }
}

/** Saves the reel the feed is showing. */
export async function downloadCurrentReel(): Promise<void> {
  const route = parseRoute(location.href);
  let shortcode = route.kind === 'reels-feed' ? route.shortcode : null;
  if (!shortcode) {
    for (const el of centredMedia()) {
      const pk = await bridge.probeMediaId(el);
      if (pk) {
        shortcode = idToShortcode(pk);
        break;
      }
    }
  }
  await downloadPost(shortcode);
}

/** Floating controls for the given route; none outside the viewers. */
export function floatingButtonsFor(route: Route): FloatingButton[] {
  if (route.kind === 'story' || route.kind === 'highlight') {
    return [
      { label: t('btnStory'), icon: ICONS.download, onClick: () => void downloadStory(false) },
      { label: t('btnStoryAll'), icon: ICONS.downloadAll, onClick: () => void downloadStory(true) },
    ];
  }
  if (route.kind === 'reels-feed') {
    return [{ label: t('btnReel'), icon: ICONS.download, onClick: () => void downloadCurrentReel() }];
  }
  return [];
}
