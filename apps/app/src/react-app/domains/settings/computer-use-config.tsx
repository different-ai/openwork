/** @jsxImportSource react */
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, Eye, Hand, Loader2, MousePointer2, RefreshCw, ShieldCheck } from "lucide-react";

import { desktopBridge } from "@/app/lib/desktop";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { registerExtensionConfig } from "./extension-registry";

type PermissionResult = {
  ok: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  supported: boolean;
  error?: string;
};

type ComputerUseConfigProps = {
  connected: boolean;
  connecting: boolean;
  onConnect?: () => void | Promise<void>;
  onRefresh?: () => void | Promise<void>;
  onPermissionsChange?: (permissions: { accessibility: boolean; screenRecording: boolean }) => void;
};

registerExtensionConfig("computer-use", (ctx) => (
  <ComputerUseConfig
    connected={ctx.computerUse?.connected ?? false}
    connecting={ctx.computerUse?.connecting ?? false}
    onConnect={ctx.computerUse?.onConnect}
    onRefresh={ctx.computerUse?.onRefresh}
    onPermissionsChange={ctx.computerUse?.onPermissionsChange}
  />
));

function hasDesktopBridge() {
  return typeof window !== "undefined" && Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop);
}

function parsePermissionResult(value: unknown): PermissionResult {
  if (typeof value !== "object" || value === null) throw new Error("Could not read Computer Use permissions.");
  return {
    ok: "ok" in value && value.ok === true,
    accessibility: "accessibility" in value && value.accessibility === true,
    screenRecording: "screenRecording" in value && value.screenRecording === true,
    supported: !("supported" in value && value.supported === false),
    error: "error" in value && typeof value.error === "string" ? value.error : undefined,
  };
}

const PERMISSIONS_QUERY_KEY = ["computer-use", "permissions"];
const modes = [
  { icon: Eye, name: "Read a window", description: "See its text and screenshots. No clicks or typing." },
  { icon: Hand, name: "Use app controls", description: "Work through accessible controls while your pointer stays free." },
  { icon: MousePointer2, name: "Use mouse and keyboard", description: "Work in the foreground. Your input pauses the session." },
];

export function ComputerUseConfig({ connected, connecting, onConnect, onRefresh, onPermissionsChange }: ComputerUseConfigProps) {
  const queryClient = useQueryClient();
  const { data: result, isFetching, error: checkError, refetch } = useQuery({
    queryKey: PERMISSIONS_QUERY_KEY,
    queryFn: async () => parsePermissionResult(await desktopBridge.checkComputerUsePermissions()),
    enabled: hasDesktopBridge(),
    retry: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
    refetchInterval: 2_000,
  });
  const connect = useMutation({
    mutationFn: async () => { await onConnect?.(); await onRefresh?.(); },
  });
  const setup = useMutation({
    mutationFn: async () => parsePermissionResult(await desktopBridge.openComputerUsePermissionSetup()),
    onSuccess: (next) => queryClient.setQueryData(PERMISSIONS_QUERY_KEY, next),
  });
  useEffect(() => {
    if (result) onPermissionsChange?.({ accessibility: result.accessibility, screenRecording: result.screenRecording });
  }, [result, onPermissionsChange]);

  const error = (connect.error ?? setup.error ?? checkError)?.message ?? result?.error;
  const supported = hasDesktopBridge() && result?.supported !== false;
  const permissionsReady = result?.ok === true;
  const ready = connected && permissionsReady;
  const busy = isFetching || setup.isPending;
  const refresh = async () => { setup.reset(); connect.reset(); await refetch(); await onRefresh?.(); };

  return (
    <Card variant="outline" size="sm">
      <CardHeader>
        <CardTitle>Work in an app you choose</CardTitle>
        <CardDescription>
          Approve one Mac app, choose its window, and decide how OpenWork can help. Each session has its own Take over and Stop controls.
        </CardDescription>
        <CardAction>
          <Button variant="ghost" size="icon-sm" aria-label="Refresh Computer Use status" onClick={() => void refresh()} disabled={busy}>
            <RefreshCw className={cn(busy && "animate-spin")} />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-3 text-sm" role="status" aria-live="polite">
          {ready ? <CheckCircle2 className="size-4 shrink-0 text-green-11" /> : <ShieldCheck className="size-4 shrink-0 text-muted-foreground" />}
          <span>{ready ? "Ready · app access is approved when a session starts" : !supported ? "Available in OpenWork for macOS 14 or later" : !connected ? permissionsReady ? "Permissions are ready. Enable Computer Use for this workspace." : "Set up Computer Use for this workspace" : "Connected · finish macOS permissions below"}</span>
        </div>
        {!ready ? (
          <Button className="w-full" onClick={() => { if (!connected) connect.mutate(); else setup.mutate(); }} disabled={!supported || connecting || connect.isPending || setup.isPending || (!connected && !onConnect)}>
            {connecting || connect.isPending || setup.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            {connecting || connect.isPending ? "Enabling…" : !connected ? "Enable Computer Use" : "Allow macOS access"}
          </Button>
        ) : null}
        {error ? <Alert variant="destructive"><CircleAlert /><AlertDescription className="break-words">{error}</AlertDescription></Alert> : null}
        <div className="space-y-3">
          <p className="text-sm font-medium">You choose the scope</p>
          <div className="grid gap-2">
            {modes.map(({ icon: Icon, name, description }) => (
              <div key={name} className="flex gap-3 rounded-xl border border-border p-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div><p className="text-sm font-medium">{name}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p></div>
              </div>
            ))}
          </div>
        </div>
        <div className="space-y-3 border-t border-border pt-4">
          <div><p className="text-sm font-medium">macOS permissions</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">These let the helper work. App access still needs your approval for each session.</p></div>
          <PermissionRow title="Accessibility" description="Read and use app controls" granted={result?.accessibility} />
          <PermissionRow title="Screen Recording" description="See the window you selected" granted={result?.screenRecording} />
          <Button variant="outline" className="min-h-10 w-full whitespace-normal" disabled={!supported || setup.isPending} onClick={() => setup.mutate()}>
            {setup.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Open permissions and session controls
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Sessions end after 15 minutes and pause when idle. Window content is processed by your selected model provider. Enter passwords yourself. For websites, use the built-in browser.
        </p>
      </CardContent>
      <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t border-border">
        <p className="max-w-sm text-xs text-muted-foreground">{ready ? "Mention an app in your next message, then approve the window when asked." : !connected ? "macOS access and enabling tools for this workspace are separate steps." : "Allow access, then return here. Status updates automatically."}</p>
        {ready ? <Button variant="outline" onClick={() => void refresh()} disabled={busy}>Check readiness</Button> : null}
      </CardFooter>
    </Card>
  );
}

function PermissionRow({ title, description, granted }: { title: string; description: string; granted: boolean | undefined }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
      <div><p className="text-sm">{title}</p><p className="text-xs text-muted-foreground">{description}</p></div>
      <span className={cn("shrink-0 text-xs font-medium", granted ? "text-green-11" : "text-muted-foreground")}>
        {granted === undefined ? "Checking…" : granted ? "Allowed" : "Needed"}
      </span>
    </div>
  );
}
