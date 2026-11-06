export const STYLE = `
  :host { all: initial; }
  /* The tones the pill and the card tint with, from the tokens: a verdict's amber and coral, the accent's violet.
     The light theme's tints are lighter and take their hue from the stronger ink. */
  :host {
    --amber: rgb(from var(--tp-warn-bg) r g b / 1);
    --coral: rgb(from var(--tp-error-bg) r g b / 1);
    --violet: var(--tp-violet);
    --tint-ok: rgb(from var(--tp-ok-bg) r g b / 0.13);
    --tint-info: rgb(from var(--tp-info-bg) r g b / 0.15);
    --tint-warn: rgb(from var(--amber) r g b / 0.15);
    --tint-error: rgb(from var(--coral) r g b / 0.16);
    --tint-violet: rgb(from var(--violet) r g b / 0.16);
    --ring-warn: rgb(from var(--amber) r g b / 0.16);
    --ring-error: rgb(from var(--coral) r g b / 0.3);
    --edge-error: rgb(from var(--coral) r g b / 0.9);
    --k-django: rgb(from var(--tp-k-django) r g b / 0.4);
  }
  :host([data-theme="light"]) {
    --coral: var(--tp-error);
    --violet: var(--tp-accent);
    --tint-ok: rgb(from var(--tp-ok-bg) r g b / 0.12);
    --tint-info: rgb(from var(--tp-info-bg) r g b / 0.09);
    --tint-warn: rgb(from var(--amber) r g b / 0.1);
    --tint-error: rgb(from var(--coral) r g b / 0.09);
    --tint-violet: rgb(from var(--violet) r g b / 0.1);
    --ring-warn: rgb(from var(--amber) r g b / 0.13);
    --ring-error: rgb(from var(--coral) r g b / 0.22);
    --edge-error: rgb(from var(--coral) r g b / 0.85);
    --k-django: rgb(from var(--tp-k-django) r g b / 0.3);
  }
  /* A dark pill in the corner: the request's verdict at a glance. Its ring is the verdict: none when all is well,
     amber when something wants a look, coral when it failed. */
  .badge {
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    display: flex; align-items: center; gap: 0; max-width: calc(100vw - 32px);
    height: 40px; padding: 0 6px 0 9px; border: 1px solid var(--tp-float-border); border-radius: 999px;
    background: var(--tp-float); color: var(--tp-float-text);
    box-shadow: var(--tp-float-shadow);
    font: 500 12.5px/1 "Geist Variable", "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    font-variant-numeric: tabular-nums; cursor: pointer;
    transition: right 180ms ease-out, box-shadow 180ms ease-out, border-color 120ms ease-out;
  }
  .badge[data-verdict="warn"] { border-color: rgb(from var(--amber) r g b / 0.45); box-shadow: 0 0 0 4px var(--ring-warn), var(--tp-float-drop); }
  /* A failure is the one thing not to miss: a solid coral edge and a stronger halo. */
  .badge[data-verdict="error"] { border-color: var(--edge-error); box-shadow: 0 0 0 4px var(--ring-error), var(--tp-float-drop); }
  /* Hover answers in place: the border, in the verdict's colour, gets stronger; the pill stays where it is. */
  .badge:hover { border-color: var(--tp-float-border-hover); }
  .badge[data-verdict="warn"]:hover { border-color: rgb(from var(--amber) r g b / 0.85); }
  .badge[data-verdict="error"]:hover { border-color: var(--coral); }
  /* From the keyboard: the accent, thin, as everywhere in the UI (not the logo's lime, which read as a verdict). */
  .badge:focus-visible { outline: none; filter: brightness(1.25); }
  .brand { display: flex; align-items: center; padding-right: 8px; }
  .brand svg { width: 21px; height: 21px; }
  .logo-1 { fill: var(--tp-accent-strong); }
  .logo-2 { fill: var(--tp-violet); }
  .logo-3 { fill: var(--tp-lime); }
  .runtime { align-self: center; display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; padding: 4px 7px; border-radius: 999px; background: var(--tp-float-chip); color: var(--tp-text-2); font-size: 10.5px; font-weight: 600; letter-spacing: 0.01em; }
  .brand .runtime svg { width: 12px; height: 12px; }
  .monogram { display: inline-grid; place-items: center; width: 12px; height: 12px; container-type: size; border-radius: 25%; background: color-mix(in srgb, currentColor 16%, transparent); font-weight: 700; line-height: 1; letter-spacing: -0.02em; }
  .monogram::before { content: attr(data-letters); font-size: 56cqh; }
  .monogram[data-letters="J"]::before { font-size: 72cqh; }
  .runtime:empty { display: none; }
  .stats { display: inline-flex; align-items: center; min-width: 0; height: 100%; }
  .seg { display: inline-flex; align-items: center; gap: 5px; height: 21px; padding: 0 8.5px; white-space: nowrap; }
  .seg + .seg { border-left: 1px solid var(--tp-float-divider); }
  .seg svg { width: 12.5px; height: 12.5px; color: var(--tp-text-3); flex: none; }
  .seg b { color: var(--tp-float-strong); font-weight: 600; }
  .unit { color: var(--tp-text-3); }
  /* In the light theme every icon in the pill is grey, a finding's and a failure's too. */
  :host([data-theme="light"]) .seg svg { color: var(--tp-text-3); }
  .status { padding: 3px 7px; border-radius: 999px; font: 600 11px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; background: var(--tint-ok); color: var(--tp-ok); }
  .status[data-tone="redirect"] { background: var(--tint-info); color: var(--tp-info); }
  .status[data-tone="client"] { background: var(--tint-warn); color: var(--tp-warn); }
  .status[data-tone="server"] { background: var(--tint-error); color: var(--tp-error); }
  /* In the light theme a status is a dot of its tone before the code, on its tone's tint: the panel's pill. */
  :host([data-theme="light"]) .status { display: inline-flex; align-items: center; gap: 5px; font-weight: 500; }
  :host([data-theme="light"]) .status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .seg[data-speed="slow"] b { color: var(--tp-warn); }
  .seg[data-speed="very-slow"] b { color: var(--tp-error); }
  /* lib/live's states, as the panel draws them: in flight, a ring that turns and the time so far; no answer yet, the
     hourglass and its words; a number not known yet, "…". */
  .running { display: inline-block; flex: none; width: 11px; height: 11px; box-sizing: border-box; border: 1.5px solid rgb(from var(--tp-accent) r g b / 0.28); border-top-color: var(--tp-accent); border-radius: 50%; animation: running 0.8s linear infinite; }
  @keyframes running { to { transform: rotate(360deg); } }
  .seg[data-state="running"] b { color: var(--tp-float-strong); }
  .no-answer { display: inline-flex; align-items: center; gap: 4px; color: var(--tp-text-3); font-size: 11.5px; white-space: nowrap; }
  .seg .no-answer svg { width: 12px; height: 12px; color: currentColor; }
  .pending { color: var(--tp-text-3); }
  .flying { color: var(--tp-text-2); }
  .issues { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; background: var(--tint-warn); color: var(--tp-warn); font-weight: 600; font-size: 11.5px; }
  .seg .issues svg { color: currentColor; }
  /* Its tasks': the Tasks icon, then the same chips as its own failures and issues. */
  .tasks { gap: 5px; }
  .tasks .failed { margin-left: 0; }
  .issues[data-tone="error"] { background: var(--tint-error); color: var(--tp-error); }
  /* The page's count: a step back from the latest request's numbers; its failures stand out on their own. */
  .page .unit { margin-left: -1px; }
  .failed { display: inline-flex; align-items: center; gap: 4px; margin-left: 3px; padding: 3px 8px; border-radius: 999px; background: var(--tint-error); color: var(--tp-error); font-weight: 600; font-size: 11.5px; }
  .seg .failed svg { width: 12px; height: 12px; color: currentColor; }
  .name {
    max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 6px;
    font: 500 12px "Geist Mono Variable", "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace; color: var(--tp-float-strong);
  }
  .name[data-pulse] { animation: pulse 700ms ease-out; }
  .idle { color: var(--tp-float-muted); font-size: 12px; white-space: nowrap; }
  @keyframes pulse {
    from { box-shadow: 0 0 0 0 rgb(from var(--tp-violet) r g b / 0.6); }
    to { box-shadow: 0 0 0 8px rgb(from var(--tp-violet) r g b / 0); }
  }
  .panel {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483646;
    width: min(var(--tracepanel-width, 600px), max(70vw, 20rem), 100vw); border-left: 1px solid var(--tp-float-edge);
    background: var(--tp-panel);
    backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
    box-shadow: var(--tp-float-panel-shadow);
    transform: translateX(100%); visibility: hidden;
    transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), width 200ms ease-out, visibility 0s 200ms;
  }
  .panel[data-open] { transform: none; visibility: visible; transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), width 200ms ease-out; }
  .panel[data-open] ~ .badge { right: calc(min(var(--tracepanel-width, 600px), max(70vw, 20rem), 100vw) + 16px); }
  /* The panel open shows the request: the badge folds to its logo (what closes the panel), its ring still the
     verdict. It no longer covers the page with what the panel already says. */
  .panel[data-open] ~ .badge { width: 40px; padding: 0; justify-content: center; }
  .panel[data-open] ~ .badge :is(.stats, .runtime) { display: none; }
  .panel[data-open] ~ .badge .brand { padding: 0; }
  /* The theme (the console's Dark / Light / Auto choice, shared through localStorage) is the :host's data-theme. */
  .panel iframe { width: 100%; height: 100%; border: 0; display: block; background: transparent; color-scheme: dark; }
  :host([data-theme="light"]) .panel iframe { color-scheme: light; }
  .panel[data-instant], .panel[data-instant] ~ .badge, .panel[data-resizing], .panel[data-resizing] ~ .badge { transition: none; }
  .panel[data-resizing] iframe { pointer-events: none; }
  /* 10px to grab, centred on the panel's 1px edge. What shows is that edge, a step stronger under the pointer and
     while dragging: never thicker, never the brand's colour (as the console's sidebar and split panes). */
  .resize { position: absolute; top: 0; bottom: 0; left: -6px; width: 10px; cursor: ew-resize; z-index: 1; }
  .resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 5px; width: 1px; background: transparent; transition: background 120ms; }
  .resize:hover::after, .panel[data-resizing] .resize::after { background: var(--tp-divider-active); }
  /* Docked at the bottom, like browser devtools: full width, the height is dragged from the top edge. */
  :host([data-dock="bottom"]) .panel {
    top: auto; left: 0; width: 100vw; height: min(var(--tracepanel-height, 360px), max(75vh, 16rem), 100vh);
    border-left: 0; border-top: 1px solid var(--tp-float-edge);
    box-shadow: var(--tp-float-panel-shadow-bottom);
    transform: translateY(100%);
    transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), height 200ms ease-out, visibility 0s 200ms;
  }
  :host([data-dock="bottom"]) .panel[data-open] { transform: none; transition: transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1), height 200ms ease-out; }
  :host([data-dock="bottom"]) .panel[data-open] ~ .badge { right: 16px; bottom: calc(min(var(--tracepanel-height, 360px), max(75vh, 16rem), 100vh) + 12px); }
  :host([data-dock="bottom"]) .resize { top: -6px; bottom: auto; left: 0; right: 0; width: auto; height: 10px; cursor: ns-resize; }
  :host([data-dock="bottom"]) .resize::after { top: 5px; bottom: auto; left: 0; right: 0; width: auto; height: 1px; }
  /* While dragging, the size follows the pointer: no transition (these selectors outrank the dock rules). */
  :host .panel[data-resizing], :host .panel[data-resizing][data-open], :host .panel[data-resizing] ~ .badge,
  :host([data-dock="bottom"]) .panel[data-resizing][data-open] { transition: none; }
  @media (prefers-reduced-motion: reduce) { .panel, .badge, .resize::after { transition: none; } .name[data-pulse] { animation: none; } .running { animation: none; } }
`;
