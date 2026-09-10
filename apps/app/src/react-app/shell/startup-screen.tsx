/** @jsxImportSource react */
import { use, type ReactNode } from "react";

// Startup gates cannot depend on the providers they are still waiting to mount.
export function StartupScreen({ message = "Starting OpenWork" }: { message?: string }) {
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

export function StartupApp({ startup }: { startup: Promise<ReactNode> }) {
  return use(startup);
}
