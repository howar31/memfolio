import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../src/_locales/en/messages.json';
import zhTW from '../../src/_locales/zh_TW/messages.json';
import { initI18n, n, setLanguage, t, uiLanguage, when } from '../../src/core/i18n';

let stored: Record<string, unknown> = {};

beforeEach(() => {
  stored = {};
  vi.stubGlobal('chrome', {
    i18n: {
      getMessage: (key: string, subs: string[]) => `browser:${key}:${subs.join(',')}`,
      getUILanguage: () => 'de',
    },
    storage: { local: { get: async () => stored } },
  });
  setLanguage('auto');
});

afterEach(() => vi.unstubAllGlobals());

describe('ui language', () => {
  it('follows the browser by default', async () => {
    await initI18n();
    expect(t('importFailed', 'x')).toBe('browser:importFailed:x');
    expect(uiLanguage()).toBe('de');
  });

  it('uses the language stored in the settings', async () => {
    stored = { settings: { language: 'zh_TW' } };
    await initI18n();
    expect(t('optDevMode')).toBe(zhTW.optDevMode.message);
    expect(uiLanguage()).toBe('zh-TW');
    expect(n(1234567)).toBe('1,234,567');
  });

  it('fills placeholders like the browser does', () => {
    setLanguage('en');
    expect(t('importFailed', 'boom')).toBe(en.importFailed.message.replace('$1', 'boom'));
    expect(t('importFailed')).toBe(en.importFailed.message.replace('$1', ''));
  });

  it('goes back to the browser when set to auto or to an unknown value', () => {
    setLanguage('en');
    setLanguage('auto');
    expect(t('optDevMode')).toBe('browser:optDevMode:');
    setLanguage('fr' as never);
    expect(t('optDevMode')).toBe('browser:optDevMode:');
  });
});

describe('time of day', () => {
  const evening = new Date(2026, 9, 1, 20, 26).getTime();

  it('is shown on a 24-hour clock by default', async () => {
    stored = { settings: { language: 'en' } };
    await initI18n();
    expect(when(evening)).toContain('20:26');
  });

  it('is shown on a 12-hour clock when the settings say so', async () => {
    stored = { settings: { language: 'en', timeFormat: '12' } };
    await initI18n();
    expect(when(evening)).toContain('8:26');
    expect(when(evening)).toContain('PM');
  });

  it('goes back to 24 hours when the setting is cleared', async () => {
    stored = { settings: { language: 'en', timeFormat: '12' } };
    await initI18n();
    stored = { settings: { language: 'en' } };
    await initI18n();
    expect(when(evening)).toContain('20:26');
  });
});
