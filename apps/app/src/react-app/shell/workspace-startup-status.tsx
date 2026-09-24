/** @jsxImportSource react */
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { OwDotTicker } from "./dot-ticker";
import { formatCloudWorkspaceElapsed } from "./cloud-workspace-status";

/** One quiet, fixed-size status region. Timers must not re-announce the message. */
export function WorkspaceStartupStatus(props: {
  message: string;
  detail?: string;
  elapsedMs?: number;
  attention?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
      {!props.attention ? <div aria-hidden="true"><OwDotTicker size="md" /></div> : null}
      <div role={props.attention ? "alert" : "status"} aria-live="polite" aria-atomic="true" className="flex flex-col gap-2">
        <p className="text-sm font-medium text-foreground">{props.message}</p>
        {props.detail ? <p className="text-sm text-muted-foreground">{props.detail}</p> : null}
      </div>
      {props.elapsedMs !== undefined ? (
        <span role="timer" aria-live="off" className="text-xs tabular-nums text-muted-foreground" data-testid="cloud-workspace-elapsed">
          {formatCloudWorkspaceElapsed(props.elapsedMs)}
        </span>
      ) : null}
      {props.children}
    </div>
  );
}

/** Auth and access checks share geometry; neither mounts protected content. */
export function WebStartupScreen({ message }: { message: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 45_000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 py-16 text-foreground" data-testid="web-startup-screen">
      <WorkspaceStartupStatus message={slow ? "OpenWork is taking longer than usual to start" : message}>
        {slow ? <Button variant="outline" size="sm" onClick={() => window.location.reload()}>Reload</Button> : null}
      </WorkspaceStartupStatus>
    </main>
  );
}
