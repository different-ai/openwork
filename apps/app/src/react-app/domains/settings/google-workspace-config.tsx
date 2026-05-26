/** @jsxImportSource react */
import { useEffect, useState, type ReactNode } from "react";
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
import {
  googleWorkspaceAuthStatus,
  googleWorkspaceConnect,
  googleWorkspaceDisconnect,
  googleWorkspaceRunScopeSmokeTest,
  googleWorkspaceTestConnection,
} from "../../../app/lib/desktop";
import { registerExtensionConfig } from "./extension-registry";

type GoogleWorkspaceAccount = {
  email: string | null;
  name: string | null;
  picture: string | null;
  sub: string | null;
};

type GoogleWorkspaceAuthStatus = {
  configured: boolean;
  missing: string[];
  vault: "encrypted" | "plaintext-dev" | "unavailable";
  connected: boolean;
  account: GoogleWorkspaceAccount | null;
  scopes: string[];
  connectedAt: string | null;
  error: string | null;
  testStatus: string | null;
  smokeTest: {
    driveFileId: string | null;
    driveFileName: string | null;
    gmailDraftId: string | null;
  } | null;
};

type BusyAction = "status" | "connect" | "disconnect" | "test" | "smoke-test";
type GoogleWorkspaceCommand = () => Promise<unknown>;

const PHASE_ONE_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/drive.file",
];

const PHASE_ONE_TOOLS = [
  "google_profile_get",
  "google_calendar_list_events",
  "google_calendar_get_event",
  "google_gmail_create_draft",
  "google_drive_search_accessible_files",
  "google_drive_read_file",
  "google_workspace_prepare_meeting",
];

const DEV_CLIENT_ID = "929071212606-uj6ag13l8llsqrpbo2rked168rjdd98o.apps.googleusercontent.com";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeGoogleWorkspaceAccount(value: unknown): GoogleWorkspaceAccount | null {
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

function Pill(props: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      {props.children}
    </span>
  );
}

function GoogleWorkspaceConfig() {
  const [status, setStatus] = useState<GoogleWorkspaceAuthStatus | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const desktopAvailable = typeof window !== "undefined" && Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop);
  const canConnect = desktopAvailable && status?.configured === true && status.vault !== "unavailable";
  const canTest = desktopAvailable && status?.connected === true;

  const loadStatus = async () => {
    if (!desktopAvailable) return;
    setBusyAction("status");
    setError(null);
    try {
      const result = await googleWorkspaceAuthStatus();
      setStatus(normalizeGoogleWorkspaceAuthStatus(result));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read Google Workspace status.");
    } finally {
      setBusyAction(null);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const runDesktopAction = async (action: Exclude<BusyAction, "status">, command: GoogleWorkspaceCommand) => {
    if (!desktopAvailable) return;
    setBusyAction(action);
    setError(null);
    try {
      const result = await command();
      setStatus(normalizeGoogleWorkspaceAuthStatus(result));
    } catch (err) {
      setError(err instanceof Error ? err.message : `Google Workspace ${action} failed.`);
      await loadStatus();
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-4">
      {!desktopAvailable ? (
        <Alert variant="warning">
          <ShieldCheck />
          <AlertTitle>Desktop app required</AlertTitle>
          <AlertDescription>
            Phase 1 uses a local OAuth callback and encrypted desktop token vault. Open this extension in OpenWork Desktop to connect Google Workspace.
          </AlertDescription>
        </Alert>
      ) : null}

      {status?.connected ? (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>Connected to Google Workspace</AlertTitle>
          <AlertDescription>
            {status.account?.email ? `Signed in as ${status.account.email}.` : "Google OAuth tokens are stored in the local encrypted vault."}
            {status.testStatus ? ` ${status.testStatus}` : ""}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="warning">
          <ShieldCheck />
          <AlertTitle>Phase 1 OAuth setup required</AlertTitle>
          <AlertDescription>
            Connect uses an OpenWork-owned Google OAuth desktop client with PKCE and stores tokens in the local encrypted vault.
          </AlertDescription>
        </Alert>
      )}

      {status && !status.configured ? (
        <Alert variant="warning">
          <XCircle />
          <AlertTitle>Google OAuth client not configured</AlertTitle>
          <AlertDescription>
            Set {status.missing.join(" and ")} before testing the local OAuth flow. Desktop OAuth uses PKCE, so no client secret is required.
          </AlertDescription>
        </Alert>
      ) : null}

      {status?.vault === "unavailable" ? (
        <Alert variant="destructive">
          <XCircle />
          <AlertTitle>Encrypted token vault unavailable</AlertTitle>
          <AlertDescription>
            OpenWork cannot store Google refresh tokens until Electron safe storage is available on this machine.
          </AlertDescription>
        </Alert>
      ) : null}

      {status?.vault === "plaintext-dev" ? (
        <Alert variant="warning">
          <ShieldCheck />
          <AlertTitle>Dev token vault</AlertTitle>
          <AlertDescription>
            This dev build is using Electron plaintext safe storage for headless testing. Packaged production builds require encrypted OS storage.
          </AlertDescription>
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
          <AlertDescription>
            Created Drive file {status.smokeTest.driveFileName ?? status.smokeTest.driveFileId} and Gmail draft {status.smokeTest.gmailDraftId}.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card variant="outline" size="sm">
        <CardHeader>
          <CardTitle>Phase 1 capabilities</CardTitle>
          <CardDescription>
            Start with the smallest useful loop: calendar context, selected Drive files, and Gmail drafts users review themselves.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-border bg-card p-3">
            <CalendarDays className="mb-2 size-4 text-blue-11" />
            <div className="text-sm font-medium text-card-foreground">Calendar read</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              List upcoming events and provide meeting context.
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-3">
            <MailPlus className="mb-2 size-4 text-red-11" />
            <div className="text-sm font-medium text-card-foreground">Gmail drafts</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Create draft emails only. No send tool in Phase 1.
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-card p-3">
            <FileText className="mb-2 size-4 text-green-11" />
            <div className="text-sm font-medium text-card-foreground">Selected Drive files</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Read files explicitly selected or created through OpenWork.
            </div>
          </div>
        </CardContent>
      </Card>

      <Card variant="outline" size="sm">
        <CardHeader>
          <CardTitle>OAuth request</CardTitle>
          <CardDescription>
            Configure these scopes in the OpenWork Google Cloud project first, then use the same list in the connector implementation.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-2xl border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {PHASE_ONE_SCOPES.map((scope) => (
              <div key={scope}>{scope}</div>
            ))}
          </div>
          <div className="text-xs leading-relaxed text-muted-foreground">
            Avoid adding Gmail read, broad Drive read, Google Chat, or Contacts until the Phase 1 E2E flow is verified.
          </div>
        </CardContent>
        <CardFooter className="flex-wrap gap-2 border-t border-border justify-between">
          <div className="flex flex-wrap gap-2">
            {status?.connected ? (
              <Button
                variant="destructive"
                disabled={Boolean(busyAction)}
                onClick={() => void runDesktopAction("disconnect", googleWorkspaceDisconnect)}
              >
                {busyAction === "disconnect" ? <Loader2 className="size-4 animate-spin" /> : null}
                Disconnect
              </Button>
            ) : (
              <Button
                disabled={Boolean(busyAction) || !canConnect}
                onClick={() => void runDesktopAction("connect", googleWorkspaceConnect)}
              >
                {busyAction === "connect" ? <Loader2 className="size-4 animate-spin" /> : null}
                Connect with Google
              </Button>
            )}
            <Button
              variant="outline"
              disabled={Boolean(busyAction) || !canTest}
              onClick={() => void runDesktopAction("test", googleWorkspaceTestConnection)}
            >
              {busyAction === "test" ? <Loader2 className="size-4 animate-spin" /> : null}
              Test connection
            </Button>
            <Button
              variant="outline"
              disabled={Boolean(busyAction) || !canTest}
              onClick={() => void runDesktopAction("smoke-test", googleWorkspaceRunScopeSmokeTest)}
            >
              {busyAction === "smoke-test" ? <Loader2 className="size-4 animate-spin" /> : null}
              Run scope smoke test
            </Button>
          </div>
          <a
            href="https://console.cloud.google.com/auth/overview"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Open Google Auth Platform
          </a>
        </CardFooter>
      </Card>

      <Card variant="outline" size="sm">
        <CardHeader>
          <CardTitle>Local dev test</CardTitle>
          <CardDescription>
            Run the desktop app with the OpenWork Google Workspace OAuth client ID. Desktop OAuth uses PKCE, so there is no client secret.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-2xl border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
            OPENWORK_GOOGLE_WORKSPACE_OAUTH_CLIENT_ID=&quot;{DEV_CLIENT_ID}&quot; pnpm dev
          </div>
        </CardContent>
      </Card>

      <Card variant="outline" size="sm">
        <CardHeader>
          <CardTitle>Initial tool contract</CardTitle>
          <CardDescription>
            These are the agent-facing tools the connector should expose before expanding scopes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {PHASE_ONE_TOOLS.map((tool) => (
              <Pill key={tool}>{tool}</Pill>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

registerExtensionConfig("openwork.googleWorkspace.settings", () => <GoogleWorkspaceConfig />);
registerExtensionConfig("google-workspace", () => <GoogleWorkspaceConfig />);
