/** @jsxImportSource react */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

const DebugRailContext = createContext<{
  slot: HTMLDivElement | null;
  setSlot: (slot: HTMLDivElement | null) => void;
} | null>(null);

export function DebugRailProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ slot, setSlot }), [slot]);
  return <DebugRailContext.Provider value={value}>{children}</DebugRailContext.Provider>;
}

export function DebugRailSlot() {
  const context = useContext(DebugRailContext);
  return <div ref={context?.setSlot} className="mt-auto" data-testid="session-debug-rail" />;
}

export function useDebugRailSlot() {
  return useContext(DebugRailContext)?.slot ?? null;
}
