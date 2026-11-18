"use client";

import { createContext } from "react";
import type { WorkbotAttachment } from "./data";

/** Opens a file in the panel beside the conversation (a sheet on a phone); the screen provides it. */
export const OpenFileContext = createContext<(file: WorkbotAttachment) => void>(() => undefined);

/** Which file that panel shows, so its card in the conversation can say so; null while none is open. */
export const OpenFileIdContext = createContext<string | null>(null);
