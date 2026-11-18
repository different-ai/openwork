"use client";

import { createContext, useContext } from "react";
import type { WorkbotViewContext } from "@openwork/types/workbot-context";
import type { BrowserTask } from "./computer-work";
import type { WorkbotAttachment } from "./data";

/**
 * The panel beside the chat, as the conversation reaches it (BrowserExperience provides it). Kept apart from the
 * panel itself so a card or the status line can open it without loading the viewers it holds.
 */

/** The transcript owns the task; opening its view never starts or resumes a task. */
export type BrowserPreviewTask = BrowserTask & { id: string };
/** Which of Workbot's screens a task card opened: its browser, or the rest of its computer. */
export type ScreenView = "browser" | "computer";
export const BrowserPreviewContext = createContext<{
  /** Opens a task's live view beside the chat: the browser by default, or the computer's screen. */
  open(task: BrowserPreviewTask, view?: ScreenView): void;
  update(task: BrowserPreviewTask): void;
  /** A task's live view (browser or computer) is open, beside the chat or as the phone sheet. */
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
