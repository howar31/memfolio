import en from '../_locales/en/messages.json';
import zhTW from '../_locales/zh_TW/messages.json';
import { getSettings, type Language, type TimeFormat } from './records';

export type MessageKey = keyof typeof en;

type Catalog = Record<string, { message: string } | undefined>;
type Chosen = Exclude<Language, 'auto'>;

// The browser's own message lookup cannot switch language at run time, so a
// language chosen in the options is served from the catalogs bundled here.
const CATALOGS: Record<Chosen, { catalog: Catalog; tag: string }> = {
  en: { catalog: en, tag: 'en' },
  zh_TW: { catalog: zhTW, tag: 'zh-TW' },
};

/** `null`: follow the browser's UI language. */
let chosen: Chosen | null = null;

export function setLanguage(language: Language): void {
  chosen = language !== 'auto' && language in CATALOGS ? language : null;
}

let timeFormat: TimeFormat = '24';

export function setTimeFormat(format: TimeFormat): void {
  timeFormat = format === '12' ? '12' : '24';
}

/** Reads the language and clock settings; call before the first `t()`. */
export async function initI18n(): Promise<void> {
  const settings = await getSettings();
  setLanguage(settings.language);
  setTimeFormat(settings.timeFormat);
}

/** BCP 47 tag of the language the UI is shown in. */
export function uiLanguage(): string {
  if (chosen) return CATALOGS[chosen].tag;
  try {
    return chrome.i18n.getUILanguage();
  } catch {
    return 'en';
  }
}

function fill(message: string, subs: Array<string | number>): string {
  return message.replace(/\$([1-9])/g, (_, d: string) => String(subs[Number(d) - 1] ?? ''));
}

/** Localised text; `$1`..`$9` in the message are replaced by `subs`. */
export function t(key: MessageKey, ...subs: Array<string | number>): string {
  if (chosen) {
    const message = CATALOGS[chosen].catalog[key]?.message;
    if (message) return fill(message, subs);
  }
  try {
    return chrome.i18n.getMessage(key, subs.map(String)) || key;
  } catch {
    // The extension was reloaded or removed under a page that still runs this script.
    return fill((en as Catalog)[key]?.message ?? key, subs);
  }
}

/** Number with the locale's digit grouping. */
export function n(value: number): string {
  return value.toLocaleString(uiLanguage());
}

/** Compact date and time in the UI language, on the chosen clock. */
export function when(timestamp: number): string {
  return new Date(timestamp).toLocaleString(uiLanguage(), { dateStyle: 'medium', timeStyle: 'short', hourCycle: timeFormat === '12' ? 'h12' : 'h23' });
}
