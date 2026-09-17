import { connect } from "node:net";
import { evalIn, quitDesktop, readComposerState } from "@openwork/behaviors";
import { addInitScript, browserScript } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { mcpMock, resolveEvalEngine } from "@openwork/env";
import type { MockHandle, Place, Seed } from "@openwork/env";
import { desktop as launchDesktop } from "@openwork/hosts";
import type { DesktopHandle } from "@openwork/hosts";
import type { MockAgentWorkload } from "@openwork/labs";
import { configureProvider } from "./chat.ts";

/**
 * A thread whose turn is still running a long tool when the whole desktop
 * (renderer, embedded server, and engine) goes away, then comes back on the
 * same profile and renderer origin. The person then continues the thread by
 * typing, exactly as they would after a crash, a force quit, or a normal quit.
 *
 * The desktop is signed out and Den-less: the state under test is local
 * transcript/run state, not cloud enrollment. The deterministic model witness
 * runs on this host so it survives the desktop restart the way a real provider
 * does, and every send first confirms the composer still shows that witness so
 * no turn can reach a real model.
 */

export type RestartMode = "kill" | "quit";

export const restartedThreadPrompts = {
  /** The turn interrupted by the restart runs one long tool then would reply. */
  interrupted: "Prepare the restart continuity report",
  interruptedReply: "The original turn finished without restarting.",
  /** Exactly what the person types after the restart. */
  continuation: "continue",
  continuationReply: "Continued after the restart.",
  /** The desktop's own startup recovery continuation, when it is eligible. */
  recoveryMarker: "Continue the interrupted task",
  recoveryReply: "The interrupted report continued automatically.",
} as const;

const providerId = "thread-restart-mock";
const modelId = "thread-restart-model";
export const restartedThreadModelName = "Thread restart model";

async function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => { socket.destroy(); resolvePort(open); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

async function waitUntil(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

declare global {
  interface Window {
    __openworkSlowHistoryFault?: { state: { delayed: number; bounded: number }; dispose: () => void };
  }
}

/**
 * A cold engine after a restart can take longer than the renderer's request
 * timeout to return a long thread's complete history, while bounded reads
 * still answer quickly. Model exactly that from the renderer's first request
 * onwards (the caller reloads the document): every uncapped message read for
 * this thread is delayed past the timeout; reads with a limit pass untouched.
 */
export async function slowUncappedHistoryReads(app: Surface, workspaceId: string, sessionId: string, delayMs: number) {
  const script = await addInitScript(app.client, browserScript((workspaceId, sessionId, delayMs) => {
    if (window.top !== window || window.__openworkSlowHistoryFault) return;
    const paths = ["workspace", "w"].map((mount) =>
      `/${mount}/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}/message`);
    const originalFetch = window.fetch;
    const state = { delayed: 0, bounded: 0 };
    const wrappedFetch: typeof window.fetch = async (...args) => {
      const [input, init] = args;
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const port = localStorage.getItem("openwork.server.port");
      const owned = Boolean(port) && url.origin === `http://127.0.0.1:${port}` && method === "GET" && paths.includes(url.pathname);
      if (!owned) return originalFetch.apply(window, args);
      if (url.searchParams.has("limit")) { state.bounded += 1; return originalFetch.apply(window, args); }
      state.delayed += 1;
      const signal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined;
      await new Promise<void>((resolveDelay, rejectDelay) => {
        const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolveDelay(); }, delayMs);
        const abort = () => { clearTimeout(timer); rejectDelay(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
      return originalFetch.apply(window, args);
    };
    window.fetch = wrappedFetch;
    window.__openworkSlowHistoryFault = {
      state,
      dispose: () => { if (window.fetch === wrappedFetch) window.fetch = originalFetch; delete window.__openworkSlowHistoryFault; },
    };
  }, [workspaceId, sessionId, delayMs]));
  return {
    read: () => evalIn(app, () => {
      const fault = window.__openworkSlowHistoryFault;
      if (!fault) throw new Error("Slow history fault lost its document");
      return { ...fault.state };
    }),
    async dispose() {
      await script.dispose().catch(() => undefined);
      await evalIn(app, () => { window.__openworkSlowHistoryFault?.dispose(); }).catch(() => undefined);
    },
  };
}

/** Reload the renderer document the way a render-crash recovery or Cmd+R does; the shell and engine stay up. */
export async function reloadRenderer(app: Surface): Promise<void> {
  await evalIn(app, () => { window.setTimeout(() => window.location.reload(), 50); return true; });
  const deadline = Date.now() + 60_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const state = await readComposerState(app);
      if (state.composerEditable) return;
      last = state;
    } catch (error) {
      last = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`The renderer did not come back after reload; last observed ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

/** Refuse to send unless the composer is bound to the model witness. */
export async function assertWitnessModel(app: Surface): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = "";
  while (Date.now() < deadline) {
    last = (await readComposerState(app).catch(() => null))?.selectedModelLabel ?? "";
    if (last.startsWith(restartedThreadModelName)) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`The composer is bound to "${last}" instead of the model witness "${restartedThreadModelName}"; refusing to send a turn to a real model.`);
}

export async function restartedThreadWorld(seed: Seed, ctx: { place: Place }) {
  if (ctx.place.kind !== "local") throw new Error("This world kills and relaunches the desktop process group on the host running it; run it on the local lane.");
  const engine = resolveEvalEngine();
  const prompts = restartedThreadPrompts;
  const workloads: MockAgentWorkload[] = [
    {
      promptMarker: prompts.interrupted, latestUserTurn: true, finalReply: prompts.interruptedReply,
      steps: [{ tool: engine === "v2" ? "shell" : "bash", arguments: {
        command: "sleep 120", description: "Wait for the report input", timeout: 180_000,
      } }],
    },
    { promptMarker: prompts.continuation, latestUserTurn: true, finalReply: prompts.continuationReply, steps: [] },
    { promptMarker: prompts.recoveryMarker, latestUserTurn: true, finalReply: prompts.recoveryReply, steps: [] },
  ];
  // Booted directly so the witness outlives the desktop it serves.
  const mock: MockHandle = (await mcpMock({ agentWorkloads: workloads }).boot(ctx.place)).handle;
  let app: Surface & { stop(): Promise<void> } = await seed.desktop({ name: "thread-restart", profileDir: seed.tmpPath("thread-restart-profile") });
  const profileDir = app.handle.profileDir;
  if (!profileDir) throw new Error("The desktop surface did not expose its profile directory.");
  const vitePort = app.handle.meta?.vitePort;
  if (!vitePort) throw new Error("The desktop surface did not expose its renderer port.");
  // The renderer origin owns localStorage (preferences, drafts, model memory);
  // the relaunch must load exactly the same one for persisted state to count.
  const rendererOrigin = String(await evalIn(app, () => window.location.origin));
  const workspacePath = seed.tmpPath("thread-restart");
  const workspace = await seed.workspace(app, workspacePath, { create: true });
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { bash: "allow" },
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: restartedThreadModelName,
        options: { baseURL: `${mock.url}/v1`, apiKey: "sk-openwork-eval" },
        models: { [modelId]: { name: restartedThreadModelName } },
      },
    },
  });
  await assertWitnessModel(app);
  let session: { sessionId: string; title: string } | null = null;
  const sessionDeadline = Date.now() + 60_000;
  let lastSessionError: unknown = null;
  while (!session && Date.now() < sessionDeadline) {
    try { session = await seed.session(app, { title: "Continue after restart" }); } catch (error) {
      lastSessionError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  }
  if (!session) throw new Error(`Session creation did not settle: ${lastSessionError instanceof Error ? lastSessionError.message : String(lastSessionError)}`);
  let restarted: DesktopHandle | null = null;
  return {
    engine, mock, workspace, workspacePath, session, prompts, modelName: restartedThreadModelName,
    get app(): Surface { return app; },
    /**
     * Take the whole desktop away — `kill` is a crash or force quit (SIGKILL to
     * the process group: renderer, embedded server, and engine die at once);
     * `quit` is the person's Cmd+Q through Chromium, which runs the shell's
     * graceful teardown. Then relaunch on the same profile and renderer origin.
     */
    async restart(mode: RestartMode): Promise<Surface> {
      const pid = app.handle.pid;
      if (pid === undefined) throw new Error("The desktop surface did not expose its process id.");
      if (mode === "quit") {
        await quitDesktop(app);
      } else {
        try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
      }
      await waitUntil("the desktop process group to exit", async () => !pidIsAlive(pid), 60_000);
      await waitUntil(`renderer port ${vitePort} to be released`, async () => !(await portIsOpen(Number(vitePort))), 60_000);
      await app.stop().catch(() => undefined);
      restarted = await launchDesktop({
        name: "thread-restart-relaunch",
        profileDir,
        env: { PORT: vitePort, OPENWORK_ELECTRON_START_URL: rendererOrigin },
        prepareSharedResources: false,
      });
      const origin = String(await evalIn(restarted, () => window.location.origin));
      if (origin !== rendererOrigin) {
        throw new Error(`The relaunched renderer loaded ${origin} instead of ${rendererOrigin}; persisted renderer state cannot be observed.`);
      }
      app = restarted;
      return restarted;
    },
    async [Symbol.asyncDispose]() {
      await restarted?.stop().catch(() => undefined);
      await mock.stop().catch(() => undefined);
    },
  };
}
