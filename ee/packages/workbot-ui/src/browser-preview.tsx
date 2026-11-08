"use client";

import { Dialog } from "@base-ui/react/dialog";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { artifactTitle } from "./artifact";
import { WorkbotComputer } from "./computer";
import { useStopWorkbot, type WorkbotAttachment } from "./data";
import { useRetainedSurface, workbotHost } from "./host";
import { OpenFileContext, OpenFileIdContext } from "./open-file";
import { ArtifactView } from "./preview";
import { useWideScreen } from "./workspace";
import type { WorkbotViewContext } from "@openwork/types/workbot-context";
import type { BrowserTask } from "./computer-work";

/** The transcript owns the task; opening its view never starts or resumes a task. */
export type BrowserPreviewTask = BrowserTask & { id: string };
type Opened = { kind: "browser"; task: BrowserPreviewTask } | { kind: "file"; file: WorkbotAttachment };
const BrowserPreviewContext = createContext<{
  open(task: BrowserPreviewTask): void;
  update(task: BrowserPreviewTask): void;
  /** The browser task's view is open (beside the chat or as the phone sheet). */
  visible: boolean;
  /** Anything is open beside the chat: the browser, or a file Workbot made. */
  panelOpen: boolean;
  /** The open file, so the screen can keep it at its newest version. */
  file: WorkbotAttachment | null;
  updateFile(file: WorkbotAttachment): void;
  context: WorkbotViewContext | null;
  includeContext: boolean;
  setIncludeContext(include: boolean): void;
} | null>(null);
export const useBrowserPreview = () => useContext(BrowserPreviewContext);

/**
 * One panel beside the chat on desktop, or a full-screen sheet on a phone, for whatever the person opened from the
 * conversation: a browser task's live view, or a file Workbot made (an app, a document, a spreadsheet). Opening one
 * replaces the other. Only a tap opens it (S5).
 */
export function BrowserExperience({ children }: { children: ReactNode }) {
  const [opened, setOpened] = useState<Opened | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [context, setContext] = useState<WorkbotViewContext | null>(null);
  const [includeContext, setIncludeContext] = useState(true);
  const contextTab = context?.kind === "browser" ? context.tabId : null;
  useEffect(() => { setIncludeContext(true); }, [contextTab]);
  const wide = useWideScreen();
  const task = opened?.kind === "browser" ? opened.task : null;
  const file = opened?.kind === "file" ? opened.file : null;
  const surface = useRetainedSurface(task !== null ? workbotHost().browser === true : file !== null);
  const stop = useStopWorkbot();
  // Focus goes back to what opened the panel (a card in the chat) when it closes.
  const opener = useRef<HTMLElement | null>(null);
  const remember = () => { if (document.activeElement instanceof HTMLElement && !opener.current) opener.current = document.activeElement; };
  const open = useCallback((next: BrowserPreviewTask) => { remember(); setOpened({ kind: "browser", task: next }); setExpanded(false); setIncludeContext(true); }, []);
  const update = useCallback((next: BrowserPreviewTask) => setOpened(current => current?.kind === "browser" && current.task.id === next.id && (current.task.status !== next.status || current.task.title !== next.title || current.task.reason !== next.reason) ? { kind: "browser", task: next } : current), []);
  const openFile = useCallback((next: WorkbotAttachment) => {
    if (next.id.startsWith("local-")) return;
    remember();
    setOpened(current => (current?.kind === "file" && current.file.id === next.id ? current : { kind: "file", file: next }));
  }, []);
  const updateFile = useCallback((next: WorkbotAttachment) => setOpened(current => current?.kind === "file" && current.file.id === next.id && current.file.updatedAt !== next.updatedAt ? { kind: "file", file: next } : current), []);
  const close = useCallback(() => {
    setOpened(null);
    setExpanded(false);
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) requestAnimationFrame(() => back.focus({ preventScroll: true }));
  }, []);
  // Esc closes the desktop panel; the phone sheet's dialog closes itself. An open menu or dialog takes Esc first.
  useEffect(() => {
    if (!wide || !file) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("[role='menu'], [role='dialog']")) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide, file, close]);
  const viewer = !surface.open ? null
    : task ? <WorkbotComputer key={task.id} task={task} onContextChange={setContext} onClose={close} onStop={() => stop.mutateAsync().then(() => undefined)} {...(wide ? { expanded, onExpand: () => setExpanded(value => !value) } : {})} />
    : file ? <ArtifactView key={file.id} file={file} onClose={close} {...(wide ? { expanded, onExpand: () => setExpanded(value => !value) } : {})} />
    : null;
  const panelOpen = surface.open && opened !== null;
  const label = task ? "Browser preview" : file ? artifactTitle(file) : "Preview";
  return <BrowserPreviewContext.Provider value={{ open, update, visible: surface.open && task !== null, panelOpen, file, updateFile, context: surface.open && task ? context : null, includeContext, setIncludeContext }}>
    <OpenFileContext.Provider value={openFile}>
    <OpenFileIdContext.Provider value={surface.open ? file?.id ?? null : null}>
    <div className="flex h-full min-h-0 min-w-0 flex-1" data-workbot-browser-layout>
      {/* Beside a panel the chat keeps a readable column (about 600px on a large screen); the panel takes the rest. */}
      <div className={`min-h-0 min-w-0 ${wide && panelOpen ? `${expanded ? "hidden" : ""} w-[clamp(400px,33vw,600px)] shrink-0` : "flex-1"}`}>{children}</div>
      {wide && panelOpen ? <aside
        className={`workbot ${file ? "workbot-panel-enter" : ""} flex min-h-0 min-w-0 flex-1 flex-col border-l border-[var(--wb-hairline)] bg-[var(--wb-bg)]`}
        aria-label={label}
        {...(task ? { "data-workbot-browser-panel": "" } : { "data-workbot-artifact-panel": "" })}
      >{viewer}</aside> : null}
    </div>
    {!wide ? <Dialog.Root open={surface.open && opened !== null} onOpenChange={next => { if (!next) close(); }}>
      <Dialog.Portal {...surface.portal}>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-[var(--wb-ink)]/40" />
        <Dialog.Popup
          className={`workbot ${task ? "workbot-browser-sheet" : "workbot-panel-enter"} fixed inset-0 z-50 flex flex-col overflow-hidden bg-[var(--wb-bg)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] outline-none`}
          {...(task ? { "data-workbot-browser-sheet": "" } : { "data-workbot-artifact-sheet": "" })}
        >
          <Dialog.Title className="sr-only">{task?.title ?? label}</Dialog.Title>
          {viewer}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root> : null}
    </OpenFileIdContext.Provider>
    </OpenFileContext.Provider>
  </BrowserPreviewContext.Provider>;
}
