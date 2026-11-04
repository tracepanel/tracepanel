// Where the panel sits on the page: docked at the right or the bottom, its size, the handle that resizes it, and the
// room it keeps under the page.

import { DEFAULT_HEIGHT, DEFAULT_WIDTH, type Dock, MIN_HEIGHT, MIN_WIDTH, type PanelState, savePanel } from "./persist";

export interface PanelDock {
  /** What the widget keeps of it, with whether the panel is open. */
  state(): PanelState;
  /** Puts it back as it was kept. */
  restore(saved: PanelState): void;
  /** The other side of the page. */
  toggle(): void;
  fitBadge(): void;
  makeRoom(): void;
}

export function createDock({
  host,
  panel,
  badge,
  handle,
  tellDock,
}: {
  host: HTMLElement;
  panel: HTMLElement;
  badge: HTMLElement;
  handle: HTMLElement;
  /** Tells the panel in its frame where it is docked. */
  tellDock: (dock: Dock) => void;
}): PanelDock {
  let width = DEFAULT_WIDTH;
  let height = DEFAULT_HEIGHT;
  let dock: Dock = "right";

  function setWidth(value: number): void {
    width = Math.round(Math.min(Math.max(value, MIN_WIDTH), window.innerWidth - 40));
    host.style.setProperty("--tracepanel-width", `${width}px`);
    fitBadge();
  }

  /** Whether the badge fits left of the right-docked panel, measured unfolded (no paint in between). */
  function fitBadge(): void {
    host.removeAttribute("data-crowded");
    host.toggleAttribute("data-crowded", window.innerWidth - width < badge.offsetWidth + 32);
  }
  window.addEventListener("resize", fitBadge);

  // The page's own bottom padding, kept while the panel docked at the bottom takes its place, as devtools do.
  // Room under the page for the panel docked at the bottom, so its end scrolls into view above it: a block placed
  // where the page's scrolling ends. Padding or a block after the content is lost on pages whose root is as tall as
  // the window and whose content overflows it (Django's admin).
  const room = document.createElement("div");
  room.setAttribute("aria-hidden", "true");
  room.dataset["tracepanelRoom"] = "";
  room.style.cssText = "position:absolute;left:0;top:0;width:1px;margin:0;padding:0;pointer-events:none";

  /** Moves the room to where the page's own scrolling ends: measured with the room out of the way, at the top. */
  function placeRoom(): void {
    room.style.top = "0";
    room.style.top = `${document.documentElement.scrollHeight}px`;
  }

  function makeRoom(): void {
    const covering = dock === "bottom" && panel.hasAttribute("data-open");
    if (!covering) {
      room.remove();
      return;
    }
    room.style.height = `${Math.min(height, window.innerHeight)}px`;
    if (!room.isConnected) document.body.append(room);
    placeRoom();
  }

  // The page grows (a list loads more, a section opens): near its end, the room follows it.
  let placing = false;
  window.addEventListener(
    "scroll",
    () => {
      if (placing || !room.isConnected) return;
      placing = true;
      requestAnimationFrame(() => {
        placing = false;
        if (window.scrollY + window.innerHeight * 2 > document.documentElement.scrollHeight) placeRoom();
      });
    },
    { passive: true },
  );
  window.addEventListener("resize", () => room.isConnected && placeRoom(), { passive: true });

  function setHeight(value: number): void {
    height = Math.round(Math.min(Math.max(value, MIN_HEIGHT), window.innerHeight - 40));
    host.style.setProperty("--tracepanel-height", `${height}px`);
    makeRoom();
  }

  function setDock(value: Dock): void {
    dock = value;
    host.dataset["dock"] = value;
    tellDock(value);
    makeRoom();
  }

  function state(): PanelState {
    return { open: panel.hasAttribute("data-open"), dock, width, height };
  }

  // Window-level listeners (no pointer capture): the iframe ignores the pointer while resizing.
  // One size change per frame, however fast the pointer events come.
  let resizeTo: { x: number; y: number } | null = null;
  const applyResize = (): void => {
    if (!resizeTo) return;
    if (dock === "bottom") setHeight(window.innerHeight - resizeTo.y);
    else setWidth(window.innerWidth - resizeTo.x);
    resizeTo = null;
  };
  const onResizeMove = (event: PointerEvent): void => {
    if (!resizeTo) requestAnimationFrame(applyResize);
    resizeTo = { x: event.clientX, y: event.clientY };
  };
  const stopResize = (): void => {
    applyResize();
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
    panel.removeAttribute("data-resizing");
    savePanel(state());
  };
  handle.addEventListener("pointerdown", (event: PointerEvent) => {
    event.preventDefault();
    panel.toggleAttribute("data-resizing", true);
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  });
  handle.addEventListener("dblclick", () => {
    if (dock === "bottom") setHeight(DEFAULT_HEIGHT);
    else setWidth(DEFAULT_WIDTH);
    savePanel(state());
  });
  return {
    state,
    restore(saved) {
      setWidth(saved.width ?? DEFAULT_WIDTH);
      setHeight(saved.height ?? DEFAULT_HEIGHT);
      setDock(saved.dock);
    },
    toggle: () => setDock(dock === "right" ? "bottom" : "right"),
    fitBadge,
    makeRoom,
  };
}
