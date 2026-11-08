"use client";

import { Dialog } from "@base-ui/react/dialog";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { WorkbotComputer } from "./computer";
import { useStopWorkbot } from "./data";
import { useRetainedSurface, workbotHost } from "./host";
import { useWideScreen } from "./workspace";
import type { WorkbotViewContext } from "@openwork/types/workbot-context";
import type { BrowserTask } from "./computer-work";

/** The transcript owns the task; opening its view never starts or resumes a task. */
export type BrowserPreviewTask = BrowserTask & { id: string };
const BrowserPreviewContext = createContext<{
  open(task: BrowserPreviewTask): void;
  update(task: BrowserPreviewTask): void;
  visible: boolean;
  context: WorkbotViewContext | null;
  includeContext: boolean;
  setIncludeContext(include: boolean): void;
} | null>(null);
export const useBrowserPreview = () => useContext(BrowserPreviewContext);

/** One existing browser viewer, laid out beside chat on desktop or in a phone sheet. Only a tap opens it (S5). */
export function BrowserExperience({ children }: { children: ReactNode }) {
  const [task, setTask] = useState<BrowserPreviewTask | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState<WorkbotViewContext | null>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const contextTab = context?.kind === "browser" ? context.tabId : null;
  useEffect(() => { setIncludeContext(true); }, [contextTab]);
  const wide = useWideScreen();
  const surface = useRetainedSurface(task !== null && workbotHost().browser === true);
  const stop = useStopWorkbot();
  const open = useCallback((next: BrowserPreviewTask) => { setTask(next); setExpanded(false); setIncludeContext(true); }, []);
  const update = useCallback((next: BrowserPreviewTask) => setTask(current => current?.id === next.id && (current.status !== next.status || current.title !== next.title || current.reason !== next.reason) ? next : current), []);
  const close = () => setTask(null);
  const viewer = task && surface.open ? <WorkbotComputer key={task.id} task={task} onContextChange={setContext} onClose={close} onStop={() => stop.mutateAsync().then(() => undefined)} {...(wide ? { expanded, onExpand: () => setExpanded(value => !value) } : {})} /> : null;
  return <BrowserPreviewContext.Provider value={{ open, update, visible: surface.open, context: surface.open ? context : null, includeContext, setIncludeContext }}>
    <div className="flex h-full min-h-0 min-w-0 flex-1" data-workbot-browser-layout>
      <div className={`min-h-0 min-w-0 flex-1 ${wide && surface.open && expanded ? "hidden" : ""} ${wide && surface.open ? "max-w-[480px]" : ""}`}>{children}</div>
      {wide && surface.open ? <aside className="workbot flex min-h-0 min-w-0 flex-[2] flex-col border-l border-[var(--wb-hairline)] bg-[var(--wb-bg)]" aria-label="Browser preview" data-workbot-browser-panel>{viewer}</aside> : null}
    </div>
    {!wide ? <Dialog.Root open={surface.open} onOpenChange={next => { if (!next) close(); }}>
      <Dialog.Portal {...surface.portal}>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-[var(--wb-ink)]/40" />
        <Dialog.Popup className="workbot workbot-browser-sheet fixed inset-0 z-50 flex flex-col overflow-hidden bg-[var(--wb-bg)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none" data-workbot-browser-sheet>
          <Dialog.Title className="sr-only">{task?.title ?? "Browser preview"}</Dialog.Title>
          {viewer}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root> : null}
  </BrowserPreviewContext.Provider>;
}
