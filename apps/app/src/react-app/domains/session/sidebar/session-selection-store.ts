import { create } from "zustand";

export type SessionSelectionRef = { workspaceId: string; sessionId: string };

export type SessionSelection = {
  selected: SessionSelectionRef[];
  anchor: SessionSelectionRef | null;
};

export type SessionSelectionClick = {
  target: SessionSelectionRef;
  mode: "toggle" | "range";
  order: readonly SessionSelectionRef[];
  open: SessionSelectionRef | null;
};

export const EMPTY_SESSION_SELECTION: SessionSelection = { selected: [], anchor: null };

export const sessionSelectionKey = (ref: SessionSelectionRef) => `${ref.workspaceId}\u0000${ref.sessionId}`;

const sameRef = (a: SessionSelectionRef | null, b: SessionSelectionRef | null) =>
  Boolean(a && b && a.workspaceId === b.workspaceId && a.sessionId === b.sessionId);

export function applySessionSelectionClick(state: SessionSelection, click: SessionSelectionClick): SessionSelection {
  const { target, open } = click;
  if (click.mode === "toggle") {
    const seeded = state.selected.length === 0 && open && !sameRef(open, target) ? [open] : state.selected;
    const included = seeded.some((ref) => sameRef(ref, target));
    return {
      selected: included ? seeded.filter((ref) => !sameRef(ref, target)) : [...seeded, target],
      anchor: target,
    };
  }
  const order = dedupe(click.order);
  const anchor = state.anchor ?? open ?? target;
  const from = order.findIndex((ref) => sameRef(ref, anchor));
  const to = order.findIndex((ref) => sameRef(ref, target));
  if (from < 0 || to < 0) return { selected: [target], anchor: target };
  const [start, end] = from <= to ? [from, to] : [to, from];
  return { selected: order.slice(start, end + 1), anchor };
}

function dedupe(order: readonly SessionSelectionRef[]) {
  const seen = new Set<string>();
  return order.filter((ref) => {
    const key = sessionSelectionKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type SessionSelectionStore = SessionSelection & {
  click: (click: SessionSelectionClick) => void;
  clear: () => void;
};

export const useSessionSelectionStore = create<SessionSelectionStore>((set) => ({
  ...EMPTY_SESSION_SELECTION,
  click: (click) => set((state) => applySessionSelectionClick(state, click)),
  clear: () => set((state) => (state.selected.length === 0 && !state.anchor ? state : EMPTY_SESSION_SELECTION)),
}));

function clearSelectionOnEscape(event: KeyboardEvent) {
  if (event.key === "Escape" && !event.defaultPrevented) useSessionSelectionStore.getState().clear();
}

useSessionSelectionStore.subscribe((state, previous) => {
  if (typeof window === "undefined" || (state.selected.length > 0) === (previous.selected.length > 0)) return;
  if (state.selected.length > 0) window.addEventListener("keydown", clearSelectionOnEscape);
  else window.removeEventListener("keydown", clearSelectionOnEscape);
});

export function visibleSessionRowOrder(root: ParentNode): SessionSelectionRef[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-sidebar-session-id][data-sidebar-session-workspace-id]"))
    .flatMap((row) => {
      const sessionId = row.dataset.sidebarSessionId;
      const workspaceId = row.dataset.sidebarSessionWorkspaceId;
      return sessionId && workspaceId ? [{ workspaceId, sessionId }] : [];
    });
}
