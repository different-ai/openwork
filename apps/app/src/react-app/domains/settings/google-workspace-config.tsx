/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { CalendarDays, CheckCircle2, FileText, Loader2, MailPlus, ShieldCheck, XCircle } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { GoogleWorkspaceAuthStatus, OpenworkServerClient } from "../../../app/lib/openwork-server";
import { usePlatform } from "../../kernel/platform";
import type { ExtensionConfigContext } from "./extension-registry";
import { registerExtensionRuntime } from "./extension-registry";

type BusyAction = "status" | "connect" | "disconnect" | "test" | "smoke-test";
type GoogleWorkspaceCommand = () => Promise<unknown>;
const DESKTOP_ACTION_TIMEOUT_MS = 6 * 60 * 1000;
const CONNECT_POLL_INTERVAL_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeGoogleWorkspaceAccount(value: unknown): GoogleWorkspaceAuthStatus["account"] {
  if (!isRecord(value)) return null;
  return {
    email: typeof value.email === "string" ? value.email : null,
    name: typeof value.name === "string" ? value.name : null,
    picture: typeof value.picture === "string" ? value.picture : null,
    sub: typeof value.sub === "string" ? value.sub : null,
  };
}

function normalizeGoogleWorkspaceSmokeTest(value: unknown): GoogleWorkspaceAuthStatus["smokeTest"] {
  if (!isRecord(value)) return null;
  return {
    driveFileId: typeof value.driveFileId === "string" ? value.driveFileId : null,
    driveFileName: typeof value.driveFileName === "string" ? value.driveFileName : null,
    gmailDraftId: typeof value.gmailDraftId === "string" ? value.gmailDraftId : null,
  };
}

function normalizeGoogleWorkspaceAuthStatus(value: unknown): GoogleWorkspaceAuthStatus {
  const record = isRecord(value) ? value : {};
  const vault = record.vault === "encrypted" || record.vault === "plaintext-dev" ? record.vault : "unavailable";
  return {
    configured: record.configured === true,
    missing: normalizeStringList(record.missing),
    vault,
    connected: record.connected === true,
    account: normalizeGoogleWorkspaceAccount(record.account),
    scopes: normalizeStringList(record.scopes),
    connectedAt: typeof record.connectedAt === "string" ? record.connectedAt : null,
    error: typeof record.error === "string" ? record.error : null,
    testStatus: typeof record.testStatus === "string" ? record.testStatus : null,
    smokeTest: normalizeGoogleWorkspaceSmokeTest(record.smokeTest),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForGoogleWorkspaceConnection(client: OpenworkServerClient, flowId: string, expiresAt: number) {
  while (Date.now() < expiresAt + 5_000) {
    const result = await client.googleWorkspaceConnectStatus(flowId);
    if (result.status === "connected" && result.googleWorkspace) return result.googleWorkspace;
    if (result.status === "failed" || result.status === "expired") {
      throw new Error(result.error ?? "Google Workspace connection did not complete.");
    }
    await sleep(CONNECT_POLL_INTERVAL_MS);
  }
  throw new Error("Google Workspace OAuth timed out.");
}

function GoogleWorkspaceConfig({ openworkServerClient, onExtensionConnectionChange }: ExtensionConfigContext) {
  const platform = usePlatform();
  const [status, setStatus] = useState<GoogleWorkspaceAuthStatus | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const serverAvailable = Boolean(openworkServerClient);
  const canConnect = serverAvailable && status?.configured === true && status.vault !== "unavailable";
  const canTest = serverAvailable && status?.connected === true;

  const loadStatus = async (options: { clearError?: boolean } = {}) => {
    if (!openworkServerClient) return;
    setBusyAction("status");
    if (options.clearError !== false) setError(null);
    try {
      const result = normalizeGoogleWorkspaceAuthStatus(await openworkServerClient.googleWorkspaceStatus());
      setStatus(result);
      onExtensionConnectionChange?.("google-workspace", result.connected);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read Google Workspace status.");
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, [openworkServerClient]);

  const runDesktopAction = async (action: Exclude<BusyAction, "status">, command: GoogleWorkspaceCommand) => {
    if (!openworkServerClient) return;
    setBusyAction(action);
    setError(null);
    try {
      const result = await Promise.race([
        command(),
        new Promise<never>((_, reject) => {
          window.setTimeout(() => reject(new Error("Google Workspace connection is taking too long. Try again, or restart OpenWork if the browser already said authorization was received.")), DESKTOP_ACTION_TIMEOUT_MS);
        }),
      ]);
      const next = normalizeGoogleWorkspaceAuthStatus(result);
      setStatus(next);
      onExtensionConnectionChange?.("google-workspace", next.connected);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Google Workspace ${action} failed.`);
      await loadStatus({ clearError: false });
    } finally {
      setBusyAction(null);
    }
  };

  const connectGoogleWorkspace = async () => {
    if (!openworkServerClient) return null;
    const flow = await openworkServerClient.googleWorkspaceConnectStart();
    platform.openLink(flow.authUrl);
    return waitForGoogleWorkspaceConnection(openworkServerClient, flow.flowId, flow.expiresAt);
  };

  return (
    <div className="space-y-4">
      {!serverAvailable ? (
        <Alert variant="warning">
          <ShieldCheck />
          <AlertTitle>OpenWork server required</AlertTitle>
          <AlertDescription>Start OpenWork server to connect Google Workspace.</AlertDescription>
        </Alert>
      ) : null}

      {status?.connected ? (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Connected to Google Workspace</AlertTitle>
          <AlertDescription>
            {status.account?.email ? `Signed in as ${status.account.email}.` : "Your Google account is connected."}
            {status.testStatus ? ` ${status.testStatus}` : ""}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="warning">
          <ShieldCheck />
          <AlertTitle>Connect Google Workspace</AlertTitle>
          <AlertDescription>
            Let OpenWork use your calendar, selected Drive files, and Gmail drafts when you ask it to.
          </AlertDescription>
        </Alert>
      )}

      {status && !status.configured ? (
        <Alert variant="warning">
          <XCircle />
          <AlertTitle>Google OAuth client not configured</AlertTitle>
          <AlertDescription>Google Workspace is not configured in this build.</AlertDescription>
        </Alert>
      ) : null}

      {status?.vault === "unavailable" ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Encrypted token vault unavailable</AlertTitle>
          <AlertDescription>OpenWork cannot securely save your Google connection on this machine right now.</AlertDescription>
        </Alert>
      ) : null}

      {error || status?.error ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Google Workspace error</AlertTitle>
          <AlertDescription>{error ?? status?.error}</AlertDescription>
        </Alert>
      ) : null}

      {status?.smokeTest ? (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Scope smoke test complete</AlertTitle>
          <AlertDescription>Calendar, Drive, and Gmail draft access were verified.</AlertDescription>
        </Alert>
      ) : null}

      <Card variant="outline" size="sm">
        <CardHeader>
          <CardTitle>What OpenWork can do</CardTitle>
          <CardDescription>
            Connect Google Workspace so OpenWork can help with meeting prep, selected files, and draft emails.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-border bg-card p-3">
            <CalendarDays className="mb-2 size-4 text-blue-11" />
            <div className="text-sm font-medium text-card-foreground">Calendar read</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">List upcoming events and provide meeting context.</div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-3">
            <MailPlus className="mb-2 size-4 text-red-11" />
            <div className="text-sm font-medium text-card-foreground">Gmail drafts</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">Create draft emails only. No send tool in Phase 1.</div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-3">
            <FileText className="mb-2 size-4 text-green-11" />
            <div className="text-sm font-medium text-card-foreground">Selected Drive files</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">Read files explicitly selected or created through OpenWork.</div>
          </div>
        </CardContent>
      </Card>

      <Card variant="outline" size="sm">
        <CardFooter className="flex-wrap gap-2 justify-between">
          <div className="flex flex-wrap gap-2">
            {status?.connected ? (
              <Button variant="destructive" disabled={Boolean(busyAction)} onClick={() => void runDesktopAction("disconnect", () => openworkServerClient?.googleWorkspaceDisconnect() ?? Promise.resolve(null))}>
                {busyAction === "disconnect" ? <Loader2 className="size-4 animate-spin" /> : null}
                Disconnect
              </Button>
            ) : (
              <Button disabled={Boolean(busyAction) || !canConnect} onClick={() => void runDesktopAction("connect", connectGoogleWorkspace)}>
                {busyAction === "connect" ? <Loader2 className="size-4 animate-spin" /> : null}
                Connect with Google
              </Button>
            )}
            <Button variant="outline" disabled={Boolean(busyAction) || !canTest} onClick={() => void runDesktopAction("test", () => openworkServerClient?.googleWorkspaceTestConnection() ?? Promise.resolve(null))}>
              {busyAction === "test" ? <Loader2 className="size-4 animate-spin" /> : null}
              Test connection
            </Button>
            <Button variant="outline" disabled={Boolean(busyAction) || !canTest} onClick={() => void runDesktopAction("smoke-test", () => openworkServerClient?.googleWorkspaceRunScopeSmokeTest() ?? Promise.resolve(null))}>
              {busyAction === "smoke-test" ? <Loader2 className="size-4 animate-spin" /> : null}
              Run diagnostic
            </Button>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}

registerExtensionRuntime({
  id: "google-workspace",
  settingsPanelRefs: ["openwork.googleWorkspace.settings"],
  settingsPanel: (ctx) => <GoogleWorkspaceConfig {...ctx} />,
  isConnected: (_entry, ctx) => ctx.extensionConnections?.["google-workspace"] === true,
});
