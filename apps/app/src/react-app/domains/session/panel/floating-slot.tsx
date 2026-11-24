/** @jsxImportSource react */
import * as React from "react";

type FloatingSlotContextValue = {
  slot: HTMLElement | null;
  setSlot: (slot: HTMLElement | null) => void;
};

const FloatingSlotContext = React.createContext<FloatingSlotContextValue | null>(null);

export function FloatingSlotProvider({ children }: { children: React.ReactNode }) {
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  const value = React.useMemo(() => ({ slot, setSlot }), [slot]);
  return <FloatingSlotContext.Provider value={value}>{children}</FloatingSlotContext.Provider>;
}

export function useSessionFloatingSlot(): HTMLElement | null {
  return React.useContext(FloatingSlotContext)?.slot ?? null;
}

function composerDockTop(container: HTMLElement): number | null {
  const view = container.ownerDocument.defaultView;
  if (!view) return null;
  let top: number | null = null;
  for (const toolbar of container.querySelectorAll<HTMLElement>("[data-composer-toolbar]")) {
    let dock: HTMLElement | null = null;
    for (let node = toolbar.parentElement; node && node !== container; node = node.parentElement) {
      if (view.getComputedStyle(node).position === "sticky") {
        dock = node;
        break;
      }
    }
    dock ??= toolbar.closest<HTMLElement>("[data-empty-composer-dock]") ?? toolbar.parentElement ?? toolbar;
    const rect = dock.getBoundingClientRect();
    if (rect.height > 0) top = top === null ? rect.top : Math.min(top, rect.top);
  }
  return top;
}

export function SessionFloatingLayer() {
  const context = React.useContext(FloatingSlotContext);
  const setSlot = context?.setSlot;
  const [layer, setLayer] = React.useState<HTMLDivElement | null>(null);
  const [bottom, setBottom] = React.useState(0);

  React.useLayoutEffect(() => {
    if (!setSlot) return;
    setSlot(layer);
    return () => setSlot(null);
  }, [layer, setSlot]);

  React.useLayoutEffect(() => {
    const container = layer?.parentElement;
    if (!layer || !container) return;
    let frame: number | null = null;
    let measuring: { resize: ResizeObserver; mutations: MutationObserver } | null = null;

    const measure = () => {
      frame = null;
      const dockTop = composerDockTop(container);
      const next = dockTop === null ? 0 : Math.max(0, Math.round(container.getBoundingClientRect().bottom - dockTop));
      setBottom((current) => (current === next ? current : next));
    };
    const schedule = () => {
      if (frame === null) frame = window.requestAnimationFrame(measure);
    };
    const sync = () => {
      if (layer.childElementCount > 0 && !measuring) {
        const resize = new ResizeObserver(schedule);
        resize.observe(container);
        const mutations = new MutationObserver(schedule);
        mutations.observe(container, { childList: true, subtree: true });
        measuring = { resize, mutations };
        schedule();
      } else if (layer.childElementCount === 0 && measuring) {
        measuring.resize.disconnect();
        measuring.mutations.disconnect();
        measuring = null;
      }
    };
    const children = new MutationObserver(sync);
    children.observe(layer, { childList: true });
    sync();
    return () => {
      children.disconnect();
      measuring?.resize.disconnect();
      measuring?.mutations.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [layer]);

  if (!context) return null;
  return (
    <div
      ref={setLayer}
      data-session-floating-layer=""
      className="pointer-events-none absolute inset-x-0 top-0 z-30"
      style={{ bottom }}
    />
  );
}
