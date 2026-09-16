"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const HeaderActionsContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
} | null>(null);

export function DashboardHeaderActionsProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <HeaderActionsContext.Provider value={{ target, setTarget }}>{children}</HeaderActionsContext.Provider>;
}

export function DashboardHeaderActionsSlot() {
  const context = useContext(HeaderActionsContext);
  return <div ref={context?.setTarget} data-dashboard-header-actions />;
}

export function DashboardHeaderActions({ children }: { children: ReactNode }) {
  const context = useContext(HeaderActionsContext);
  return context?.target ? createPortal(children, context.target) : null;
}
