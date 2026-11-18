import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { promisify } from "node:util";
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

export async function portIsOpen(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (open: boolean) => { socket.destroy(); resolvePort(open); };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1_000, () => done(false));
  });
}

export async function waitUntil(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

export function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Processes still in a process group after its leader exited (POSIX `ps`, same on macOS and Linux). */
async function processGroupMembers(pgid: number): Promise<{ pid: number; args: string }[]> {
  const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "pid=,pgid=,args="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && Number(match[2]) === pgid && Number(match[1]) !== process.pid ? [{ pid: Number(match[1]), args: match[3] ?? "" }] : [];
  });
}

/**
 * The dev desktop launches as `pnpm dev:electron`: one process group holding
 * the Electron shell and the Vite server that serves the renderer origin. Vite
 * is development tooling, not the product: a packaged app has none, and on
 * Linux the dev launcher's teardown can leave it running after Electron quits.
 * Anything else still alive after a quit is the product failing to stop.
 */
const RENDERER_DEV_TOOLING = /\bvite\b|dev:ui|@openwork\/app\b|\besbuild\b/;

declare global {
  interface Window {
    __openworkSlowHistoryFault?: { state: { delayed: number; bounded: number }; dispose: () => void };
  }
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
  // This signed-out continuity world has no Den. Keep deployment-policy reads
  // on the fixture-owned origin too: hosted Den can otherwise force v2 while
  // this world is explicitly exercising v1. Unavailable local features apply no
  // force policy. Reuse these origins after relaunch as well.
  // Native desktop bootstrap overrides Vite's defaults, so pin both to the
  // same local origin instead of only changing the renderer build settings.
  const bootstrapPath = seed.tmpPath("thread-restart-bootstrap.json");
  await writeFile(bootstrapPath, JSON.stringify({ baseUrl: mock.url, apiBaseUrl: mock.url, requireSignin: false }));
  const localOnlyEnv = {
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: bootstrapPath,
    VITE_DEN_BASE_URL: mock.url, VITE_DEN_API_BASE_URL: mock.url,
  };
  let app: Surface & { stop(): Promise<void> } = await seed.desktop({
    name: "thread-restart", profileDir: seed.tmpPath("thread-restart-profile"), env: localOnlyEnv,
  });
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
      // The launcher exits only after Electron itself has exited (and, for a
      // quit, after the shell's own teardown ran).
      await waitUntil("the desktop launcher to exit", async () => !pidIsAlive(pid), 60_000);
      // Its children may still be finishing their own exit; only renderer dev
      // tooling may outlive them.
      let productLeftovers: { pid: number; args: string }[] = [];
      await waitUntil("the desktop's own processes to exit", async () => {
        productLeftovers = (await processGroupMembers(pid)).filter((member) => !RENDERER_DEV_TOOLING.test(member.args));
        return productLeftovers.length === 0;
      }, 30_000).catch(() => {
        throw new Error(`The desktop ${mode === "quit" ? "quit" : "crash"} left processes running: ${productLeftovers.map((member) => `${member.pid} ${member.args.slice(0, 200)}`).join(" | ")}`);
      });
      // Stop the leftover renderer dev server, so the relaunch starts its own on
      // the same origin, exactly as a fresh `pnpm dev:electron` would.
      await app.stop().catch(() => undefined);
      await waitUntil(`renderer port ${vitePort} to be released`, async () => !(await portIsOpen(Number(vitePort))), 30_000);
      restarted = await launchDesktop({
        name: "thread-restart-relaunch",
        profileDir,
        env: { ...localOnlyEnv, PORT: vitePort, OPENWORK_ELECTRON_START_URL: rendererOrigin },
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
