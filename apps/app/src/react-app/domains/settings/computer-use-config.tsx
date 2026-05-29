/** @jsxImportSource react */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckCircle2, CircleAlert, Loader2, RefreshCw, Settings2 } from "lucide-react";

import { desktopBridge } from "../../../app/lib/desktop";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { registerExtensionConfig } from "./extension-registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PermissionResult = {
  ok: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  error?: string;
};

type ComputerUseConfigProps = {
  connected: boolean;
  connecting: boolean;
  onConnect?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onPermissionsChange?: (permissions: { accessibility: boolean; screenRecording: boolean }) => void;
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

registerExtensionConfig("computer-use", (ctx) => (
  <ComputerUseConfig
    connected={ctx.computerUse?.connected ?? false}
    connecting={ctx.computerUse?.connecting ?? false}
    onConnect={ctx.computerUse?.onConnect}
    onRefresh={ctx.computerUse?.onRefresh}
    onPermissionsChange={ctx.computerUse?.onPermissionsChange}
  />
));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasDesktopBridge() {
  return typeof window !== "undefined" && Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop);
}

function normalize(value: unknown): PermissionResult {
  if (typeof value !== "object" || value === null) {
    return { ok: false, accessibility: false, screenRecording: false, error: "Unreadable response." };
  }
  return {
    ok: "ok" in value && value.ok === true,
    accessibility: "accessibility" in value && value.accessibility === true,
    screenRecording: "screenRecording" in value && value.screenRecording === true,
    error: "error" in value && typeof value.error === "string" ? value.error : undefined,
  };
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ComputerUseConfig(props: ComputerUseConfigProps) {
  const [result, setResult] = useState<PermissionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { onPermissionsChange } = props;

  // Spawn --check → fresh TCC read. Works whether or not the GUI is open.
  const verify = useCallback(async () => {
    if (!hasDesktopBridge()) {
      setError("Computer Use is Mac only and requires the OpenWork desktop app on macOS.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const raw = await desktopBridge.checkComputerUsePermissions();
      const next = normalize(raw);
      setResult(next);
      onPermissionsChange?.({ accessibility: next.accessibility, screenRecording: next.screenRecording });
      if (next.error) setError(next.error);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [onPermissionsChange]);

  // Check on mount.
  useEffect(() => { void verify(); }, [verify]);

  // Open the setup GUI then immediately re-verify.
  const grant = async () => {
    if (!hasDesktopBridge()) {
      setError("Computer Use is Mac only and requires the OpenWork desktop app on macOS.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const raw = await desktopBridge.openComputerUsePermissionSetup();
      const next = normalize(raw);
      setResult(next);
      onPermissionsChange?.({ accessibility: next.accessibility, screenRecording: next.screenRecording });
      if (next.error) setError(next.error);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const allGranted = result?.accessibility === true && result.screenRecording === true;

  return (
    <Card variant="outline" size="sm">
      <CardHeader>
        <CardTitle>Computer Use setup (Mac only)</CardTitle>
        <CardDescription>
          Computer Use only works on Mac. Connect the local MCP server and grant the macOS permissions it needs to control apps.
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" onClick={() => void verify()} disabled={busy}>
            <RefreshCw className={busy ? "animate-spin" : ""} />
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription className="break-words">{error}</AlertDescription>
          </Alert>
        ) : null}

        {/* Step 1 — MCP */}
        <SetupRow
          title="1. Connect Computer Use MCP"
          description="Adds the local Computer Use server to this workspace so Composer can use the computer-control tools."
          complete={props.connected}
        >
          <Button
            className="min-h-10 w-full whitespace-normal text-center lg:w-auto"
            onClick={() => void props.onConnect?.()}
            disabled={!props.onConnect || props.connected || props.connecting}
          >
            {props.connecting ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
            <span className="min-w-0 break-words">
              {props.connected ? "Configured" : props.connecting ? "Connecting…" : "Connect MCP"}
            </span>
          </Button>
        </SetupRow>

        {/* Step 2 — Permissions */}
        <SetupRow
          title="2. Grant macOS permissions"
          description="Opens the OpenWork Computer Use helper. Grant both permissions there, then click Verify below."
          complete={allGranted}
        >
          <div className="flex w-full min-w-0 flex-col gap-3">
            <div className="grid gap-2 xl:grid-cols-2">
              <Pill label="Accessibility" granted={result?.accessibility === true} checked={result !== null} />
              <Pill label="Screen Recording" granted={result?.screenRecording === true} checked={result !== null} />
            </div>

            <Button
              className="min-h-10 w-full justify-center whitespace-normal text-center"
              onClick={() => void grant()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="size-4 shrink-0 animate-spin" />
              ) : (
                <Settings2 className="size-4 shrink-0" />
              )}
              <span className="min-w-0 break-words">
                {busy ? "Opening…" : allGranted ? "Reopen helper" : "Grant permissions"}
              </span>
            </Button>
          </div>
        </SetupRow>
      </CardContent>

      <CardFooter className="border-t border-border">
        <div className="flex w-full flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <p className="text-xs text-muted-foreground">
            {allGranted
              ? "Permissions verified. Try a Composer prompt that uses Computer Use."
              : "After granting permissions in the helper, click Verify."}
          </p>
          <div className="flex w-full flex-col gap-2 xl:w-auto xl:flex-row">
            {props.onRefresh ? (
              <Button
                className="min-h-10 w-full whitespace-normal text-center xl:w-auto"
                variant="outline"
                onClick={() => void props.onRefresh?.()}
              >
                Refresh MCP
              </Button>
            ) : null}
            <Button
              className="min-h-10 w-full whitespace-normal text-center xl:w-auto"
              onClick={() => void verify()}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
              Verify permissions
            </Button>
          </div>
        </div>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SetupRow(props: { title: string; description: string; complete: boolean; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex min-w-0 flex-1 gap-3">
          <StatusIcon complete={props.complete} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-card-foreground">{props.title}</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.description}</div>
          </div>
        </div>
        <div className="w-full min-w-0 xl:w-[min(22rem,44%)]">{props.children}</div>
      </div>
    </div>
  );
}

function Pill(props: { label: string; granted: boolean; checked: boolean }) {
  const { label, granted, checked } = props;
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <StatusIcon complete={granted} muted={!checked} />
        <span className="truncate">{label}</span>
      </div>
      <span
        className={`shrink-0 text-xs font-medium ${
          !checked ? "text-muted-foreground" : granted ? "text-green-11" : "text-amber-11"
        }`}
      >
        {!checked ? "…" : granted ? "Granted" : "Needed"}
      </span>
    </div>
  );
}

function StatusIcon(props: { complete: boolean; muted?: boolean }) {
  if (props.complete) {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-11" />;
  }
  return (
    <CircleAlert
      className={`mt-0.5 size-4 shrink-0 ${props.muted ? "text-muted-foreground" : "text-amber-11"}`}
    />
  );
}
