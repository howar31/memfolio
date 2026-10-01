import type { MediaItem, MediaKind } from '../../core/types';

type Json = Record<string, unknown>;

interface Rendition {
  url?: unknown;
  width?: unknown;
  height?: unknown;
}

export interface OwnerOverride {
  ownerId: string;
  ownerUsername: string;
}

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function basename(url: string): string | null {
  try {
    const name = new URL(url).pathname.split('/').pop();
    return name ? name : null;
  } catch {
    return null;
  }
}

function basenamesOf(...lists: unknown[]): string[] {
  const names = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const r of list as Rendition[]) {
      const name = isObject(r) && typeof r.url === 'string' ? basename(r.url) : null;
      if (name) names.add(name);
    }
  }
  return [...names];
}

function largest(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  let best: { url: string; area: number } | null = null;
  for (const r of list as Rendition[]) {
    if (!isObject(r) || typeof r.url !== 'string') continue;
    const area = (Number(r.width) || 0) * (Number(r.height) || 0);
    if (!best || area > best.area) best = { url: r.url, area };
  }
  return best?.url ?? null;
}

function one(media: Json, parent: { ownerId: string; ownerUsername: string; takenAt: number; shortcode: string | null }): MediaItem {
  const pk = str(media.pk) ?? str(media.id)?.split('_')[0];
  if (!pk) throw new Error('media without pk');
  const videos = Array.isArray(media.video_versions) ? media.video_versions : null;
  const kind: MediaKind = media.media_type === 2 || (videos !== null && videos.length > 0) ? 'video' : 'image';
  const images = isObject(media.image_versions2) ? media.image_versions2.candidates : null;
  let url: string | null;
  if (kind === 'video') {
    url = largest(videos);
  } else {
    url = largest(images);
    if (!url) throw new Error(`media ${pk} has no image candidates`);
  }
  return {
    id: `${pk}_${parent.ownerId}`,
    pk,
    ownerId: parent.ownerId,
    ownerUsername: parent.ownerUsername,
    takenAt: parent.takenAt,
    kind,
    url,
    shortcode: parent.shortcode,
    basenames: basenamesOf(images, videos),
  };
}

/**
 * Converts one media object of the v1 shape (timeline, tagged, single post,
 * story item) into downloadable items; a carousel yields one item per child.
 * Carousel children use the parent's timestamp: listings do not give them one.
 * Throws when the node cannot be used.
 */
export function mediaFromNode(node: unknown, owner?: OwnerOverride): MediaItem[] {
  if (!isObject(node)) throw new Error('media node is not an object');
  const media = isObject(node.media) ? node.media : node;

  const user = isObject(media.user) ? media.user : isObject(media.owner) ? media.owner : null;
  const idParts = str(media.id)?.split('_') ?? [];
  // `user.id` is not used: on some objects it is an app-scoped number, not the account id.
  const ownerId = owner?.ownerId ?? idParts[1] ?? str(user?.pk) ?? str(user?.pk_id);
  const ownerUsername = owner?.ownerUsername ?? str(user?.username);
  if (!ownerId || !ownerUsername) throw new Error('media without owner');

  const takenAt = Number(media.taken_at);
  if (!Number.isFinite(takenAt)) throw new Error('media without taken_at');
  const parent = { ownerId, ownerUsername, takenAt, shortcode: str(media.code) };

  if (Array.isArray(media.carousel_media) && media.carousel_media.length > 0) {
    return media.carousel_media.map((child) => {
      if (!isObject(child)) throw new Error('carousel child is not an object');
      return one(child, parent);
    });
  }
  return [one(media, parent)];
}

function legacyOne(node: Json, parent: { ownerId: string; ownerUsername: string; takenAt: number; shortcode: string | null }): MediaItem {
  const pk = str(node.id);
  if (!pk) throw new Error('legacy media without id');
  const kind: MediaKind = node.is_video ? 'video' : 'image';
  let url: string | null;
  if (kind === 'video') {
    url = str(node.video_url);
  } else {
    let best: { src: string; area: number } | null = null;
    for (const r of Array.isArray(node.display_resources) ? (node.display_resources as Json[]) : []) {
      if (!isObject(r) || typeof r.src !== 'string') continue;
      const area = (Number(r.config_width) || 0) * (Number(r.config_height) || 0);
      if (!best || area > best.area) best = { src: r.src, area };
    }
    url = best?.src ?? str(node.display_url);
    if (!url) throw new Error(`legacy media ${pk} has no image`);
  }
  return { id: `${pk}_${parent.ownerId}`, pk, ownerId: parent.ownerId, ownerUsername: parent.ownerUsername, takenAt: parent.takenAt, kind, url, shortcode: parent.shortcode };
}

/** Converts the older `shortcode_media` shape returned by the page's own post loader. */
export function legacyMediaFromShortcodeMedia(media: unknown): MediaItem[] {
  if (!isObject(media)) throw new Error('legacy media is not an object');
  const owner = isObject(media.owner) ? media.owner : null;
  const ownerId = str(owner?.id);
  const ownerUsername = str(owner?.username);
  if (!ownerId || !ownerUsername) throw new Error('legacy media without owner');
  const takenAt = Number(media.taken_at_timestamp);
  if (!Number.isFinite(takenAt)) throw new Error('legacy media without timestamp');
  const parent = { ownerId, ownerUsername, takenAt, shortcode: str(media.shortcode) };

  const children = isObject(media.edge_sidecar_to_children) ? media.edge_sidecar_to_children.edges : null;
  if (Array.isArray(children) && children.length > 0) {
    return children.map((edge) => {
      const node = isObject(edge) && isObject(edge.node) ? edge.node : null;
      if (!node) throw new Error('legacy carousel child is not an object');
      return legacyOne(node, parent);
    });
  }
  return [legacyOne(media, parent)];
}
