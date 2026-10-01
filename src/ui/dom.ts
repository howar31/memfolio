type Child = Node | string | null | undefined | false;

interface Props {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
}

/** Small element builder. Text always goes through textContent, never markup. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const [type, handler] of Object.entries(props.on ?? {})) el.addEventListener(type, handler as EventListener);
  for (const c of children) if (c) el.append(c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icons are drawn for this project; `paths` is a list of path data on a 24x24 grid. */
export function icon(paths: string[], size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  }
  return svg;
}

/** The product mark without its background tile: two stacked instant photos. */
export function logoMark(size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 128 128');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const add = (parent: SVGElement, tag: string, attrs: Record<string, string>): SVGElement => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent.append(el);
    return el;
  };
  add(svg, 'rect', { x: '30', y: '26', width: '58', height: '70', rx: '4', fill: '#d9bfa2', transform: 'rotate(-11 64 64)' });
  const front = add(svg, 'g', { transform: 'rotate(7 64 64)' });
  add(front, 'rect', { x: '40', y: '30', width: '58', height: '70', rx: '4', fill: '#fbf3e6' });
  add(front, 'rect', { x: '46', y: '36', width: '46', height: '44', rx: '2', fill: '#8a644c' });
  add(front, 'circle', { cx: '78', cy: '50', r: '6', fill: '#d98f55' });
  add(front, 'path', { d: 'M46 80l14-17 11 11 8-8 13 14z', fill: '#5b4033' });
  return svg;
}

export const ICONS = {
  /** Arrow into a tray: save one file. */
  download: ['M12 4v11', 'M7.5 10.5 12 15l4.5-4.5', 'M5 19h14'],
  /** Arrow into a stack of trays: save every file of a post. */
  downloadAll: ['M12 3v9', 'M8 8.5 12 12.5l4-4', 'M5 16h14', 'M7 20h10'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  folder: ['M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2.5h8.5A1.5 1.5 0 0 1 21 10v7.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z'],
  minimize: ['M6 12h12'],
  /** Two sliders: settings. */
  settings: ['M4 8h7', 'M17 8h3', 'M11 8a3 3 0 1 0 6 0a3 3 0 1 0-6 0', 'M4 16h3', 'M13 16h7', 'M7 16a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
  back: ['M20 12H5', 'M11 6l-6 6 6 6'],
} as const;
