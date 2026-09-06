import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";

import { Button } from "@/components/ui/button";

import { LoginSyncDialog } from "./login-sync-dialog";
import { useBrowserLoginSync } from "./use-browser-login-sync";

/** One-time offer shown after browser login sync becomes available. */
export function LoginSyncCard() {
  const loginSync = useBrowserLoginSync();
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    if (loginSync.promptDue) loginSync.markPromptShown();
  }, [loginSync.markPromptShown, loginSync.promptDue]);

  // Keep a completed dialog visible until the user closes its summary.
  if (!loginSync.promptDue && !dialogOpen) return null;

  return (
    <>
      {loginSync.promptDue ? (
        <div
          className="flex shrink-0 items-start gap-3 border-b border-border bg-dls-hover px-3 py-2.5"
          role="status"
          data-testid="login-sync-card"
        >
          <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-dls-text">Keep selected logins in sync</p>
            <p className="text-xs text-muted-foreground">
              Choose one browser profile and the sites OpenWork may keep reading. Nothing starts until you enable sync.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="ghost" onClick={loginSync.dismissPrompt} data-testid="login-sync-not-now">Not now</Button>
            <Button size="sm" onClick={() => setDialogOpen(true)} data-testid="login-sync-open">Set up sync</Button>
          </div>
        </div>
      ) : null}
      <LoginSyncDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSyncEnabled={() => loginSync.completePrompt()}
      />
    </>
  );
}
