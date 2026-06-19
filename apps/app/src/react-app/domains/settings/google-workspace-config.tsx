/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { CalendarDays, CheckCircle2, FileText, Loader2, MailPlus, ShieldCheck, XCircle } from "lucide-react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import type { GoogleWorkspaceAuthStatus, OpenworkServerClient } from "../../../app/lib/openwork-server";
import { usePlatform } from "../../kernel/platform";
import type { ExtensionConfigContext } from "./extension-registry";
import { registerExtensionRuntime } from "./extension-registry";

type BusyAction = "status" | "connect" | "disconnect" | "set-active" | "test" | "smoke-test" | "save-secret";
type OptionalFeature = "gmailRead" | "driveFull" | "calendarWrite" | "chat";

const OPTIONAL_FEATURES: { id: OptionalFeature; label: string; description: string }[] = [
  { id: "gmailRead", label: "Read Gmail", description: "Read your Gmail messages and threads." },
  { id: "driveFull", label: "Full Google Drive access", description: "Search, read, and edit all files in your Drive, not just files created through OpenWork." },
  { id: "calendarWrite", label: "Create calendar events", description: "Create events on your Google Calendar." },
  { id: "chat", label: "Google Chat", description: "List spaces, read messages, and send messages in Google Chat." },
];
type GoogleWorkspaceCommand = () => Promise<unknown>;
const DESKTOP_ACTION_TIMEOUT_MS = 6 * 60 * 1000;
const CONNECT_POLL_INTERVAL_MS = 1_000;
// Must match GOOGLE_WORKSPACE_DESKTOP_CLIENT_ID in apps/server/src/extensions/google-workspace.ts.
const OPENWORK_BUILTIN_GOOGLE_CLIENT_ID = "929071212606-pmkqimjhm2tnp68kbklnout0irllj99h.apps.googleusercontent.com";

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
    accountId: typeof value.accountId === "string" ? value.accountId : null,
    email: typeof value.email === "string" ? value.email : null,
    name: typeof value.name === "string" ? value.name : null,
    picture: typeof value.picture === "string" ? value.picture : null,
    sub: typeof value.sub === "string" ? value.sub : null,
    scopes: normalizeStringList(value.scopes),
    connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : null,
  };
}

function normalizeGoogleWorkspaceAccounts(value: unknown): GoogleWorkspaceAuthStatus["accounts"] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeGoogleWorkspaceAccount).filter((item): item is NonNullable<GoogleWorkspaceAuthStatus["account"]> => item !== null);
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
    customClient: record.customClient === true,
    vault,
    connected: record.connected === true,
    account: normalizeGoogleWorkspaceAccount(record.account),
    accounts: normalizeGoogleWorkspaceAccounts(record.accounts),
    activeAccountId: typeof record.activeAccountId === "string" ? record.activeAccountId : null,
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

function GoogleWorkspaceConfig({ openworkServerClient, hostOpenworkServerClient, onExtensionConnectionChange, restartLocalServer }: ExtensionConfigContext) {
  const platform = usePlatform();
  const [status, setStatus] = useState<GoogleWorkspaceAuthStatus | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientSecret, setClientSecret] = useState("");
  const [customClientId, setCustomClientId] = useState("");
  const [customClientSecret, setCustomClientSecret] = useState("");
  const [optionalFeatures, setOptionalFeatures] = useState<Record<OptionalFeature, boolean>>({ gmailRead: false, driveFull: false, calendarWrite: false, chat: false });
  const serverAvailable = Boolean(openworkServerClient);
  const hostServerAvailable = Boolean(hostOpenworkServerClient);
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
    const features = status?.customClient === true ? OPTIONAL_FEATURES.filter((feature) => optionalFeatures[feature.id]).map((feature) => feature.id) : [];
    const flow = await openworkServerClient.googleWorkspaceConnectStart({ features });
    platform.openLink(flow.authUrl);
    return waitForGoogleWorkspaceConnection(openworkServerClient, flow.flowId, flow.expiresAt);
  };

  const saveOauthEnv = async (entries: { key: string; value: string }[], onSaved: () => void) => {
    if (!hostOpenworkServerClient) {
      setError("Google OAuth settings can only be saved from the local desktop app.");
      return;
    }
    setBusyAction("save-secret");
    setError(null);
    try {
      await hostOpenworkServerClient.upsertUserEnv(entries);
      await hostOpenworkServerClient.setUserEnvPendingChanges(true);
      onSaved();
      if (restartLocalServer) {
        const restarted = await restartLocalServer();
        if (!restarted) setError("Saved Google OAuth settings. Restart OpenWork to apply them.");
      } else {
        setError("Saved Google OAuth settings. Restart OpenWork to apply them.");
      }
      await loadStatus({ clearError: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save Google OAuth settings.");
    } finally {
      setBusyAction(null);
    }
  };

  const saveGoogleClientSecret = async () => {
    const value = clientSecret.trim();
    if (!value) {
      setError("Enter the client secret from your Google OAuth desktop client.");
      return;
    }
    await saveOauthEnv([{ key: "GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", value }], () => setClientSecret(""));
  };

  const saveCustomOauthClient = async () => {
    const id = customClientId.trim();
    const secret = customClientSecret.trim();
    if (!id || !secret) {
      setError("Enter both the client ID and client secret from your own Google OAuth desktop client.");
      return;
    }
    if (id === OPENWORK_BUILTIN_GOOGLE_CLIENT_ID) {
      setError("That is the built-in OpenWork client ID, which cannot unlock Gmail read access. Create your own OAuth client in Google Cloud Console (APIs & Services > Credentials > Create OAuth client ID > Desktop app) and paste its client ID here.");
      return;
    }
    await saveOauthEnv(
      [
        { key: "GOOGLE_WORKSPACE_OAUTH_CLIENT_ID", value: id },
        { key: "GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET", value: secret },
      ],
      () => {
        setCustomClientId("");
        setCustomClientSecret("");
      },
    );
  };

  const connectedAccounts = status?.accounts.length ? status.accounts : status?.account ? [status.account] : [];

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
            {connectedAccounts.length === 1 && connectedAccounts[0]?.email ? `Signed in as ${connectedAccounts[0].email}.` : `${connectedAccounts.length} Google accounts connected.`}
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
          <AlertDescription>Add your Google OAuth desktop client secret to connect Google Workspace.</AlertDescription>
        </Alert>
      ) : null}

      {status && !status.configured ? (
        <Card variant="outline" size="sm">
          <CardHeader>
            <CardTitle>Set up Google OAuth</CardTitle>
            <CardDescription>
              Use a Google Cloud OAuth desktop client. OpenWork already includes the desktop client ID; paste the matching client secret here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              type="password"
              value={clientSecret}
              onChange={(event) => setClientSecret(event.target.value)}
              placeholder="Google OAuth desktop client secret"
              autoComplete="off"
            />
            <p className="text-xs leading-relaxed text-muted-foreground">
              The secret is saved locally in OpenWork environment settings and applied after the local server restarts.
            </p>
          </CardContent>
          <CardFooter>
            <Button disabled={busyAction === "save-secret" || !clientSecret.trim() || !hostServerAvailable} onClick={() => void saveGoogleClientSecret()}>
              {busyAction === "save-secret" ? <Loader2 className="size-4 animate-spin" /> : null}
              Save and apply
            </Button>
          </CardFooter>
        </Card>
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
        {connectedAccounts.length > 0 ? (
          <CardContent className="space-y-2 pt-6">
            {connectedAccounts.map((account) => (
              <div key={account.accountId ?? account.email ?? account.sub ?? "google-account"} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card p-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-card-foreground">{account.email ?? account.name ?? "Google account"}</div>
                  <div className="text-xs text-muted-foreground">{account.accountId === status?.activeAccountId ? "Default for extension actions" : "Connected"}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {account.accountId && account.accountId !== status?.activeAccountId ? (
                    <Button variant="outline" size="sm" disabled={Boolean(busyAction)} onClick={() => {
                      const accountId = account.accountId;
                      if (!accountId) return;
                      void runDesktopAction("set-active", () => openworkServerClient?.googleWorkspaceSetActiveAccount(accountId) ?? Promise.resolve(null));
                    }}>
                      {busyAction === "set-active" ? <Loader2 className="size-4 animate-spin" /> : null}
                      Make default
                    </Button>
                  ) : null}
                  <Button variant="destructive" size="sm" disabled={Boolean(busyAction)} onClick={() => void runDesktopAction("disconnect", () => openworkServerClient?.googleWorkspaceDisconnect(account.accountId) ?? Promise.resolve(null))}>
                    Disconnect
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        ) : null}
        <CardFooter className="flex-wrap gap-2 justify-between">
          <div className="flex flex-wrap gap-2">
            <Button disabled={Boolean(busyAction) || !canConnect} onClick={() => void runDesktopAction("connect", connectGoogleWorkspace)}>
              {busyAction === "connect" ? <Loader2 className="size-4 animate-spin" /> : null}
              {status?.connected ? "Add another Google account" : "Connect with Google"}
            </Button>
            {connectedAccounts.length > 1 ? (
              <Button variant="destructive" disabled={Boolean(busyAction)} onClick={() => void runDesktopAction("disconnect", () => openworkServerClient?.googleWorkspaceDisconnect() ?? Promise.resolve(null))}>
                {busyAction === "disconnect" ? <Loader2 className="size-4 animate-spin" /> : null}
                Disconnect all
              </Button>
            ) : null}
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

      <Accordion>
        <AccordionItem value="advanced">
          <AccordionTrigger>Advanced</AccordionTrigger>
          <AccordionContent className="space-y-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Use your own Google OAuth client to unlock extra permissions, like reading Gmail, full Drive access, creating calendar events, and Google Chat.
            </p>
            {status?.customClient ? (
              <Alert>
                <CheckCircle2 />
                <AlertTitle>Using your own Google OAuth client</AlertTitle>
                <AlertDescription>Extra permissions below are available.</AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-3">
                <Input
                  value={customClientId}
                  onChange={(event) => setCustomClientId(event.target.value)}
                  placeholder="Your Google OAuth desktop client ID"
                  autoComplete="off"
                />
                <Input
                  type="password"
                  value={customClientSecret}
                  onChange={(event) => setCustomClientSecret(event.target.value)}
                  placeholder="Your Google OAuth desktop client secret"
                  autoComplete="off"
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Create a desktop OAuth client in Google Cloud Console, then paste its client ID and secret. They are saved locally in OpenWork environment settings and applied after the local server restarts.
                </p>
                <Button disabled={busyAction === "save-secret" || !customClientId.trim() || !customClientSecret.trim() || !hostServerAvailable} onClick={() => void saveCustomOauthClient()}>
                  {busyAction === "save-secret" ? <Loader2 className="size-4 animate-spin" /> : null}
                  Save and apply
                </Button>
              </div>
            )}
            <div className="space-y-3">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {status?.customClient
                  ? "Allow or deny each extra permission below. They are requested the next time you connect a Google account. Already connected? Disconnect and connect again to change them."
                  : "Add your own Google OAuth client above to enable these options."}
              </p>
              {OPTIONAL_FEATURES.map((feature) => (
                <label key={feature.id} className="flex items-start gap-2.5">
                  <Checkbox
                    checked={optionalFeatures[feature.id]}
                    onCheckedChange={(checked) => setOptionalFeatures((current) => ({ ...current, [feature.id]: checked === true }))}
                    disabled={Boolean(busyAction) || status?.customClient !== true}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-card-foreground">{feature.label}</span>
                    <span className="block text-xs leading-relaxed text-muted-foreground">{feature.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

registerExtensionRuntime({
  id: "google-workspace",
  settingsPanelRefs: ["openwork.googleWorkspace.settings"],
  settingsPanel: (ctx) => <GoogleWorkspaceConfig {...ctx} />,
  isConnected: (_entry, ctx) => ctx.extensionConnections?.["google-workspace"] === true,
});
