import type { ReloadReason, ReloadTrigger } from "../types";
import { createOpenworkServerStore } from "../connections/openwork-server-store";
import { createSessionStore } from "../context/session";
import { createWorkspaceStore } from "../context/workspace";

type SessionStore = ReturnType<typeof createSessionStore>;
type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
type OpenworkServerStore = ReturnType<typeof createOpenworkServerStore>;

type ReloadHandler = (reason: ReloadReason, trigger?: ReloadTrigger) => void;

export function createBootstrapCoordinator() {
  let workspaceStore: WorkspaceStore | undefined;
  let sessionStore: SessionStore | undefined;
  let openworkServerStore: OpenworkServerStore | undefined;
  let reloadHandler: ReloadHandler | undefined;

  return {
    peekWorkspaceStore() {
      return workspaceStore ?? null;
    },
    peekSessionStore() {
      return sessionStore ?? null;
    },
    peekOpenworkServerStore() {
      return openworkServerStore ?? null;
    },
    get workspaceStore() {
      if (!workspaceStore) {
        throw new Error("Workspace store accessed before bootstrap completed");
      }
      return workspaceStore;
    },
    get sessionStore() {
      if (!sessionStore) {
        throw new Error("Session store accessed before bootstrap completed");
      }
      return sessionStore;
    },
    get openworkServerStore() {
      if (!openworkServerStore) {
        throw new Error("OpenWork server store accessed before bootstrap completed");
      }
      return openworkServerStore;
    },
    setWorkspaceStore(value: WorkspaceStore) {
      workspaceStore = value;
      return value;
    },
    setSessionStore(value: SessionStore) {
      sessionStore = value;
      return value;
    },
    setOpenworkServerStore(value: OpenworkServerStore) {
      openworkServerStore = value;
      return value;
    },
    setReloadHandler(value: ReloadHandler) {
      reloadHandler = value;
    },
    markReloadRequired(reason: ReloadReason, trigger?: ReloadTrigger) {
      reloadHandler?.(reason, trigger);
    },
  };
}
