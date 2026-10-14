import { browserScript } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { evalIn } from "./desktop.ts";

export interface DocumentState {
  timeOrigin: number;
  readyState: "loading" | "interactive" | "complete";
  complete: boolean;
  sameOrigin: boolean;
  sameUrl: boolean;
  /** A fragment destination in the current document need not create a new epoch. */
  sameDocumentFragment: boolean;
}

export interface WorkspaceReadiness {
  connected: boolean;
  notLoading: boolean;
  connectionReady: boolean;
  noRouteError: boolean;
  expectedWorkspaceSelected: boolean;
  workspaceLoaded: boolean;
  noWorkspaceError: boolean;
}

/**
 * Fixed, read-only navigation facts. Compare URLs inside the browser: the current
 * URL can contain OAuth code/state, so neither it nor its components leave it.
 */
export async function readDocumentState(surface: Surface, targetUrl: string): Promise<DocumentState> {
  let destination: URL;
  try {
    destination = new URL(targetUrl);
  } catch {
    throw new Error("Document state requires an absolute HTTP(S) target URL.");
  }
  if (!["http:", "https:"].includes(destination.protocol) || destination.username || destination.password) {
    throw new Error("Document state requires an absolute HTTP(S) target URL without credentials.");
  }
  const value = await evalIn(surface, browserScript((targetUrl) => {
    const target = new URL(targetUrl);
    const current = new URL(location.href);
    return {
      timeOrigin: performance.timeOrigin,
      readyState: document.readyState,
      complete: document.readyState === "complete",
      sameOrigin: current.origin === target.origin,
      sameUrl: current.href === target.href,
      // An explicit empty fragment (#) is also a fragment navigation.
      sameDocumentFragment: target.href.includes("#") && current.href.split("#", 1)[0] === target.href.split("#", 1)[0],
    };
  }, [destination.href]));
  if (!value || typeof value.timeOrigin !== "number" || !Number.isFinite(value.timeOrigin) || value.timeOrigin <= 0
    || !["loading", "interactive", "complete"].includes(value.readyState)
    || typeof value.complete !== "boolean" || typeof value.sameOrigin !== "boolean"
    || typeof value.sameUrl !== "boolean" || typeof value.sameDocumentFragment !== "boolean") {
    throw new Error("The browser returned invalid document readiness facts.");
  }
  return {
    timeOrigin: value.timeOrigin,
    readyState: value.readyState,
    complete: value.complete,
    sameOrigin: value.sameOrigin,
    sameUrl: value.sameUrl,
    sameDocumentFragment: value.sameDocumentFragment,
  };
}

/** Observe the product's public route inspector, never React internals or app writes. */
export async function readWorkspaceReadiness(surface: Surface, workspaceId: string): Promise<WorkspaceReadiness> {
  if (!workspaceId.trim()) throw new Error("Workspace readiness requires a workspace ID.");
  const value = await evalIn(surface, browserScript((workspaceId) => {
    const state = window.__openwork?.slice?.("route");
    const workspace = state?.workspaces?.find(item => item.id === workspaceId);
    return {
      connected: Boolean(state && "connected" in state && state.connected === true),
      notLoading: Boolean(state && "loading" in state && state.loading === false),
      connectionReady: Boolean(state && "connectionPending" in state && state.connectionPending === false),
      noRouteError: Boolean(state && "routeError" in state && state.routeError === null),
      expectedWorkspaceSelected: state?.selectedWorkspaceId === workspaceId,
      workspaceLoaded: workspace?.loading === false,
      noWorkspaceError: workspace?.error === null,
    };
  }, [workspaceId]));
  if (!value || typeof value.connected !== "boolean" || typeof value.notLoading !== "boolean"
    || typeof value.connectionReady !== "boolean" || typeof value.noRouteError !== "boolean"
    || typeof value.expectedWorkspaceSelected !== "boolean" || typeof value.workspaceLoaded !== "boolean"
    || typeof value.noWorkspaceError !== "boolean") {
    throw new Error("The public route inspector returned invalid workspace readiness facts.");
  }
  return {
    connected: value.connected,
    notLoading: value.notLoading,
    connectionReady: value.connectionReady,
    noRouteError: value.noRouteError,
    expectedWorkspaceSelected: value.expectedWorkspaceSelected,
    workspaceLoaded: value.workspaceLoaded,
    noWorkspaceError: value.noWorkspaceError,
  };
}
