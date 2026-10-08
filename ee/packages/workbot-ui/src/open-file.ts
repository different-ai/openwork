"use client";

import { createContext } from "react";
import type { WorkbotAttachment } from "./data";

/** Opens a file in the preview panel beside the conversation; the screen provides it. */
export const OpenFileContext = createContext<(file: WorkbotAttachment) => void>(() => undefined);
