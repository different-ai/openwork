import * as React from "react";
import { moveSessionInOrder } from "./session-order";

export const SESSION_DRAG_TYPE = "application/x-openwork-session-id";

type DraggedSession = { id: string; workspaceId: string };
const SessionDragContext = React.createContext<{
  session: DraggedSession | null;
  setSession: (session: DraggedSession | null) => void;
}>({ session: null, setSession: () => {} });

const SessionReorderContext = React.createContext<{
  sessionIds: Set<string>;
  orderIds: string[];
  onReorder: (ids: string[]) => void;
} | null>(null);

export function SessionDragScope({ children }: { children: React.ReactNode }) {
  const [session, setSession] = React.useState<DraggedSession | null>(null);
  return <SessionDragContext.Provider value={{ session, setSession }}>{children}</SessionDragContext.Provider>;
}

export const useDraggedSession = () => React.useContext(SessionDragContext);

/** Native row dragging also supports dropping onto a group's header. Using the
 * same gesture for ordering avoids native drag cancelling Motion's pointer drag.
 */
export function SessionReorderList({ sessionIds, orderIds, onReorder, children }: {
  sessionIds: string[];
  orderIds: string[];
  onReorder: (ids: string[]) => void;
  children: React.ReactNode;
}) {
  const ids = React.useMemo(() => new Set(sessionIds), [sessionIds]);
  return (
    <SessionReorderContext.Provider value={{ sessionIds: ids, orderIds, onReorder }}>
      <div className="flex flex-col gap-0.5">{children}</div>
    </SessionReorderContext.Provider>
  );
}

export function useSessionReorderTarget(id: string, workspaceId: string, enabled: boolean) {
  const drag = useDraggedSession();
  const list = React.useContext(SessionReorderContext);
  const ownsDrag = React.useRef(false);
  const [dropPosition, setDropPosition] = React.useState<"before" | "after" | null>(null);
  const accepts = enabled && drag.session && drag.session.id !== id
    && list?.sessionIds.has(drag.session.id) && list.sessionIds.has(id);

  React.useEffect(() => {
    if (!drag.session) setDropPosition(null);
  }, [drag.session]);

  React.useEffect(() => () => {
    if (ownsDrag.current) drag.setSession(null);
  }, [drag.setSession]);

  return {
    dropPosition: accepts ? dropPosition : null,
    dragProps: {
      draggable: true,
      onDragStart: (event: React.DragEvent) => {
        ownsDrag.current = true;
        event.dataTransfer.setData(SESSION_DRAG_TYPE, id);
        event.dataTransfer.effectAllowed = "move";
        drag.setSession({ id, workspaceId });
      },
      onDragEnd: () => {
        ownsDrag.current = false;
        drag.setSession(null);
        setDropPosition(null);
      },
      onDragOver: (event: React.DragEvent) => {
        if (!accepts || !event.dataTransfer.types.includes(SESSION_DRAG_TYPE)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const bounds = event.currentTarget.getBoundingClientRect();
        setDropPosition(event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropPosition(null);
      },
      onDrop: (event: React.DragEvent) => {
        setDropPosition(null);
        if (!accepts || !list || !drag.session || event.dataTransfer.getData(SESSION_DRAG_TYPE) !== drag.session.id) return;
        event.preventDefault();
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        list.onReorder(moveSessionInOrder(list.orderIds, drag.session.id, id, event.clientY >= bounds.top + bounds.height / 2));
        drag.setSession(null);
      },
    },
  };
}
