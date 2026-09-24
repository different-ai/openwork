"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { connectorAccountReady } from "./connector-detail";
import { type ConnectorSignInMethod, connectorSignInMethod, oauthClientSecretRequired, oauthRequestFields } from "./connector-sign-in-method";
import { libraryQueryKeys } from "./library-data";
import { resolveMcpAuthorizationPollOutcome } from "./mcp-account-authorization-state";
import { openMcpAuthorizationTab, safeMcpAuthorizationUrl, showMcpAuthorizationFailure } from "./mcp-authorization-url";
import {
  type CreateMcpConnectionInput,
  type ExternalMcpConnection,
  type ExternalMcpPreset,
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
  /** The catalog preset's own sign-in requirement, when the target came from the catalog. */
  preset?: Pick<ExternalMcpPreset, "authType" | "requiresOAuthClient" | "defaultOAuthClientId"> | null;
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

export type ConnectorSetupMode = "admin" | "member";

/** The fields step two needs from an admin before anyone can sign in. */
export type OAuthAppInput = { clientId: string; clientSecret: string };

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * Runs the four setup checks for one connector: OpenWork finds the server,
 * learns how people sign in, signs the viewer in, and reads what the AI can do.
 * The connection is created for the viewer only: at sign-in, when an admin
 * saves the key or OAuth app step two asks for, or right away when there is
 * nothing to sign in to.
 */
export function useConnectorSetup({ target, initialConnectionId, onConnectionCreated, mode = "member" }: {
  target: ConnectorTarget | null;
  initialConnectionId: string | null;
  onConnectionCreated?: (connectionId: string) => void;
  mode?: ConnectorSetupMode;
}) {
  const queryClient = useQueryClient();
  const { orgId, orgContext } = useOrgDashboard();
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
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const discoveredUrl = useRef<string | null>(null);
  const autoCreated = useRef(false);

  const connection: ExternalMcpConnection | null = usable.data?.find((entry) => entry.id === connectionId) ?? null;
  const findDone = discovery !== null && discovery.status !== "unreachable" && discovery.status !== "unsupported";
  const method: ConnectorSignInMethod | null = findDone && discovery ? connectorSignInMethod(discovery, target?.preset) : null;
  const signedIn = Boolean(connection && (connection.authType === "none" || connectorAccountReady(connection)));
  const tools = useMcpConnectionTools(connectionId ?? "", signedIn);

  useEffect(() => {
    // A deep link can resolve the catalog entry before the organization loads.
    if (!target || !orgId || discoveredUrl.current === target.url) return;
    discoveredUrl.current = target.url;
    setDiscovery(null);
    setDiscoveryError(null);
    discover.mutateAsync(target.url)
      .then((result) => setDiscovery(result))
      .catch((error: unknown) => setDiscoveryError(errorMessage(error, "OpenWork could not reach it.")));
  }, [discover, orgId, target]);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current);
    pollTimer.current = null;
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const createForMe = useCallback(async (auth: Pick<CreateMcpConnectionInput, "authType" | "apiKey" | "oauthClient">) => {
    if (!target || !orgContext) throw new Error("Your organization is still loading. Try again in a moment.");
    const created = await createConnection.mutateAsync({
      name: target.name,
      url: target.url,
      authType: auth.authType,
      credentialMode: auth.authType === "oauth" ? "per_member" : "shared",
      ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
      ...(auth.oauthClient ? { oauthClient: auth.oauthClient } : {}),
      ...(auth.authType === "oauth" ? oauthRequestFields(discovery) : {}),
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
  }, [createConnection, discovery, onConnectionCreated, orgContext, queryClient, target, usable]);

  useEffect(() => {
    if (method !== "none" || connectionId || autoCreated.current) return;
    autoCreated.current = true;
    createForMe({ authType: "none" }).catch((error: unknown) => setSignIn({ kind: "failed", message: errorMessage(error, "Could not add it.") }));
  }, [method, connectionId, createForMe]);

  /** Step two for a server that takes a key: the admin's key is shared by everyone who gets it. */
  const saveApiKey = useCallback(async (apiKey: string) => {
    const key = apiKey.trim();
    if (!key) {
      setSaveError("Paste the key first.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await createForMe({ authType: "apikey", apiKey: key });
    } catch (error) {
      setSaveError(errorMessage(error, "The key did not save."));
    } finally {
      setSaving(false);
    }
  }, [createForMe]);

  /** Step two for a server that only accepts a pre-registered OAuth app; sign-in follows. */
  const saveOAuthApp = useCallback(async (input: OAuthAppInput) => {
    const clientId = input.clientId.trim();
    const clientSecret = input.clientSecret.trim();
    if (!clientId) {
      setSaveError("Paste the client ID first.");
      return;
    }
    if (!clientSecret && oauthClientSecretRequired(discovery)) {
      setSaveError(`${target?.name ?? "This server"} needs the client secret too.`);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await createForMe({ authType: "oauth", oauthClient: { clientId, ...(clientSecret ? { clientSecret } : {}) } });
    } catch (error) {
      setSaveError(errorMessage(error, "The OAuth app did not save."));
    } finally {
      setSaving(false);
    }
  }, [createForMe, discovery, target?.name]);

  const startSignIn = useCallback(async () => {
    if (!target) return;
    stopPolling();
    setSignIn({ kind: "waiting" });
    let tab: Window | null = null;
    let id = connectionId;
    try {
      tab = openMcpAuthorizationTab({ connectionId: id ?? "", connectionName: target.name });
      id = id ?? await createForMe({ authType: "oauth" });
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
      const message = errorMessage(error, "Sign-in did not start.");
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
  const findFailed = discoveryError !== null || (discovery !== null && !findDone);
  const needsAdminInput = method === "api_key" || method === "oauth_app";
  const adminInputSaved = needsAdminInput && connection !== null;
  const blocked = needsAdminInput && mode === "member" && !connection;
  const methodFailed = method === "unsupported";
  const methodDone = method === "none" || method === "sign_in" || adminInputSaved;
  const usesKey = method === "api_key" || connection?.authType === "apikey";
  const canSignIn = !signedIn && signIn.kind !== "waiting" && (method === "sign_in" || (method === "oauth_app" && connection !== null));
  const toolList = tools.data?.tools ?? [];

  const methodDescription = (() => {
    if (methodFailed) return `OpenWork could not tell how to sign in to ${name}.`;
    if (method === "none") return "No sign-in needed.";
    if (method === "sign_in") return `You sign in with your own ${name} account.`;
    if (method === "api_key") {
      if (adminInputSaved) return "Key added. Everyone uses it.";
      return mode === "member" ? `An admin adds the key for ${name}.` : `${name} needs a key.`;
    }
    if (method === "oauth_app") {
      if (adminInputSaved) return "OAuth app added.";
      return mode === "member" ? `An admin adds the OAuth app for ${name}.` : `${name} needs your OAuth app.`;
    }
    return findDone ? "Checking now." : "Waits for the first check.";
  })();

  const signInDescription = (() => {
    if (signedIn) {
      if (connection?.authType === "none") return "Nothing to sign in to.";
      if (connection?.authType === "apikey") return "Uses the key you added.";
      return connection?.externalAccountId ? `As ${connection.externalAccountId}.` : "You are signed in.";
    }
    if (signIn.kind === "failed") return signIn.message;
    if (signIn.kind === "waiting") return `${name} opened in a new tab. Come back here when you are done.`;
    if (canSignIn) return `${name} opens in a new tab. Come back here when you are done.`;
    if (usesKey && connection) return "Checking the key.";
    return "Waits for the checks above.";
  })();

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
      description: methodDescription,
      status: methodFailed ? "failed" : methodDone ? "done" : blocked ? "blocked" : needsAdminInput ? "current" : findDone ? "running" : "waiting",
    },
    {
      id: "sign-in",
      title: signedIn
        ? usesKey ? `Connected to ${name}` : `Signed in to ${name}`
        : usesKey ? `Connect to ${name}` : `Sign in to ${name}`,
      description: signInDescription,
      status: signedIn
        ? "done"
        : signIn.kind === "failed" ? "failed"
          : signIn.kind === "waiting" || (usesKey && connection) || (method === "none" && !connection) ? "running"
            : canSignIn ? "current" : "waiting",
    },
    {
      id: "tools",
      title: "Has things your AI can do",
      description: tools.error
        ? "OpenWork could not read what it can do. Try again later."
        : tools.data ? toolsSentence(toolList) : signedIn ? "Reading them now." : usesKey ? "They show up once the key works." : "They show up after you sign in.",
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
    method,
    /** Step two is waiting on a key or OAuth app from this viewer. */
    needsInput: needsAdminInput && mode === "admin" && !connection,
    secretRequired: oauthClientSecretRequired(discovery),
    saving,
    saveError,
    saveApiKey,
    saveOAuthApp,
    canSignIn,
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
  const [failure, setFailure] = useState<{ id: string; message: string } | null>(null);
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
    setFailure(null);
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
    } catch (error) {
      const message = errorMessage(error, "Sign-in did not start.");
      showMcpAuthorizationFailure(tab, {
        connectionId: item.id,
        connectionName: item.name,
        message,
        ...(error instanceof McpOAuthStartError ? { details: error.details } : {}),
      });
      setFailure({ id: item.id, message });
      setPendingId(null);
    }
  }

  return { signIn, pendingId, failure };
}
