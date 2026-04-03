/// <reference types="vite/client" />

import type { LogEntry, Snapshot } from "./types";

declare global {
  interface Window {
    openwork: {
      getSnapshot: () => Promise<Snapshot>;
      createWorkspace: () => Promise<Snapshot>;
      connectRemote: (url: string, token: string) => Promise<Snapshot>;
      createSession: () => Promise<Snapshot>;
      selectSession: (sessionID: string) => Promise<Snapshot>;
      sendPrompt: (sessionID: string, prompt: string) => Promise<Snapshot>;
      abortSession: (sessionID: string) => Promise<Snapshot>;
      getLogs: () => Promise<LogEntry[]>;
      sendRendererLog: (level: string, message: string) => void;
      onState: (listener: (state: Snapshot) => void) => () => void;
      onLog: (listener: (entry: LogEntry) => void) => () => void;
    };
  }
}

export {};
