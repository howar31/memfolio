import { t } from '../core/i18n';
import { ICONS, h, icon } from './dom';
import { HOST_CSS } from './styles';

export type ToastKind = 'info' | 'warn' | 'error';

export interface ToastHandle {
  update(message: string): void;
  close(): void;
}

export interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
}

export interface FloatingButton {
  label: string;
  icon: readonly string[];
  onClick(): void;
}

export interface HoverButton {
  /** Viewport position of the button's top-left corner. */
  left: number;
  top: number;
  title: string;
  icon: readonly string[];
  onClick(): Promise<void>;
}

export const HOVER_BUTTON_SIZE = 34;

/**
 * The in-page surface: one shadow root holding toasts, the account card,
 * floating buttons and dialogs, so page styles and ours cannot affect each other.
 */
class Surface {
  private host: HTMLElement | null = null;
  private root!: ShadowRoot;
  private toasts!: HTMLElement;
  private cardSlot!: HTMLElement;
  private fabs!: HTMLElement;
  private hover: HTMLButtonElement | null = null;

  private ensure(): void {
    if (this.host?.isConnected) return;
    this.host = document.createElement('memfolio-surface');
    this.root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = HOST_CSS;
    this.toasts = h('div', { class: 'toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.cardSlot = h('div', { class: 'card-slot' });
    this.fabs = h('div', { class: 'fabs' });
    this.root.append(style, h('div', { class: 'dock' }, this.toasts, this.cardSlot, this.fabs));
    document.documentElement.append(this.host);
    this.syncTheme();
  }

  /** Follows the page's own light or dark appearance rather than the system setting. */
  syncTheme(): void {
    if (!this.host || !document.body) return;
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor);
    const dark = m ? (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3 < 128 : matchMedia('(prefers-color-scheme: dark)').matches;
    this.host.setAttribute('data-theme', dark ? 'dark' : 'light');
  }

  toast(message: string, kind: ToastKind = 'info', timeoutMs: number | null = 6000): ToastHandle {
    this.ensure();
    const text = h('div', { text: message });
    const el = h('div', { class: `toast ${kind === 'info' ? '' : kind}` }, text);
    const close = (): void => el.remove();
    el.append(h('button', { class: 'x', attrs: { 'aria-label': t('close') }, on: { click: close } }, icon([...ICONS.close], 14)));
    this.toasts.append(el);
    if (timeoutMs !== null) setTimeout(close, timeoutMs);
    return { update: (m) => (text.textContent = m), close };
  }

  /** Modal question. Resolves with the chosen value, or null when dismissed with Escape. */
  dialog<T>(opts: { title: string; message?: string; content?: Node; buttons: DialogButton<T>[]; wide?: boolean }): Promise<T | null> {
    this.ensure();
    return new Promise((resolve) => {
      const finish = (value: T | null): void => {
        overlay.remove();
        document.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key === 'Escape') {
          ev.stopPropagation();
          finish(null);
        }
      };
      const buttons = opts.buttons.map((b) =>
        h('button', { class: `btn ${b.primary ? 'primary' : ''}`, text: b.label, on: { click: () => finish(b.value) } }),
      );
      const box = h(
        'div',
        { class: `dialog ${opts.wide ? 'wide' : ''}`, attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.title } },
        h('h2', { text: opts.title }),
        opts.message ? h('p', { text: opts.message }) : null,
        opts.content ?? null,
        h('div', { class: 'buttons' }, ...buttons),
      );
      const overlay = h('div', { class: 'overlay' }, box);
      this.root.append(overlay);
      document.addEventListener('keydown', onKey, true);
      (buttons.find((b) => b.classList.contains('primary')) ?? buttons[0])?.focus();
    });
  }

  /** True for the element that hosts this surface (what page-level events see as their target). */
  owns(el: EventTarget | null): boolean {
    return el !== null && el === this.host;
  }

  /**
   * Shows the single floating button used over thumbnails and carousel slides.
   * It lives here rather than inside the page's markup, which therefore stays untouched.
   */
  showHover(button: HoverButton): void {
    this.ensure();
    this.hideHover();
    const el = h('button', { class: 'hoverbtn', title: button.title, attrs: { 'aria-label': button.title } }, icon([...button.icon], 18));
    el.style.left = `${Math.round(button.left)}px`;
    el.style.top = `${Math.round(button.top)}px`;
    el.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (el.disabled) return;
      el.disabled = true;
      void button.onClick().finally(() => (el.disabled = false));
    });
    this.hover = el;
    this.root.append(el);
  }

  hideHover(): void {
    this.hover?.remove();
    this.hover = null;
  }

  setCard(card: HTMLElement | null): void {
    this.ensure();
    // The card is rebuilt on every change; the ball keeps the keyboard focus across that.
    const focused = this.root.activeElement?.classList.contains('ball') === true;
    this.cardSlot.replaceChildren(...(card ? [card] : []));
    if (focused) card?.querySelector<HTMLElement>('.ball')?.focus();
  }

  setFloatingButtons(buttons: FloatingButton[]): void {
    this.ensure();
    this.fabs.replaceChildren(
      ...buttons.map((b) => h('button', { class: 'fab', on: { click: () => b.onClick() } }, icon([...b.icon], 18), h('span', { text: b.label }))),
    );
  }
}

export const surface = new Surface();
