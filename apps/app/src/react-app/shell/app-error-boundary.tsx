/** @jsxImportSource react */

import * as React from "react";
import { formatCrashDiagnostic } from "@/app/lib/crash-diagnostics";
import { openworkServerInfo, readDesktopDistributionInfo, revealDesktopItemInDir } from "@/app/lib/desktop";
import { reportCaughtWebError } from "@/app/lib/error-monitoring";
import { getOpenWorkDeployment } from "@/app/lib/openwork-deployment";

const APP_VERSION = String(import.meta.env.VITE_OPENWORK_APP_VERSION ?? "").trim();

export type CrashDetails = {
  message: string;
  stack: string;
};

export type CrashContext = {
  version: string;
  deployment: string;
  flavor: string;
};

interface AppErrorBoundaryState {
  crash: CrashDetails | null;
}

export { redactCrashText } from "@/app/lib/crash-diagnostics";

/** React may throw any value, including one that cannot safely be inspected. */
export function describeCrash(thrown: unknown): CrashDetails {
  const { message, stack } = formatCrashDiagnostic(thrown);
  return { message, stack };
}

/** Clipboard payload: message, stack, app version and distribution flavor. */
export function buildCrashReport(crash: CrashDetails, context: CrashContext): string {
  const header = `OpenWork ${context.version} (${context.deployment}, ${context.flavor})`;
  return [header, crash.message, crash.stack].filter((line) => line.length > 0).join("\n\n");
}

function readCrashContext(): CrashContext {
  return {
    version: APP_VERSION,
    deployment: getOpenWorkDeployment(),
    flavor: readDesktopDistributionInfo().flavor,
  };
}

/**
 * The server log lives under the desktop profile and is only reachable through
 * the desktop bridge. On the web, or before an enterprise install is activated,
 * the bridge refuses the call and the action stays hidden.
 */
async function resolveLogFilePath(): Promise<string | null> {
  try {
    return (await openworkServerInfo()).logFilePath;
  } catch {
    return null;
  }
}

function RecoveryScreen({ crash }: { crash: CrashDetails }) {
  const [open, setOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState(false);
  const [logFilePath, setLogFilePath] = React.useState<string | null>(null);
  const [logsError, setLogsError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void resolveLogFilePath().then((path) => {
      if (!cancelled) setLogFilePath(path);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = async () => {
    setCopied(false);
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(buildCrashReport(crash, readCrashContext()));
      setCopied(true);
    } catch {
      setCopyError(true);
    }
  };

  const openLogs = async (path: string) => {
    try {
      await revealDesktopItemInDir(path);
    } catch {
      setLogsError("Could not open the logs folder.");
    }
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background p-6" role="alert">
      <div className="flex w-full max-w-lg flex-col gap-4 text-sm">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-foreground">OpenWork hit an unexpected error</h1>
          <p className="text-muted-foreground">
            The window recovered instead of going blank. Reloading usually clears it.
          </p>
        </div>

        <div>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>

        {/* Same disclosure shape as the session error card: the raw payload
            and its actions are for whoever reports the crash, on demand. */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <span aria-hidden="true" className={open ? "inline-block rotate-90" : "inline-block"}>›</span>
            Technical details
          </button>
          {open ? (
            <div className="flex flex-col gap-2 rounded-lg bg-muted p-3 text-xs">
              <p className="break-words font-medium text-foreground">{crash.message}</p>
              {crash.stack ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-muted-foreground">{crash.stack}</pre>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 font-medium text-foreground"
                  onClick={copy}
                >
                  {copied ? "Copied" : "Copy details"}
                </button>
                {logFilePath ? (
                  <button
                    type="button"
                    className="rounded-md border border-border px-3 py-1.5 font-medium text-foreground"
                    onClick={() => openLogs(logFilePath)}
                  >
                    Open logs folder
                  </button>
                ) : null}
              </div>
              {copyError ? <p role="status" className="text-muted-foreground">Could not copy details. You can select and copy the text above.</p> : null}
              {logsError ? <p className="text-muted-foreground">{logsError}</p> : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Last-resort boundary around the whole application.
 *
 * React unmounts the entire tree when a render throws, so before this existed a
 * single bad value rendered the app as a blank window with nothing in the UI to
 * explain it. The same failure mode is documented on the tool-part boundary in
 * components/chat/message-list.tsx, which was added after it was seen in
 * production.
 *
 * It sits above every provider in index.react.tsx, so it must not read any
 * React context. It deliberately renders plain elements and does not call
 * `t()`: locale initialization runs before the tree mounts and has itself been
 * a source of startup failures, so the screen that reports a crash must not
 * depend on it. Recovery needs no network; optional web reporting keeps its
 * existing monitoring and analytics gates.
 */
export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { crash: null };

  static getDerivedStateFromError(thrown: unknown): AppErrorBoundaryState {
    return { crash: describeCrash(thrown) };
  }

  componentDidCatch(error: unknown, _info: React.ErrorInfo) {
    // A caught render throw never reaches the window "error" listener, so the
    // web deployment's monitor is told directly, with the same redacted text
    // the screen shows. Inert on desktop.
    reportCaughtWebError(error);
  }

  render() {
    const { crash } = this.state;
    if (!crash) return this.props.children;
    return <RecoveryScreen crash={crash} />;
  }
}
