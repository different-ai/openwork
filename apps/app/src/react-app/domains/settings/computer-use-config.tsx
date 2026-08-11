/** @jsxImportSource react */
import { useEffect, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Loader2, RefreshCw, Settings2 } from "lucide-react";

import { desktopBridge } from "@/app/lib/desktop";
import { t } from "@/i18n";
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
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
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

function parsePermissionResult(value: unknown): PermissionResult {
  if (typeof value !== "object" || value === null) {
    throw new Error(t("computer_use.unreadable_response"));
  }
  return {
    ok: "ok" in value && value.ok === true,
    accessibility: "accessibility" in value && value.accessibility === true,
    screenRecording: "screenRecording" in value && value.screenRecording === true,
    error: "error" in value && typeof value.error === "string" ? value.error : undefined,
  };
}

const PERMISSIONS_QUERY_KEY = ["computer-use", "permissions"] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ComputerUseConfig({
  connected,
  connecting,
  onConnect,
  onRefresh,
  onPermissionsChange,
}: ComputerUseConfigProps) {
  const queryClient = useQueryClient();

  // Fresh TCC read via --check; works whether or not the setup GUI is open.
  const {
    data: result = null,
    isFetching,
    error: checkError,
    refetch,
  } = useQuery({
    queryKey: PERMISSIONS_QUERY_KEY,
    queryFn: async () => parsePermissionResult(await desktopBridge.checkComputerUsePermissions()),
    enabled: hasDesktopBridge(),
    retry: false,
    refetchOnWindowFocus: false,
  });

  // Opens the setup GUI; it returns a fresh read that becomes the cached state.
  const {
    mutate: grant,
    isPending: isGrantPending,
    error: grantError,
    reset: resetGrant,
  } = useMutation({
    mutationFn: async () => {
      if (!hasDesktopBridge()) {
        throw new Error(t("computer_use.mac_only_error"));
      }

      return parsePermissionResult(await desktopBridge.openComputerUsePermissionSetup());
    },
    onSuccess: (next) => {
      queryClient.setQueryData(PERMISSIONS_QUERY_KEY, next);
    },
  });

  const isBusy = isFetching || isGrantPending;
  const error = (grantError ?? checkError)?.message ?? result?.error ?? null;

  // Bubble the latest read up to the parent.
  useEffect(() => {
    if (result) {
      onPermissionsChange?.({ accessibility: result.accessibility, screenRecording: result.screenRecording });
    }
  }, [result, onPermissionsChange]);

  // Clear a stale setup error, then re-read permissions.
  const verify = () => {
    if (!hasDesktopBridge()) {
      return;
    }

    resetGrant();
    void refetch();
  };

  const allGranted = result?.accessibility === true && result.screenRecording;

  return (
    <Card variant="outline" size="sm">
      <CardHeader>
        <CardTitle>{t("computer_use.title")}</CardTitle>
        <CardDescription>
          {t("computer_use.desc")}
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" onClick={() => void verify()} disabled={isBusy}>
            <RefreshCw className={cn(isBusy && "animate-spin")} />
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
          title={t("computer_use.step_connect_mcp")}
          description={t("computer_use.step_connect_mcp_desc")}
          complete={connected}
        >
          <Button
            className="min-h-10 w-full whitespace-normal text-center lg:w-auto"
            onClick={() => void onConnect?.()}
            disabled={!onConnect || connected || connecting}
          >
            {connecting ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
            <span className="min-w-0 break-words">
              {connected ? t("computer_use.configured") : connecting ? t("computer_use.connecting") : t("computer_use.connect_mcp")}
            </span>
          </Button>
        </SetupRow>

        {/* Step 2 — Permissions */}
        <SetupRow
          title={t("computer_use.step_grant_permissions")}
          description={t("computer_use.step_grant_permissions_desc")}
          complete={allGranted}
        >
          <div className="flex w-full min-w-0 flex-col gap-3">
            <div className="grid gap-2">
              <Pill label={t("computer_use.accessibility")} granted={result?.accessibility === true} checked={result !== null} />
              <Pill label={t("computer_use.screen_recording")} granted={result?.screenRecording === true} checked={result !== null} />
            </div>

            <Button
              className="min-h-10 w-full justify-center whitespace-normal text-center"
              onClick={() => void grant()}
              disabled={isBusy}
            >
              {isBusy ? (
                <Loader2 className="size-4 shrink-0 animate-spin" />
              ) : (
                <Settings2 className="size-4 shrink-0" />
              )}
              <span className="min-w-0 wrap-break-word">
                {isBusy ? t("computer_use.opening") : allGranted ? t("computer_use.reopen_helper") : t("computer_use.grant_permissions")}
              </span>
            </Button>
          </div>
        </SetupRow>
      </CardContent>

      <CardFooter className="border-t border-border">
        <div className="flex w-full flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {allGranted
              ? t("computer_use.permissions_verified")
              : t("computer_use.after_grant_click_verify")}
          </p>
          <div className="flex w-full justify-end gap-2">
            {onRefresh ? (
              <Button
                variant="outline"
                onClick={() => void onRefresh?.()}
              >
                {t("common.refresh")}
              </Button>
            ) : null}
            <Button
              onClick={() => void verify()}
              disabled={isBusy}
            >
              {isBusy ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
              {t("computer_use.verify_permissions")}
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

interface SetupRowProps {
  title: string;
  description: string;
  complete: boolean;
  children: ReactNode;
}

function SetupRow(props: SetupRowProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-1 gap-3">
          <StatusIcon complete={props.complete} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-card-foreground">{props.title}</div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{props.description}</div>
          </div>
        </div>
        <div className="w-full min-w-0">{props.children}</div>
      </div>
    </div>
  );
}

interface PillProps {
  label: string;
  granted: boolean;
  checked: boolean;
}

function Pill({ label, granted, checked }: PillProps) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <StatusIcon complete={granted} muted={!checked} />
        <span className="truncate">{label}</span>
      </div>
      <span
        className={cn(
          "shrink-0 text-xs font-medium",
          !checked && "text-muted-foreground",
          checked && granted && "text-green-11",
          checked && !granted && "text-amber-11",
        )}
      >
        {!checked ? "…" : granted ? t("computer_use.granted") : t("computer_use.needed")}
      </span>
    </div>
  );
}

interface StatusIconProps {
  complete: boolean;
  muted?: boolean;
}

function StatusIcon(props: StatusIconProps) {
  if (props.complete) {
    return <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-11" />;
  }

  return (
    <CircleAlert
      className={cn("mt-0.5 size-4 shrink-0", props.muted ? "text-muted-foreground" : "text-amber-11")}
    />
  );
}
