export type MediaKind = 'image' | 'video';

/** One downloadable file. `id` is "<pk>_<ownerId>" and identifies the media across runs. */
export interface MediaItem {
  id: string;
  pk: string;
  ownerId: string;
  ownerUsername: string;
  /** Unix seconds. Carousel children carry their parent's value. */
  takenAt: number;
  kind: MediaKind;
  /** Null when the listing did not include a direct URL and the item must be resolved first. */
  url: string | null;
  /** Shortcode of the post this media belongs to, when known. */
  shortcode: string | null;
  /** File names (URL path basenames) of every rendition, used to match the media to an element on the page. */
  basenames?: string[];
}

export interface ListingPage {
  items: MediaItem[];
  /** Number of posts on the page (a carousel counts once). */
  postCount: number;
  /** Null when there is no further page. */
  nextCursor: string | null;
}

/** A paged, newest-first listing of an account's media. */
export interface ListingSource {
  fetchPage(cursor: string | null, signal: AbortSignal): Promise<ListingPage>;
}

export type StopReason =
  | 'login'
  | 'challenge'
  | 'rate-limited'
  | 'budget'
  | 'http'
  | 'bad-response'
  | 'graphql'
  | 'network';

/** Raised when requests to the platform must stop; never retried by callers. */
export class StopError extends Error {
  constructor(
    public readonly reason: StopReason,
    message: string,
  ) {
    super(message);
    this.name = 'StopError';
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : (e as { name?: string } | null)?.name === 'AbortError';
}
