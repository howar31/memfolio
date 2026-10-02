// Styles of the in-page surface (shadow root). The palette is a dark brown on
// plain sheets with a soft orange for progress; the account panel opens from
// a round button at the bottom right.
export const HOST_CSS = `
:host {
  all: initial;
  --sheet: #ffffff;
  --sheet-2: #f7f2ed;
  --ink: #2a211c;
  --ink-2: #6f6259;
  --rule: #e3d8cd;
  --accent: #5b4033;
  --accent-ink: #ffffff;
  --spark: #d98f55;
  --warn: #8f7400;
  --red: #b3261e;
  --shadow: 0 6px 24px rgba(40, 24, 12, 0.18);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", "PingFang TC", "Microsoft JhengHei", "Noto Sans TC", sans-serif;
  color: var(--ink);
}
:host([data-theme="dark"]) {
  --sheet: #211c19;
  --sheet-2: #2c2622;
  --ink: #f1eae4;
  --ink-2: #b4a79c;
  --rule: #463d37;
  --accent: #e3bd98;
  --accent-ink: #2a1b12;
  --spark: #e6a06a;
  --warn: #e3c95a;
  --red: #ff8a80;
  --shadow: 0 6px 24px rgba(0, 0, 0, 0.5);
}
* { box-sizing: border-box; }
button { font: inherit; color: inherit; }
button:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.dock {
  position: fixed; right: 32px; bottom: 86px; z-index: 2147483000;
  display: flex; flex-direction: column; align-items: flex-end; gap: 10px;
  width: min(340px, calc(100vw - 48px)); pointer-events: none;
}
.dock > * { pointer-events: auto; }
.toasts { display: flex; flex-direction: column; gap: 8px; width: 100%; }
.dock.quiet .toasts { display: none; }
/* One button for all messages, only beside the open panel. */
.clear { display: none; width: 100%; justify-content: flex-end; margin-bottom: -2px; }
.dock.carded:not(.quiet)[data-waiting] .clear { display: flex; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px 3px 8px; font-size: 12px; box-shadow: var(--shadow); }

.toast {
  position: relative; width: 100%; padding: 10px 34px 10px 16px;
  background: var(--sheet); border: 1px solid var(--rule); border-radius: 8px;
  box-shadow: inset 4px 0 0 var(--accent), var(--shadow); white-space: pre-line; overflow-wrap: anywhere;
  animation: rise 140ms ease-out;
}
.toast.warn { box-shadow: inset 4px 0 0 var(--warn), var(--shadow); }
.toast.error { box-shadow: inset 4px 0 0 var(--red), var(--shadow); }
.toast .x {
  position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; padding: 2px;
  display: grid; place-items: center; border: 0; background: none; color: var(--ink-2); cursor: pointer; border-radius: 6px;
}
.toast .x:hover { background: var(--sheet-2); color: var(--ink); }

/* Only the panel and the ball take clicks; the strip beside the ball stays the page's. */
.card-slot { width: 100%; pointer-events: none; }
.card { width: 100%; display: flex; flex-direction: column; align-items: flex-end; gap: 10px; pointer-events: none; }
.card > * { pointer-events: auto; }
.card .body {
  width: 100%; background: var(--sheet); border: 1px solid var(--rule);
  border-radius: 8px; box-shadow: var(--shadow); padding: 12px;
}
.card .who { margin-bottom: 4px; font-size: 14px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The button has the shape of the logo's tile, so the mark is not cut off. */
.ball {
  position: relative; width: 52px; height: 52px; margin: -4px; padding: 4px;
  border: 0; border-radius: 14px; background: none; cursor: pointer;
}
.ball::before { content: ""; position: absolute; inset: 0; border-radius: 14px; }
.ball .core {
  position: relative; display: grid; place-items: center; width: 100%; height: 100%;
  border-radius: 10px; overflow: hidden; background: #4a3528; box-shadow: var(--shadow);
}
.ball .core svg { display: block; }
.dock.quiet[data-waiting]:not(.nodot) .ball::after {
  content: ""; position: absolute; top: 0; right: 0; width: 14px; height: 14px;
  border: 2px solid var(--sheet); border-radius: 50%; background: var(--accent);
}
.dock.quiet[data-waiting="warn"]:not(.nodot) .ball::after { background: var(--warn); }
.dock.quiet[data-waiting="error"]:not(.nodot) .ball::after { background: var(--red); }
.ball:hover .core { filter: brightness(1.08); }
.ball.busy::before { background: conic-gradient(var(--spark) calc(var(--p, 0) * 1%), var(--rule) 0); }
.ball.busy.unknown::before { background: var(--spark); animation: pulse 1.4s ease-in-out infinite; }
.ball.busy .core { box-shadow: 0 0 0 2px var(--sheet); }
.card .path { font-weight: 600; overflow-wrap: anywhere; }
.card .meta { color: var(--ink-2); font-size: 12px; font-variant-numeric: tabular-nums; }
.card .note { margin-top: 6px; font-size: 12px; color: var(--warn); }
.card .note.error { color: var(--red); }
.card .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.card .more { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--rule); font-size: 12px; }
.bar { height: 4px; margin-top: 8px; background: var(--sheet-2); border-radius: 2px; overflow: hidden; }
.bar > i { display: block; height: 100%; width: 0; background: var(--spark); transition: width 200ms linear; }
.bar.unknown > i { width: 35%; animation: slide 1.4s ease-in-out infinite; }

.btn {
  padding: 5px 12px; border: 1px solid var(--rule); border-radius: 6px;
  background: var(--sheet); color: var(--ink); cursor: pointer; font-weight: 600;
}
.btn:hover { background: var(--sheet-2); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
.btn.primary:hover { filter: brightness(1.08); }
.btn:disabled { opacity: 0.5; cursor: default; }
.link { padding: 0; border: 0; background: none; color: var(--accent); cursor: pointer; text-decoration: underline; font: inherit; }

.fabs { display: flex; gap: 8px; }
.fab {
  display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px;
  background: var(--sheet); border: 1px solid var(--rule); border-radius: 8px; box-shadow: var(--shadow);
  cursor: pointer; font-weight: 600;
}
.fab:hover { background: var(--sheet-2); }

.hoverbtn {
  position: fixed; z-index: 2147482999; width: 34px; height: 34px; padding: 0;
  display: grid; place-items: center; border: 0; border-radius: 8px;
  background: rgba(20, 24, 22, 0.82); color: #fff; cursor: pointer;
}
.hoverbtn:hover { background: #8a5a3c; }
.hoverbtn:disabled { opacity: 0.5; cursor: default; }

.overlay {
  position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center;
  background: rgba(24, 16, 10, 0.5); padding: 16px;
}
.dialog {
  width: min(460px, 100%); max-height: calc(100vh - 32px); overflow: auto;
  background: var(--sheet); border: 1px solid var(--rule); border-radius: 8px; box-shadow: var(--shadow); padding: 18px;
}
.dialog.wide { width: min(720px, 100%); }
.dialog h2 { margin: 0 0 8px; font-size: 15px; font-weight: 650; }
.dialog p { margin: 0 0 8px; white-space: pre-line; overflow-wrap: anywhere; }
.dialog .buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 16px; }

table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th { text-align: left; font-weight: 600; color: var(--ink-2); }
th[scope="row"] { width: 34%; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; overflow-wrap: anywhere; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td .sub { color: var(--ink-2); }
td .flag { color: var(--warn); }

@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes pulse { 50% { opacity: 0.3; } }
@keyframes slide { 0% { margin-left: -35%; } 100% { margin-left: 100%; } }
@media (prefers-reduced-motion: reduce) {
  .toast { animation: none; }
  .bar > i { transition: none; }
  .bar.unknown > i { animation: none; width: 100%; opacity: 0.4; }
  .ball.busy.unknown::before { animation: none; }
}
`;
