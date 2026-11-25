"use client";

import { createContext, useContext } from "react";
import type { WorkbotViewContext } from "@openwork/types/workbot-context";
import type { BrowserTask } from "./computer-work";
import type { WorkbotAttachment } from "./data";

/** The transcript owns the task; opening its view never starts or resumes a task. */
export type BrowserPreviewTask = BrowserTask & { id: string };
/** Which of Workbot's screens a task card opened: its browser, or the rest of its computer. */
export type ScreenView = "browser" | "computer";
export const BrowserPreviewContext = createContext<{
  open(task: BrowserPreviewTask, view?: ScreenView): void;
  update(task: BrowserPreviewTask): void;
  visible: boolean;
  panelOpen: boolean;
  file: WorkbotAttachment | null;
  updateFile(file: WorkbotAttachment): void;
  context: WorkbotViewContext | null;
  includeContext: boolean;
  setIncludeContext(include: boolean): void;
} | null>(null);
export const useBrowserPreview = () => useContext(BrowserPreviewContext);
