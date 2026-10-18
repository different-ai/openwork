/** @jsxImportSource react */
import { use, type ReactNode } from "react";
import { isOpenworkGatewayRuntime } from "@/app/lib/gateway-runtime";
import { WebStartupScreen } from "./workspace-startup-status";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useWorkspaceShellLayout } from "./workspace-shell-layout";

// Startup gates cannot depend on the providers they are still waiting to mount.
export function StartupScreen({ message = "Starting OpenWork" }: { message?: string }) {
  if (isOpenworkGatewayRuntime()) return <WebStartupScreen message={message} />;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-dls-surface p-6 text-dls-primary">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center text-sm">
        <p role="status" aria-live="polite">{message}</p>
        <p className="text-dls-secondary">If startup does not finish, reload to try again.</p>
        <button
          type="button"
          className="rounded-md border border-dls-border px-3 py-2 font-medium"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    </div>
  );
}

/** Destination geometry only: no cached member/workspace content before authorization. */
export function SigninDestinationSkeleton({ settings = false, conversation = false }: { settings?: boolean; conversation?: boolean }) {
  const { leftSidebarWidth } = useWorkspaceShellLayout({ expandedRightWidth: 520 });
  return (
    <div className="flex min-h-dvh bg-background text-foreground" data-testid="signin-destination-skeleton" role="status" aria-label="Opening saved workspace">
      <aside aria-hidden="true" style={{ width: leftSidebarWidth }} className="hidden shrink-0 flex-col gap-4 border-r border-border bg-sidebar p-4 md:flex">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-4 w-32" />
      </aside>
      <main className="relative flex min-w-0 flex-1 flex-col p-6">
        <div aria-hidden="true" className={`mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 ${settings ? "pt-12" : conversation ? "justify-end pb-12" : "justify-center"}`}>
          {settings ? <><Skeleton className="h-6 w-32" /><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></> : <Skeleton className="h-32 w-full rounded-2xl" />}
        </div>
        <Button variant="ghost" size="sm" className="self-end" onClick={() => window.location.reload()}>Reload</Button>
      </main>
    </div>
  );
}

export function StartupApp({ startup }: { startup: Promise<ReactNode> }) {
  return use(startup);
}
