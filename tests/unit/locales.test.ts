import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../src/_locales/en/messages.json';
import zhTW from '../../src/_locales/zh_TW/messages.json';

type Catalog = Record<string, { message: string }>;

function placeholders(message: string): string[] {
  return [...new Set(message.match(/\$\d/g) ?? [])].sort();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

describe('message catalogs', () => {
  it('define the same keys in English and Traditional Chinese', () => {
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
  });

  it('use the same placeholders for every message', () => {
    for (const key of Object.keys(en)) {
      expect(placeholders((zhTW as Catalog)[key]!.message), key).toEqual(placeholders((en as Catalog)[key]!.message));
    }
  });

  it('contain no empty message', () => {
    for (const catalog of [en, zhTW] as Catalog[]) {
      for (const [key, entry] of Object.entries(catalog)) expect(entry.message.trim(), key).not.toBe('');
    }
  });

  it('cover every key the code asks for', () => {
    const used = new Set<string>();
    for (const file of sourceFiles(join(__dirname, '../../src'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9]+)'/g)) used.add(m[1]!);
      for (const m of text.matchAll(/:\s*'((?:stop|tab|status)[A-Z][A-Za-z]+)'/g)) used.add(m[1]!);
    }
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
  });

  it('keep the platform name out of the extension name', () => {
    for (const catalog of [en, zhTW] as Catalog[]) {
      expect(catalog.extName!.message).not.toMatch(/insta|\big\b|gram/i);
    }
  });
});
