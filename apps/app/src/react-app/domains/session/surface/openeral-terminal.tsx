/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Loader2, MessageSquare, Pencil, RotateCcw, Settings, Trash2 } from "lucide-react";

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
  /** When provided, a "Chat" button appears in the toolbar letting the
   *  user switch back to the regular OpenWork chat UI. The PTY session
   *  ends but the sandbox persists — switching back to Terminal reconnects. */
  onSwitchToChat?: () => void;
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

  // User-editable display name for the sandbox. The actual sandbox name
  // used by openshell never changes — this is purely cosmetic.
  const [displayName, setDisplayName] = useState<string>("");
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  // Stable callback for "reconnect" so the user can rebuild a dead PTY
  // without rerendering the whole component.
  const [reconnectKey, setReconnectKey] = useState(0);
  const reconnect = useCallback(() => setReconnectKey((k) => k + 1), []);

  // Track whether this component has ever reached "connected" phase so we
  // can show "Launch session" on first open vs "Reconnect" after a drop.
  const [hasEverConnected, setHasEverConnected] = useState(false);

  // Load/persist the user-facing display name from localStorage.
  useEffect(() => {
    if (!sandboxName) return;
    const stored = localStorage.getItem(`openeral-display:${sandboxName}`);
    setDisplayName(stored ?? sandboxName);
  }, [sandboxName]);

  const commitRename = useCallback(() => {
    if (!sandboxName) return;
    const trimmed = renameValue.trim();
    const next = trimmed || sandboxName;
    if (trimmed) localStorage.setItem(`openeral-display:${sandboxName}`, trimmed);
    else localStorage.removeItem(`openeral-display:${sandboxName}`);
    setDisplayName(next);
    setIsRenaming(false);
  }, [sandboxName, renameValue]);

  // Mark first successful connection and auto-focus the terminal so the
  // user can type immediately without having to click.
  useEffect(() => {
    if (phase !== "connected") return;
    setHasEverConnected(true);
    const raf = requestAnimationFrame(() => {
      try {
        termRef.current?.focus();
      } catch {
        // ignore
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [phase]);

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
              `\r\n\x1b[33m[Session ended (exit ${payload.exitCode ?? "?"}). Click Reconnect to start a new session.]\x1b[0m\r\n`,
            );
            setPhase("exited");
          }
        });

        // 3. Mount xterm.js inside the container div.
        setPhase("mounting-terminal");
        const { Terminal } = await import("@xterm/xterm");
        const { FitAddon } = await import("@xterm/addon-fit");
        if (cancelled || !containerRef.current) return;

        // Wait for the browser to complete layout so fit() can measure
        // real pixel dimensions. Two RAFs are the minimum: the first fires
        // before the style-recalc commit, the second fires after it.
        // This prevents cols=1 (vertical text) on first open.
        const waitFrames = (n: number) =>
          new Promise<void>((resolve) => {
            const step = (remaining: number) =>
              remaining <= 0 ? resolve() : requestAnimationFrame(() => step(remaining - 1));
            step(n);
          });
        await waitFrames(2);
        if (cancelled || !containerRef.current) return;

        // If the container still has 0 width after 2 frames (can happen
        // when the parent's height is derived purely from flexbox), keep
        // polling up to ~600 ms before giving up and using defaults.
        // (The absolute-inset-0 wrapper in session-page.tsx should prevent
        // this, but this guard catches any remaining edge cases.)
        let pollAttempts = 0;
        while (
          containerRef.current &&
          containerRef.current.clientWidth === 0 &&
          pollAttempts < 10
        ) {
          await waitFrames(2);
          if (cancelled) return;
          pollAttempts++;
        }
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
        // Initial fit — may give cols=1 if the browser hasn't committed
        // layout for the container yet (timing race on first mount).
        try {
          fit.fit();
        } catch {
          // ignore
        }
        termRef.current = term;
        fitRef.current = fit;

        // Flush any bytes that arrived during mount.
        if (earlyBufferRef.current.length > 0) {
          for (const chunk of earlyBufferRef.current) term.write(chunk);
          earlyBufferRef.current = [];
        }

        // ── Key fix for the cols=1 / vertical-text bug ──────────────────
        // Set up the ResizeObserver NOW, before the PTY is opened.
        // The ResizeObserver fires once on the FIRST frame after observe()
        // regardless of whether the size changed — this gives fit.fit() a
        // second chance to measure with fully-committed CSS dimensions.
        // We then wait two frames so that callback has run and corrected
        // term.cols before we pass it to openeralPtyOpen.
        //
        // Without this, the initial fit() above can race against the browser
        // layout commit and measure 0px → cols=1. Once cols=1 is set,
        // a ResizeObserver firing later calls fit.fit() → still cols=1 (no
        // change) → term.onResize never fires → no SIGWINCH → cols stays 1.
        if (containerRef.current) {
          const ro = new ResizeObserver(() => {
            try {
              fitRef.current?.fit();
            } catch {
              // Container unmounted — ignore.
            }
          });
          ro.observe(containerRef.current);
          resizeObserverRef.current = ro;
        }

        // Wait for the ResizeObserver initial callback to complete.
        // RO fires at the end of each rendering frame (after RAF).
        // Two frames is sufficient: frame N fires RAF → frame N+1 the
        // RO callback runs → fit.fit() corrects cols/rows.
        await waitFrames(2);
        if (cancelled || !containerRef.current) return;

        // Hard fallback: if fit() still reports cols ≤ 2 the container
        // genuinely has 0px CSS width.  Force a sane default so Claude
        // Code TUI at least opens usably; the ResizeObserver will correct
        // the PTY dimensions once the user resizes or the layout settles.
        if (term.cols <= 2) {
          try {
            term.resize(120, term.rows > 2 ? term.rows : 32);
          } catch {
            // ignore
          }
        }

        // 4. Open the PTY. Pass the current xterm size — now guaranteed
        // to be the result of a ResizeObserver-corrected fit() call.
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
        // (ResizeObserver is already wired above; it calls fit.fit() which
        // triggers this handler whenever the container resizes.)
        term.onResize(({ cols, rows }) => {
          if (!sessionIdRef.current) return;
          void invoke("openeralPtyResize", {
            sessionId: sessionIdRef.current,
            cols,
            rows,
          });
        });

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
          <span
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${
              phase === "connected"
                ? "bg-green-9"
                : phase === "exited" || phase === "error"
                  ? "bg-red-9"
                  : "bg-amber-9"
            }`}
          />
          {isRenaming ? (
            <input
              autoFocus
              className="h-6 rounded border border-dls-border bg-dls-hover px-2 font-mono text-xs text-gray-12 outline-none"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") setIsRenaming(false);
              }}
              onBlur={commitRename}
            />
          ) : (
            <button
              className="group flex items-center gap-1 min-w-0 text-left"
              title="Click to rename display label"
              onClick={() => {
                setRenameValue(displayName);
                setIsRenaming(true);
              }}
            >
              <span className="font-mono text-gray-12 truncate">{displayName || sandboxName || "(no sandbox)"}</span>
              <Pencil size={10} className="shrink-0 text-gray-8 opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          )}
          <span className="text-gray-9 shrink-0">·</span>
          <span className="text-gray-10 shrink-0">{phaseLabel(phase)}</span>
        </div>
        <div className="flex items-center gap-2">
          {phase === "exited" || phase === "error" ? (
            <Button variant="outline" className="h-7 rounded-full px-3 text-xs" onClick={reconnect}>
              <RotateCcw size={12} className="mr-1" />
              {hasEverConnected ? "Reconnect" : "Launch session"}
            </Button>
          ) : null}
          {props.onSwitchToChat ? (
            <Button
              variant="outline"
              className="h-7 rounded-full px-3 text-xs"
              onClick={props.onSwitchToChat}
              title="Switch to the regular OpenWork chat UI. The sandbox keeps running."
            >
              <MessageSquare size={12} className="mr-1" />
              Chat
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
      {/* The terminal container is always in the DOM with real CSS dimensions
          so xterm.js fit() measures correctly on first paint (avoids cols=1
          vertical-text bug). Loading / error overlays sit on top via absolute
          positioning rather than hiding the container with display:none. */}
      <div className="relative flex-1 min-h-0">
        <div ref={containerRef} className="absolute inset-0 bg-black" />
        {errorMessage && phase === "error" ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-dls-surface p-6">
            <BootstrapErrorCard
              message={errorMessage}
              profile={props.profile}
              onRetry={reconnect}
              onOpenSettings={props.onOpenSettings}
            />
          </div>
        ) : phase !== "connected" && phase !== "exited" ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-dls-surface p-6">
            <BootstrapProgress
              phase={phase}
              bootstrapMessage={bootstrapMessage}
              existed={false}
            />
          </div>
        ) : null}
      </div>
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
    <div className="w-full max-w-lg space-y-4 rounded-2xl border border-dls-border bg-dls-surface p-6">
      <div className="flex items-center gap-3">
        <Loader2 size={18} className="animate-spin text-gray-10" />
        <div className="text-sm font-medium text-gray-12">Starting OpenEral session</div>
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
  // Backend throws "ANTHROPIC_API_KEY is not configured" (not "is required")
  const missingApiKey = /ANTHROPIC_API_KEY is not configured/i.test(props.message);
  const openshellUnready = /OpenShell is not ready/i.test(props.message);
  const gatewayUnresponsive = /gateway is not responding|sandbox list timed out/i.test(props.message);
  const credentialIssue = missingDatabase || missingApiKey;

  let title = "Could not start OpenEral session.";
  let detail = props.message;
  if (missingDatabase) {
    title = "DATABASE_URL is not configured.";
    detail =
      "OpenEral stores workspace state in PostgreSQL. Open Settings → Sandbox → " +
      "OpenEral configuration and paste your connection string.";
  } else if (missingApiKey) {
    title = "ANTHROPIC_API_KEY is not configured.";
    detail =
      "OpenEral needs an Anthropic API key to auto-provision the Claude provider. " +
      "Open Settings → Sandbox → OpenEral configuration and paste your Anthropic API key.";
  } else if (gatewayUnresponsive) {
    title = "OpenShell gateway is not responding.";
    detail =
      "The openshell CLI couldn't reach its gateway. Open Settings → Sandbox → " +
      "OpenShell health and click Restart Gateway, then try again.";
  } else if (openshellUnready) {
    title = "OpenShell stack isn't ready.";
    detail =
      "Open Settings → Sandbox and run the installer / Doctor — the WSL distro, " +
      "Docker, OpenShell CLI, or gateway is missing or unhealthy.";
  }

  return (
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
