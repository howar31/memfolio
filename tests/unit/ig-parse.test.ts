import { describe, expect, it } from 'vitest';
import { legacyMediaFromShortcodeMedia, mediaFromNode } from '../../src/platforms/instagram/parse';

const image = (w: number, h: number, name: string) => ({ url: `https://cdn.test/${name}.jpg?x=1`, width: w, height: h });

const photoNode = {
  id: '3000000000000000001_42',
  pk: '3000000000000000001',
  code: 'CODE1',
  taken_at: 1700000000,
  media_type: 1,
  user: { username: 'acct', pk: '42' },
  image_versions2: { candidates: [image(320, 320, 'small'), image(1080, 1350, 'large')] },
};

describe('mediaFromNode', () => {
  it('picks the largest image of a photo post', () => {
    expect(mediaFromNode(photoNode)).toEqual([
      {
        id: '3000000000000000001_42',
        pk: '3000000000000000001',
        ownerId: '42',
        ownerUsername: 'acct',
        takenAt: 1700000000,
        kind: 'image',
        url: 'https://cdn.test/large.jpg?x=1',
        shortcode: 'CODE1',
        basenames: ['small.jpg', 'large.jpg'],
      },
    ]);
  });

  it('records the file names of every rendition, including the cover of a video', () => {
    const node = {
      ...photoNode,
      media_type: 2,
      video_versions: [{ url: 'https://cdn.test/path/v720.mp4?a=1', width: 720, height: 1280 }],
    };
    expect(mediaFromNode(node)[0]!.basenames).toEqual(['small.jpg', 'large.jpg', 'v720.mp4']);
  });

  it('prefers the largest video rendition of a video post', () => {
    const node = {
      ...photoNode,
      media_type: 2,
      video_versions: [
        { url: 'https://cdn.test/v480.mp4', width: 480, height: 854, type: 102 },
        { url: 'https://cdn.test/v720.mp4', width: 720, height: 1280, type: 101 },
      ],
    };
    expect(mediaFromNode(node)[0]).toMatchObject({ kind: 'video', url: 'https://cdn.test/v720.mp4' });
  });

  it('leaves the URL empty for a video without direct renditions', () => {
    const node = { ...photoNode, media_type: 2, video_versions: null };
    expect(mediaFromNode(node)[0]).toMatchObject({ kind: 'video', url: null });
  });

  it('expands a carousel and gives children the parent timestamp and owner', () => {
    const node = {
      ...photoNode,
      media_type: 8,
      carousel_media: [
        {
          id: '3000000000000000002_42',
          pk: '3000000000000000002',
          media_type: 1,
          user: null,
          image_versions2: { candidates: [image(1080, 1080, 'c1')] },
        },
        {
          id: '3000000000000000003_42',
          pk: '3000000000000000003',
          media_type: 2,
          user: null,
          taken_at: 1699999999,
          image_versions2: { candidates: [image(1080, 1080, 'c2')] },
          video_versions: [{ url: 'https://cdn.test/c2.mp4', width: 720, height: 720 }],
        },
      ],
    };
    const items = mediaFromNode(node);
    expect(items.map((i) => [i.id, i.takenAt, i.ownerUsername, i.kind, i.shortcode])).toEqual([
      ['3000000000000000002_42', 1700000000, 'acct', 'image', 'CODE1'],
      ['3000000000000000003_42', 1700000000, 'acct', 'video', 'CODE1'],
    ]);
  });

  it('builds a child id from pk and owner when the child has no combined id', () => {
    const node = {
      ...photoNode,
      media_type: 8,
      carousel_media: [{ pk: '3000000000000000009', media_type: 1, image_versions2: { candidates: [image(1, 1, 'c')] } }],
    };
    expect(mediaFromNode(node)[0]!.id).toBe('3000000000000000009_42');
  });

  it('takes the owner id from the user object when the id has no owner part', () => {
    const node = { ...photoNode, id: '3000000000000000001' };
    expect(mediaFromNode(node)[0]).toMatchObject({ id: '3000000000000000001_42', ownerId: '42' });
  });

  it('does not take the app-scoped id of the user object for the account id', () => {
    const node = { ...photoNode, id: '3000000000000000001', user: { username: 'acct', id: '17841400000000000' } };
    expect(() => mediaFromNode(node)).toThrow(/owner/);
  });

  it('accepts an owner override for items that carry no user', () => {
    const { user: _user, ...storyItem } = photoNode;
    const items = mediaFromNode({ ...storyItem, id: '3000000000000000001' }, { ownerId: '42', ownerUsername: 'acct' });
    expect(items[0]).toMatchObject({ id: '3000000000000000001_42', ownerUsername: 'acct' });
  });

  it('unwraps nodes that nest the media object', () => {
    expect(mediaFromNode({ media: photoNode })[0]!.id).toBe('3000000000000000001_42');
  });

  it('throws on a node without an owner or without media', () => {
    expect(() => mediaFromNode({ ...photoNode, id: '1', user: null })).toThrow();
    expect(() => mediaFromNode({ ...photoNode, image_versions2: { candidates: [] } })).toThrow();
    expect(() => mediaFromNode(null)).toThrow();
  });
});

describe('legacyMediaFromShortcodeMedia', () => {
  const owner = { id: '42', username: 'acct' };

  it('reads a single legacy media', () => {
    const items = legacyMediaFromShortcodeMedia({
      id: '3000000000000000001',
      shortcode: 'CODE1',
      taken_at_timestamp: 1700000000,
      is_video: false,
      owner,
      display_url: 'https://cdn.test/display.jpg',
      display_resources: [
        { src: 'https://cdn.test/640.jpg', config_width: 640, config_height: 800 },
        { src: 'https://cdn.test/1080.jpg', config_width: 1080, config_height: 1350 },
      ],
    });
    expect(items).toEqual([
      {
        id: '3000000000000000001_42',
        pk: '3000000000000000001',
        ownerId: '42',
        ownerUsername: 'acct',
        takenAt: 1700000000,
        kind: 'image',
        url: 'https://cdn.test/1080.jpg',
        shortcode: 'CODE1',
      },
    ]);
  });

  it('reads legacy carousel children', () => {
    const items = legacyMediaFromShortcodeMedia({
      id: '3000000000000000001',
      shortcode: 'CODE1',
      taken_at_timestamp: 1700000000,
      owner,
      edge_sidecar_to_children: {
        edges: [
          { node: { id: '3000000000000000002', is_video: true, video_url: 'https://cdn.test/a.mp4' } },
          { node: { id: '3000000000000000003', is_video: false, display_url: 'https://cdn.test/b.jpg' } },
        ],
      },
    });
    expect(items.map((i) => [i.id, i.kind, i.url])).toEqual([
      ['3000000000000000002_42', 'video', 'https://cdn.test/a.mp4'],
      ['3000000000000000003_42', 'image', 'https://cdn.test/b.jpg'],
    ]);
  });
});
