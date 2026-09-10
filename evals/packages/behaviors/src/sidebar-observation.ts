import { callFunctionOnSurface, type Surface } from "@openwork/cdp";

/** Overflow, action-lane, and rail geometry without changing scroll position or focus. */
export function readSidebarOverflow(surface: Surface, title = "") {
  return callFunctionOnSurface(surface, title => {
    const list = document.querySelector<HTMLElement>('[data-sidebar="content"]');
    const rail = document.querySelector<HTMLElement>('[data-sidebar="rail"]')?.getBoundingClientRect();
    const titles = [...document.querySelectorAll<HTMLElement>("[data-session-title-text]")].map(node => node.textContent?.trim() ?? "");
    const text = [...document.querySelectorAll<HTMLElement>("[data-session-title-text]")]
      .find(node => node.textContent?.trim() === title);
    const viewport = text?.parentElement;
    return {
      list: list ? { clientWidth: list.clientWidth, scrollLeft: list.scrollLeft, scrollWidth: list.scrollWidth } : null,
      rail: rail ? { x: rail.left + rail.width / 2, y: rail.top + rail.height / 2 } : null,
      // Every rendered title, so a missing `title` names what the sidebar showed instead.
      titles,
      title: text && viewport ? { clientWidth: viewport.clientWidth, scrollWidth: text.scrollWidth,
        hiddenEdges: viewport.dataset.sessionTitleHiddenEdges ?? "", maskImage: getComputedStyle(viewport).maskImage } : null,
      rows: [...document.querySelectorAll<HTMLElement>("[data-sidebar-session-id]")].map(row => {
        const title = row.querySelector<HTMLElement>("[data-session-title-slot]");
        const actions = row.querySelector<HTMLElement>("[data-session-hover-actions]");
        if (!title || !actions) return null;
        return { title: title.textContent?.trim() ?? "", titleRight: title.getBoundingClientRect().right,
          actionsLeft: actions.getBoundingClientRect().left, actionsOpacity: getComputedStyle(actions).opacity };
      }),
    };
  }, [title]);
}

interface SidebarGeometry {
  at: number;
  scrollTop: number;
  viewport: { top: number; bottom: number };
  /** The "Workspaces" heading lane above the first workspace row. */
  lane: { top: number; bottom: number } | null;
  hash: string;
  selected: string[];
  management: string | null;
  rows: { id: string; top: number; bottom: number; x: number; y: number; projectionY: number }[];
}

interface ExpansionFrames {
  before: SidebarGeometry;
  triggerTop: number;
  label: string;
  frames: SidebarGeometry[];
  complete: boolean;
}

/** A native HTML drag that started on a session row, with the payload types it carries. */
interface SessionDragStart {
  sessionId: string;
  types: string[];
}

declare global {
  interface Window {
    [key: `sidebar-observation-${string}`]: {
      snapshot(): SidebarGeometry;
      expansion: ExpansionFrames | null;
      clicks: number;
      drags: SessionDragStart[];
      stop(): void;
    } | undefined;
  }
}

/** Install during arrangement: capture before a trusted expansion click, not after its animation. */
export async function observeSidebarExpansion(surface: Surface) {
  const key: `sidebar-observation-${string}` = `sidebar-observation-${crypto.randomUUID()}`;
  await callFunctionOnSurface(surface, (key: `sidebar-observation-${string}`) => {
    const snapshot = (): SidebarGeometry => {
      const content = document.querySelector<HTMLElement>('[data-sidebar="content"]');
      if (!content) throw new Error("Sidebar scroller is unavailable");
      const viewport = content.getBoundingClientRect();
      const lane = content.querySelector<HTMLElement>(".group\\/workspaces-header")?.getBoundingClientRect();
      const rows = [...content.querySelectorAll<HTMLElement>(
        '[data-sidebar-session-id], [data-sidebar-workspace-title], [data-session-group], [role="button"][aria-expanded]',
      )].filter(row => row.getClientRects().length && getComputedStyle(row).visibility !== "hidden")
        .map(row => {
          const box = row.getBoundingClientRect();
          const workspace = row.closest<HTMLElement>('[data-sidebar-workspace-id]')?.dataset.sidebarWorkspaceId;
          const id = row.dataset.sidebarSessionId ? `session:${row.dataset.sidebarSessionId}`
            : row.hasAttribute("data-sidebar-workspace-title") ? `workspace:${workspace}`
              : `group:${row.dataset.sessionGroup ?? "ungrouped"}`;
          let projectionY = 0;
          for (let ancestor: HTMLElement | null = row; ancestor && ancestor !== content; ancestor = ancestor.parentElement) {
            const transform = getComputedStyle(ancestor).transform;
            if (transform !== "none") projectionY += new DOMMatrixReadOnly(transform).m42;
          }
          // Group dragging starts on its title span, not its collapse icon or menu.
          const handle = row.hasAttribute("data-session-group") ? row.querySelector("span.cursor-grab") : row;
          const handleBox = (handle ?? row).getBoundingClientRect();
          return { id, top: box.top, bottom: box.bottom, x: handleBox.left + handleBox.width / 2,
            y: handleBox.top + handleBox.height / 2, projectionY };
        });
      return {
        at: performance.now(), scrollTop: content.scrollTop,
        viewport: { top: viewport.top, bottom: viewport.bottom },
        lane: lane ? { top: lane.top, bottom: lane.bottom } : null, rows,
        hash: location.hash,
        selected: [...document.querySelectorAll<HTMLElement>('[data-session-tab-active="true"]')]
          .map(row => row.dataset.sessionTabId ?? ""),
        management: localStorage.getItem("openwork.react.sessionManagement"),
      };
    };
    let frame = 0;
    let timer: ReturnType<typeof setTimeout>;
    const observer: NonNullable<Window[typeof key]> = {
      snapshot, expansion: null, clicks: 0, drags: [],
      stop() {
        cancelAnimationFrame(frame);
        clearTimeout(timer);
        document.removeEventListener("click", onClick, true);
        document.removeEventListener("dragstart", onDragStart);
      },
    };
    // Bubble phase: the row's own dragstart handler has filled the payload by then.
    const onDragStart = (event: DragEvent) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const row = event.target.closest<HTMLElement>("[data-sidebar-session-id]");
      if (!row) return;
      observer.drags.push({ sessionId: row.dataset.sidebarSessionId ?? "", types: [...(event.dataTransfer?.types ?? [])] });
    };
    const onClick = (event: MouseEvent) => {
      if (!event.isTrusted || !(event.target instanceof Element)) return;
      const trigger = event.target.closest<HTMLElement>('[data-sidebar="menu-sub-button"]');
      const label = trigger?.textContent?.trim() ?? "";
      if (!trigger?.closest('[data-sidebar="content"]') || !/^Show \d+ more$/.test(label)) return;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      const expansion: ExpansionFrames = { before: snapshot(), triggerTop: trigger.getBoundingClientRect().top,
        label, frames: [], complete: false };
      observer.expansion = expansion;
      observer.clicks++;
      const sample = () => {
        expansion.frames.push(snapshot());
        if (performance.now() - expansion.before.at >= 1_500) expansion.complete = true;
        else if (expansion.frames.length < 240) frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
      // A suspended renderer or missing frames must fail rather than silently pass.
      timer = setTimeout(() => cancelAnimationFrame(frame), 5_000);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("dragstart", onDragStart);
    window[key] = observer;
  }, [key]);
  return {
    read() {
      return callFunctionOnSurface(surface, (key: `sidebar-observation-${string}`) => {
        const observer = window[key];
        if (!observer) throw new Error("Sidebar frame observation was lost");
        return { current: observer.snapshot(), expansion: observer.expansion, clicks: observer.clicks, drags: observer.drags };
      }, [key]);
    },
    async [Symbol.asyncDispose]() {
      await callFunctionOnSurface(surface, (key: `sidebar-observation-${string}`) => {
        window[key]?.stop(); delete window[key];
      }, [key]);
    },
  };
}
