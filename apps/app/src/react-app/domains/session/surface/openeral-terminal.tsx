/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Loader2, RotateCcw, Settings, Trash2 } from "lucide-react";

import type { SandboxProfile } from "../../../../app/lib/desktop";
import { Button } from "../../../design-system/button";

// xterm.js is loaded dynamically so it doesn't bloat the workspace
// dashboard bundle for users who never open an OpenEral session.
type TerminalType = import("@xterm/xterm").Terminal;
type FitAddonType = import("@xterm/addon-fit").FitAddon;

type ElectronBridge = NonNullable<Window["__OPENWORK_ELECTRON__"]>;

function getBridge(): ElectronBridge | null {
  if (typeof window === "undefined") return null;
  return window.__OPENWORK_ELECTRON__ ?? null;
}

async function invoke<T>(command: string, ...args: unknown[]): Promise<T> {
  const bridge = getBridge();
  if (!bridge?.invokeDesktop) {
    throw new Error("Electron desktop bridge is not available.");
  }
  return (await bridge.invokeDesktop(command, ...args)) as T;
}

export type OpenEralTerminalProps = {
  workspaceId: string;
  profile: SandboxProfile;
  /** Optional callback when the renderer decides to fully tear down the
   *  workspace (clicked "Delete sandbox" + confirmed). Caller is
   *  responsible for navigating away. */
  onSandboxDeleted?: () => void;
  /** Optional callback to route the user to Settings → Sandbox when the
   *  bootstrap fails because DATABASE_URL or ANTHROPIC_API_KEY isn't
   *  configured. Falls back to a window.alert if not provided. */
  onOpenSettings?: () => void;
};

type Phase =
  | "starting"
  | "ensuring-sandbox"
  | "mounting-terminal"
  | "connecting-pty"
  | "connected"
  | "exited"
  | "error";

export function OpenEralTerminal(props: OpenEralTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<TerminalType | null>(null);
  const fitRef = useRef<FitAddonType | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // Buffer to hold PTY bytes that arrive before xterm.js finishes
  // mounting and the data subscription is set up.
  const earlyBufferRef = useRef<string[]>([]);

  const [sandboxName, setSandboxName] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("starting");
  const [bootstrapMessage, setBootstrapMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [popoutBusy, setPopoutBusy] = useState(false);
  const [popoutError, setPopoutError] = useState<string | null>(null);

  // Stable callback for "reconnect" so the user can rebuild a dead PTY
  // without rerendering the whole component.
  const [reconnectKey, setReconnectKey] = useState(0);
  const reconnect = useCallback(() => setReconnectKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    let unsubData: (() => void) | undefined;
    let unsubExit: (() => void) | undefined;
    let unsubProgress: (() => void) | undefined;

    const writeToTerm = (data: string) => {
      if (termRef.current) {
        termRef.current.write(data);
      } else {
        earlyBufferRef.current.push(data);
      }
    };

    const cleanup = async () => {
      cancelled = true;
      unsubData?.();
      unsubExit?.();
      unsubProgress?.();
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (sessionIdRef.current) {
        const id = sessionIdRef.current;
        sessionIdRef.current = null;
        try {
          await invoke("openeralPtyClose", id);
        } catch {
          // Best-effort.
        }
      }
      termRef.current?.dispose();
      termRef.current = null;
      fitRef.current = null;
      earlyBufferRef.current = [];
    };

    const run = async () => {
      try {
        // 0. Subscribe to bootstrap progress events BEFORE calling
        // openeralEnsureSandbox so the founder sees the pull / stage /
        // create phases stream in. The session-progress channel is the
        // same one Phase O4's TestLaunchPanel uses.
        const bridge = getBridge();
        unsubProgress = bridge?.openeral?.onSessionProgress?.((evt) => {
          if (cancelled) return;
          if (evt.message) setBootstrapMessage(evt.message);
        });

        // 1. Ensure sandbox exists. This is idempotent — reopen of an
        // existing workspace short-circuits with existed=true.
        setPhase("ensuring-sandbox");
        const sandbox = await invoke<{ sandboxName: string; existed: boolean }>(
          "openeralEnsureSandbox",
          { workspaceId: props.workspaceId, profile: props.profile },
        );
        if (cancelled) return;
        setSandboxName(sandbox.sandboxName);

        // 2. Subscribe to PTY events BEFORE opening the PTY so the
        // initial sandbox-connect output (welcome banner, prompt)
        // isn't lost between open and subscribe.
        unsubData = bridge?.openeral?.onPtyData?.((payload) => {
          if (cancelled) return;
          if (payload.sessionId === sessionIdRef.current) {
            writeToTerm(payload.data);
          }
        });
        unsubExit = bridge?.openeral?.onPtyExit?.((payload) => {
          if (cancelled) return;
          if (payload.sessionId === sessionIdRef.current) {
            sessionIdRef.current = null;
            writeToTerm(
              `\r\n\x1b[33m[Session ended (exit ${payload.exitCode ?? "?"}). Click Reconnect to resume.]\x1b[0m\r\n`,
            );
            setPhase("exited");
          }
        });

        // 3. Mount xterm.js inside the container div.
        setPhase("mounting-terminal");
        const { Terminal } = await import("@xterm/xterm");
        const { FitAddon } = await import("@xterm/addon-fit");
        if (cancelled || !containerRef.current) return;

        const term = new Terminal({
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontSize: 13,
          cursorBlink: true,
          scrollback: 5_000,
          allowProposedApi: true,
          theme: {
            background: "#0a0a0a",
            foreground: "#e6e6e6",
            cursor: "#e6e6e6",
            selectionBackground: "#444",
          },
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(containerRef.current);
        try {
          fit.fit();
        } catch {
          // Container may not be measured yet on first paint.
        }
        termRef.current = term;
        fitRef.current = fit;

        // Flush any bytes that arrived during mount.
        if (earlyBufferRef.current.length > 0) {
          for (const chunk of earlyBufferRef.current) term.write(chunk);
          earlyBufferRef.current = [];
        }

        // 4. Open the PTY. Pass the current xterm size so the agent
        // gets the right window dimensions on first paint.
        setPhase("connecting-pty");
        const pty = await invoke<{ id: string }>("openeralPtyOpen", {
          sandboxName: sandbox.sandboxName,
          cols: term.cols,
          rows: term.rows,
        });
        if (cancelled) {
          await invoke("openeralPtyClose", pty.id).catch(() => {});
          return;
        }
        sessionIdRef.current = pty.id;

        // 5. Wire terminal input → PTY stdin. xterm's onData fires for
        // every keystroke including special keys (arrows, etc.).
        term.onData((data) => {
          if (!sessionIdRef.current) return;
          void invoke("openeralPtyWrite", {
            sessionId: sessionIdRef.current,
            data,
          });
        });

        // 6. Wire xterm's own resize event → forward to PTY (SIGWINCH).
        term.onResize(({ cols, rows }) => {
          if (!sessionIdRef.current) return;
          void invoke("openeralPtyResize", {
            sessionId: sessionIdRef.current,
            cols,
            rows,
          });
        });

        // 7. Resize the terminal whenever the container changes size
        // (panel toggles, window resizes). fit.fit() recomputes
        // cols/rows from CSS pixels; that fires term.onResize above.
        if (containerRef.current) {
          const ro = new ResizeObserver(() => {
            try {
              fit.fit();
            } catch {
              // Container still unmounted — bail.
            }
          });
          ro.observe(containerRef.current);
          resizeObserverRef.current = ro;
        }

        setPhase("connected");
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setErrorMessage(message);
        setPhase("error");
      }
    };

    void run();
    return () => {
      void cleanup();
    };
  }, [props.workspaceId, props.profile, reconnectKey]);

  const popOut = useCallback(async () => {
    if (!sandboxName) return;
    setPopoutBusy(true);
    setPopoutError(null);
    try {
      await invoke("openeralPopOutTerminal", sandboxName);
    } catch (err) {
      setPopoutError(err instanceof Error ? err.message : String(err));
    } finally {
      setPopoutBusy(false);
    }
  }, [sandboxName]);

  const deleteSandbox = useCallback(async () => {
    if (!sandboxName) return;
    const ok = window.confirm(
      `Delete sandbox "${sandboxName}"?\n\n` +
        "The Postgres-backed /home/agent will remain, but this sandbox " +
        "instance is gone. Reopening the workspace will create a fresh " +
        "sandbox and restore the home directory from PostgreSQL.",
    );
    if (!ok) return;
    try {
      await invoke("openeralDeleteSandbox", sandboxName);
      props.onSandboxDeleted?.();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }, [sandboxName, props.onSandboxDeleted, props]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-dls-border bg-dls-surface px-4 py-2 text-xs">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                phase === "connected"
                  ? "bg-green-9"
                  : phase === "exited" || phase === "error"
                    ? "bg-red-9"
                    : "bg-amber-9"
              }`}
            />
            <span className="font-mono text-gray-12 truncate">
              {sandboxName ?? "(no sandbox)"}
            </span>
          </div>
          <span className="text-gray-9">·</span>
          <span className="text-gray-10">{phaseLabel(phase)}</span>
        </div>
        <div className="flex items-center gap-2">
          {phase === "exited" || phase === "error" ? (
            <Button
              variant="outline"
              className="h-7 rounded-full px-3 text-xs"
              onClick={reconnect}
            >
              <RotateCcw size={12} className="mr-1" />
              Reconnect
            </Button>
          ) : null}
          <Button
            variant="outline"
            className="h-7 rounded-full px-3 text-xs"
            onClick={() => void popOut()}
            disabled={!sandboxName || popoutBusy}
            title="Open the same sandbox in a separate OS terminal window"
          >
            {popoutBusy ? <Loader2 size={12} className="mr-1 animate-spin" /> : <ExternalLink size={12} className="mr-1" />}
            Pop out
          </Button>
          <Button
            variant="outline"
            className="h-7 rounded-full border-red-7/50 px-3 text-xs text-red-12 hover:bg-red-2/30"
            onClick={() => void deleteSandbox()}
            disabled={!sandboxName}
            title="Delete the sandbox. Postgres-backed /home/agent files persist."
          >
            <Trash2 size={12} className="mr-1" />
            Delete sandbox
          </Button>
        </div>
      </div>
      {popoutError ? (
        <div className="border-b border-red-7/40 bg-red-2/20 px-4 py-2 text-xs text-red-12">
          Pop out failed: {popoutError}
        </div>
      ) : null}
      {errorMessage && phase === "error" ? (
        <BootstrapErrorCard
          message={errorMessage}
          profile={props.profile}
          onRetry={reconnect}
          onOpenSettings={props.onOpenSettings}
        />
      ) : phase !== "connected" && phase !== "exited" ? (
        <BootstrapProgress
          phase={phase}
          bootstrapMessage={bootstrapMessage}
          existed={false}
        />
      ) : null}
      {/* Keep the xterm container in the DOM at all times so xterm.js has
          a stable host element to mount into. We just stack the loading /
          error overlays on top via CSS until the PTY is connected. */}
      <div
        ref={containerRef}
        className={`flex-1 min-h-0 bg-black ${
          phase === "connected" || phase === "exited" ? "block" : "hidden"
        }`}
      />
    </div>
  );
}

type BootstrapProgressProps = {
  phase: Phase;
  bootstrapMessage: string | null;
  existed: boolean;
};

function BootstrapProgress(props: BootstrapProgressProps) {
  const steps: Array<{ id: Phase; label: string }> = [
    { id: "ensuring-sandbox", label: "Pulling image + creating sandbox" },
    { id: "mounting-terminal", label: "Mounting terminal" },
    { id: "connecting-pty", label: "Opening PTY" },
  ];
  const phaseOrder: Phase[] = ["starting", "ensuring-sandbox", "mounting-terminal", "connecting-pty", "connected"];
  const currentIdx = phaseOrder.indexOf(props.phase);
  return (
    <div className="flex flex-1 items-center justify-center bg-dls-surface p-6">
      <div className="w-full max-w-lg space-y-4 rounded-2xl border border-dls-border bg-dls-surface p-6">
        <div className="flex items-center gap-3">
          <Loader2 size={18} className="animate-spin text-gray-10" />
          <div className="text-sm font-medium text-gray-12">
            Starting OpenEral session
          </div>
        </div>
        <div className="space-y-2">
          {steps.map((step) => {
            const stepIdx = phaseOrder.indexOf(step.id);
            const state =
              stepIdx < currentIdx ? "done" : stepIdx === currentIdx ? "active" : "pending";
            return (
              <div key={step.id} className="flex items-center gap-3 text-xs">
                <div
                  className={`h-2 w-2 rounded-full ${
                    state === "done"
                      ? "bg-green-9"
                      : state === "active"
                        ? "bg-amber-9 animate-pulse"
                        : "bg-gray-6"
                  }`}
                />
                <span className={state === "pending" ? "text-gray-8" : "text-gray-11"}>
                  {step.label}
                </span>
              </div>
            );
          })}
        </div>
        {props.bootstrapMessage ? (
          <div className="rounded-xl border border-dls-border bg-gray-1/40 p-3 font-mono text-[11px] text-gray-10">
            {props.bootstrapMessage}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type BootstrapErrorCardProps = {
  message: string;
  profile: SandboxProfile;
  onRetry: () => void;
  onOpenSettings?: () => void;
};

function BootstrapErrorCard(props: BootstrapErrorCardProps) {
  // Detect actionable errors so the founder sees a clear next step
  // instead of a raw stderr dump.
  const missingDatabase = /DATABASE_URL is not configured/i.test(props.message);
  const missingApiKey = /ANTHROPIC_API_KEY is required/i.test(props.message);
  const openshellUnready = /OpenShell is not ready/i.test(props.message);
  const credentialIssue = missingDatabase || missingApiKey;

  let title = "Could not start OpenEral session.";
  let detail = props.message;
  if (missingDatabase) {
    title = "DATABASE_URL is not configured.";
    detail =
      "OpenEral stores workspace state in PostgreSQL. Open Settings → Sandbox → " +
      "OpenEral configuration and paste your connection string.";
  } else if (missingApiKey) {
    title = "ANTHROPIC_API_KEY is required for OpenClaw.";
    detail =
      "OpenClaw's embedded gateway can't resolve OpenShell provider placeholders. " +
      "Open Settings → Sandbox → OpenEral configuration and paste your Anthropic API key.";
  } else if (openshellUnready) {
    title = "OpenShell stack isn't ready.";
    detail =
      "Open Settings → Sandbox and run the installer / Doctor — the WSL distro, " +
      "Docker, OpenShell CLI, or gateway is missing or unhealthy.";
  }

  return (
    <div className="flex flex-1 items-center justify-center bg-dls-surface p-6">
      <div className="max-w-lg space-y-4 rounded-2xl border border-red-7/40 bg-red-2/20 p-5">
        <div className="flex items-center gap-2 text-red-12">
          <AlertTriangle size={16} />
          <span className="text-sm font-medium">{title}</span>
        </div>
        <div className="text-sm text-gray-11">{detail}</div>
        {!credentialIssue ? (
          <div className="font-mono text-xs text-red-12 break-words">
            {props.message}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          {(credentialIssue || openshellUnready) && props.onOpenSettings ? (
            <Button variant="primary" onClick={props.onOpenSettings}>
              <Settings size={14} className="mr-1.5" />
              Open Settings → Sandbox
            </Button>
          ) : null}
          <Button variant="outline" onClick={props.onRetry}>
            Retry
          </Button>
        </div>
      </div>
    </div>
  );
}

function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "starting":
      return "Starting...";
    case "ensuring-sandbox":
      return "Preparing sandbox (pull + create)...";
    case "mounting-terminal":
      return "Mounting terminal...";
    case "connecting-pty":
      return "Opening PTY...";
    case "connected":
      return "Connected";
    case "exited":
      return "Disconnected";
    case "error":
      return "Error";
    default:
      return phase;
  }
}
