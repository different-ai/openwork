"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { connectorAccountReady } from "./connector-detail";
import { libraryQueryKeys } from "./library-data";
import { resolveMcpAuthorizationPollOutcome } from "./mcp-account-authorization-state";
import { openMcpAuthorizationTab, safeMcpAuthorizationUrl, showMcpAuthorizationFailure } from "./mcp-authorization-url";
import {
  type ExternalMcpConnection,
  type ExternalMcpTool,
  type McpRequirementsDiscovery,
  McpOAuthStartError,
  mcpConnectionQueryKeys,
  useCreateMcpConnection,
  useDeleteMcpConnection,
  useDiscoverMcpConnectionRequirements,
  useMcpConnections,
  useMcpConnectionTools,
  useStartMcpConnectionOAuth,
} from "./mcp-connections-data";
import type { SetupCheck } from "./setup-checks";

export type ConnectorTarget = {
  name: string;
  url: string;
  description: string;
};

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

/** "send_message" reads as "Send message". */
export function toolTitle(tool: Pick<ExternalMcpTool, "name" | "title" | "annotations">): string {
  const raw = tool.title ?? tool.annotations?.title ?? tool.name.replace(/[_-]+/g, " ");
  const words = raw.trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : tool.name;
}

/** One sentence from a tool description, without markdown or trailing detail. */
export function toolSummary(tool: Pick<ExternalMcpTool, "description">): string {
  const text = (tool.description ?? "").replace(/[`*_#>]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentence = text.match(/^.*?[.!?](\s|$)/)?.[0]?.trim() ?? text;
  return sentence.length > 90 ? `${sentence.slice(0, 87).trimEnd()}...` : sentence;
}

export function toolsSentence(tools: readonly Pick<ExternalMcpTool, "name" | "title" | "annotations">[]): string {
  if (tools.length === 0) return "Nothing to do yet.";
  const examples = tools.slice(0, 2).map((tool) => toolTitle(tool).toLowerCase());
  const count = tools.length === 1 ? "1 thing" : `${tools.length} things`;
  return `${count}, like ${examples.join(" and ")}.`;
}

type SignInState =
  | { kind: "idle" }
  | { kind: "waiting" }
  | { kind: "failed"; message: string };

/**
 * Runs the four setup checks for one connector: OpenWork finds the server,
 * learns how people sign in, signs the viewer in, and reads what the AI can do.
 * The connection is created at sign-in, for the viewer only.
 */
export function useConnectorSetup({ target, initialConnectionId, onConnectionCreated }: {
  target: ConnectorTarget | null;
  initialConnectionId: string | null;
  onConnectionCreated?: (connectionId: string) => void;
}) {
  const queryClient = useQueryClient();
  const { orgContext } = useOrgDashboard();
  const discover = useDiscoverMcpConnectionRequirements();
  const createConnection = useCreateMcpConnection();
  const deleteConnection = useDeleteMcpConnection();
  const startOAuth = useStartMcpConnectionOAuth();
  const usable = useMcpConnections("usable");
  const [discovery, setDiscovery] = useState<McpRequirementsDiscovery | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(initialConnectionId);
  const [createdHere, setCreatedHere] = useState(false);
  const [signIn, setSignIn] = useState<SignInState>({ kind: "idle" });
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const discoveredUrl = useRef<string | null>(null);
  const autoCreated = useRef(false);

  const connection: ExternalMcpConnection | null = usable.data?.find((entry) => entry.id === connectionId) ?? null;
  const authKind = discovery?.authentication.kind ?? null;
  const signedIn = Boolean(connection && (connection.authType === "none" || connectorAccountReady(connection)));
  const tools = useMcpConnectionTools(connectionId ?? "", signedIn);

  useEffect(() => {
    if (!target || discoveredUrl.current === target.url) return;
    discoveredUrl.current = target.url;
    setDiscovery(null);
    setDiscoveryError(null);
    discover.mutateAsync(target.url)
      .then((result) => setDiscovery(result))
      .catch((error: unknown) => setDiscoveryError(error instanceof Error ? error.message : "OpenWork could not reach it."));
  }, [discover, target]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const createForMe = useCallback(async (authType: "oauth" | "none") => {
    if (!target || !orgContext) throw new Error("Your organization is still loading. Try again in a moment.");
    const created = await createConnection.mutateAsync({
      name: target.name,
      url: target.url,
      authType,
      credentialMode: authType === "oauth" ? "per_member" : "shared",
      access: { orgWide: false, memberIds: [orgContext.currentMember.id], teamIds: [] },
    });
    setConnectionId(created.id);
    setCreatedHere(true);
    onConnectionCreated?.(created.id);
    await Promise.all([
      usable.refetch(),
      queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items }),
    ]);
    return created.id;
  }, [createConnection, onConnectionCreated, orgContext, queryClient, target, usable]);

  useEffect(() => {
    if (authKind !== "none" || connectionId || autoCreated.current) return;
    autoCreated.current = true;
    createForMe("none").catch((error: unknown) => setSignIn({ kind: "failed", message: error instanceof Error ? error.message : "Could not add it." }));
  }, [authKind, connectionId, createForMe]);

  const startSignIn = useCallback(async () => {
    if (!target) return;
    stopPolling();
    setSignIn({ kind: "waiting" });
    let tab: Window | null = null;
    let id = connectionId;
    try {
      tab = openMcpAuthorizationTab({ connectionId: id ?? "", connectionName: target.name });
      id = id ?? await createForMe("oauth");
      const result = await startOAuth.mutateAsync(id);
      if (result.status === "connected") {
        tab.close();
        await usable.refetch();
        return;
      }
      if (!result.authorizeUrl) throw new Error(`${target.name} did not send a sign-in page.`);
      tab.location.href = safeMcpAuthorizationUrl(result.authorizeUrl);
      const openedTab = tab;
      const pollId = id;
      const startedAt = Date.now();
      let fetching = false;
      pollTimer.current = setInterval(async () => {
        if (fetching) return;
        fetching = true;
        const refreshed = await usable.refetch();
        fetching = false;
        const current = refreshed.data?.find((entry) => entry.id === pollId);
        const outcome = resolveMcpAuthorizationPollOutcome({
          connected: Boolean(current && connectorAccountReady(current)),
          authorizationWindowClosed: openedTab.closed,
          elapsedMs: Date.now() - startedAt,
          timeoutMs: POLL_TIMEOUT_MS,
        });
        if (outcome === "pending") return;
        stopPolling();
        if (outcome === "connected") {
          setSignIn({ kind: "idle" });
          void queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items });
        } else {
          setSignIn({ kind: "failed", message: "Sign-in did not finish. Try again." });
        }
      }, POLL_INTERVAL_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sign-in did not start.";
      showMcpAuthorizationFailure(tab, {
        connectionId: id ?? "",
        connectionName: target.name,
        message,
        ...(error instanceof McpOAuthStartError ? { details: error.details } : {}),
      });
      setSignIn({ kind: "failed", message });
    }
  }, [connectionId, createForMe, queryClient, startOAuth, stopPolling, target, usable]);

  /** Cancel removes a connection this flow created and never finished. */
  const discard = useCallback(async () => {
    stopPolling();
    if (connectionId && createdHere) {
      await deleteConnection.mutateAsync(connectionId).catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items });
    }
  }, [connectionId, createdHere, deleteConnection, queryClient, stopPolling]);

  const name = target?.name ?? "it";
  const findDone = discovery !== null && discovery.status !== "unreachable" && discovery.status !== "unsupported";
  const findFailed = discoveryError !== null || (discovery !== null && !findDone);
  const authKnown = findDone && (authKind === "oauth" || authKind === "none");
  const authFailed = findDone && !authKnown;
  const toolList = tools.data?.tools ?? [];

  const checks: SetupCheck[] = [
    {
      id: "find",
      title: `Finds ${name}`,
      description: findFailed ? `OpenWork could not reach ${name}. Check the address and try again.` : findDone ? `${name} answered.` : "Looking for it now.",
      status: findFailed ? "failed" : findDone ? "done" : "running",
    },
    {
      id: "sign-in-method",
      title: "Knows how you sign in",
      description: authFailed
        ? authKind === "manual_bearer" ? `${name} needs a key. Ask an admin to add it.` : `OpenWork could not tell how to sign in to ${name}.`
        : authKnown
          ? authKind === "none" ? "No sign-in needed." : `You sign in with your own ${name} account.`
          : "Waits for the first check.",
      status: authFailed ? "failed" : authKnown ? "done" : findDone ? "running" : "waiting",
    },
    {
      id: "sign-in",
      title: signedIn ? `Signed in to ${name}` : `Sign in to ${name}`,
      description: signedIn
        ? authKind === "none" || connection?.authType === "none"
          ? "Nothing to sign in to."
          : connection?.externalAccountId ? `As ${connection.externalAccountId}.` : "You are signed in."
        : signIn.kind === "failed"
          ? signIn.message
          : signIn.kind === "waiting"
            ? `${name} opened in a new tab. Come back here when you are done.`
            : authKnown ? `${name} opens in a new tab. Come back here when you are done.` : "Waits for the checks above.",
      status: signedIn ? "done" : signIn.kind === "failed" ? "failed" : signIn.kind === "waiting" ? "running" : authKnown && authKind === "oauth" ? "current" : authKnown ? "running" : "waiting",
    },
    {
      id: "tools",
      title: "Has things your AI can do",
      description: tools.error
        ? "OpenWork could not read what it can do. Try again later."
        : tools.data ? toolsSentence(toolList) : signedIn ? "Reading them now." : "They show up after you sign in.",
      status: tools.error ? "failed" : tools.data ? "done" : signedIn ? "running" : "waiting",
    },
  ];

  const doneCount = checks.filter((check) => check.status === "done").length;
  const stepNumber = Math.min(checks.findIndex((check) => check.status !== "done") + 1 || checks.length, checks.length);

  return {
    checks,
    allDone: doneCount === checks.length,
    stepNumber,
    connection,
    connectionId,
    tools: toolList,
    canSignIn: authKnown && authKind === "oauth" && !signedIn && signIn.kind !== "waiting",
    signingIn: signIn.kind === "waiting",
    startSignIn,
    discard,
  };
}

/** Signs the viewer in to a connector someone gave them, from a list row or its page. */
export function useMemberSignIn() {
  const queryClient = useQueryClient();
  const startOAuth = useStartMcpConnectionOAuth();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: libraryQueryKeys.items }),
    queryClient.invalidateQueries({ queryKey: mcpConnectionQueryKeys.all }),
  ]);

  async function signIn(item: { id: string; name: string }) {
    if (timer.current) clearInterval(timer.current);
    setPendingId(item.id);
    let tab: Window | null = null;
    try {
      tab = openMcpAuthorizationTab({ connectionId: item.id, connectionName: item.name });
      const result = await startOAuth.mutateAsync(item.id);
      if (result.status === "connected" || !result.authorizeUrl) {
        tab.close();
        setPendingId(null);
        await refresh();
        return;
      }
      tab.location.href = safeMcpAuthorizationUrl(result.authorizeUrl);
      const openedTab = tab;
      const startedAt = Date.now();
      timer.current = setInterval(() => {
        void refresh();
        if (openedTab.closed || Date.now() - startedAt > 90_000) {
          if (timer.current) clearInterval(timer.current);
          setPendingId(null);
        }
      }, 1500);
    } catch {
      tab?.close();
      setPendingId(null);
    }
  }

  return { signIn, pendingId };
}
