/** @jsxImportSource react */

import * as React from "react";

interface AppErrorBoundaryState {
  error: Error | null;
}

function formatError(error: Error): string {
  return error.stack ?? `${error.name}: ${error.message}`;
}

/**
 * Last-resort boundary around the whole application.
 *
 * React unmounts the entire tree when a render throws, so before this existed a
 * single bad value rendered the app as a blank white window with nothing in the
 * UI to explain it. The same failure mode is documented on the tool-part
 * boundary in components/chat/message-list.tsx, which was added after it was
 * seen in production.
 *
 * This deliberately renders plain elements and does not call `t()`: locale
 * initialization runs before the tree mounts and has itself been a source of
 * startup failures, so the screen that reports a crash must not depend on it.
 */
export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[app] render failed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background p-6">
        <div className="flex w-full max-w-lg flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold text-foreground">
              OpenWork hit an unexpected error
            </h1>
            <p className="text-sm text-muted-foreground">
              The window recovered instead of going blank. Reloading usually clears it.
            </p>
          </div>

          <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
            {formatError(error)}
          </pre>

          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            <button
              type="button"
              className="rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground"
              onClick={() => {
                void navigator.clipboard?.writeText(formatError(error));
              }}
            >
              Copy details
            </button>
          </div>
        </div>
      </div>
    );
  }
}
