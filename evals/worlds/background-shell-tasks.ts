import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { denFetch } from "@openwork/behaviors";
import { allocateFreePorts } from "@openwork/cdp";
import { resolveEvalEngine, SkipError, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

/** One command the agent leaves running, and how its run ends. */
type BackgroundJob = { name: string; command: string; output: string; prompt: string; started: string; wake: string };

function job(name: string, output: string, prompt: string, started: string, wake: string): BackgroundJob {
  return { name, command: `sh scripts/${name}.sh`, output, prompt, started, wake };
}

/**
 * A signed-in member whose agent starts commands with the shell tool's
 * `background: true` on OpenCode v2. Each command is a real process the
 * engine runs; it waits until the world releases it, so a step can look at
 * the chat while the command is still running. When a command ends, the
 * engine wakes the agent with its output and the model replies.
 * The organization's `backgroundShellTasks` feature starts off.
 */
export async function backgroundShellTasks(seed: Seed) {
  if (resolveEvalEngine() !== "v2") throw new SkipError("Background shell commands only exist on OpenCode v2");
  const dir = seed.tmpPath("background-shell-tasks");
  await mkdir(join(dir, "scripts"), { recursive: true });
  await mkdir(join(dir, ".release"), { recursive: true });
  const workspacePath = await realpath(dir);

  const before = job("sync-photos", "Photos synced", "Sync the event photos in the background and tell me when it's done.",
    "Syncing the photos in the background. I'll tell you when it's done.", "The photos are synced.");
  const report = job("export-report", "Report exported", "Export the quarterly report in the background and tell me when it's done.",
    "Exporting the report in the background. I'll tell you when it's done.", "The quarterly report is exported.");
  const images = job("resize-images", "Images resized", "Also resize the product images in the background.",
    "Resizing the images in the background too.", "The product images are resized.");
  const jobs = [before, report, images];
  for (const item of jobs) {
    const script = join(workspacePath, "scripts", `${item.name}.sh`);
    // Waits for the world's release file, so the command runs exactly as long as a step needs.
    await writeFile(script, `#!/bin/sh\nwhile [ ! -f .release/${item.name} ]; do sleep 0.2; done\necho "${item.output}"\n`);
    await chmod(script, 0o755);
  }

  const [webPort] = await allocateFreePorts(1);
  if (!webPort) throw new Error("No app-web port available for the background shell world");
  const den = await seed.den({ trustedOrigins: [`http://127.0.0.1:${webPort}`] });
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("Could not resolve the seeded organization");

  const providerId = "background-shell-mock";
  const modelId = "background-shell-model";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: jobs.flatMap((item) => [
    { promptMarker: item.prompt, latestUserTurn: true, finalReply: item.started,
      // The images turn keeps working a few seconds after starting its command, so the chat can be seen mid-turn.
      ...(item === images ? { finalReplyDelayMs: 6_000 } : {}),
      steps: [{ tool: "shell", arguments: {
      command: item.command, description: `Run ${item.name}`, background: true,
    } }] },
    // The engine wakes the agent with the command's output once it ends.
    { promptMarker: item.output, latestUserTurn: true, finalReply: item.wake, steps: [] },
  ]) });
  const app = await seed.appWeb({ name: "background-shell-tasks", workspacePath, webPort, den: den.ref, mocks: { agent: mock } });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing background shell model witness");
  await seed.signIn(app, den.admin, "Background tasks member");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { bash: "allow" },
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Background shell mock",
      options: { baseURL: `${witness.url}/v1`, apiKey: "sk-background-shell-fixture" },
      models: { [modelId]: { name: "Background shell model" } },
    } },
  }, "v2");
  const session = await seed.session(app, { title: "Background tasks" });

  return {
    app, den, workspace, session, before, report, images,
    /**
     * Layout-jump witness: sample the chat's bottom status line every 50ms in
     * the page, then read its path. A probe cannot sample at that rate from
     * outside the page.
     */
    armJumpSampler: () => seed.evalIn(app, () => {
      const previous: unknown = Reflect.get(window, "__backgroundTaskJumps");
      if (previous && typeof previous === "object" && "timer" in previous && typeof previous.timer === "number") clearInterval(previous.timer);
      const state = { samples: [] as { line: string; top: number }[], timer: 0 };
      state.timer = window.setInterval(() => {
        const line = document.querySelector<HTMLElement>("[data-loading-message], [data-background-tasks-line]");
        if (!line) return;
        const sample = { line: line.dataset.loadingMessage ?? "background-tasks", top: Math.round(line.getBoundingClientRect().top) };
        const last = state.samples.at(-1);
        if (last?.line !== sample.line || last.top !== sample.top) state.samples.push(sample);
      }, 50);
      Reflect.set(window, "__backgroundTaskJumps", state);
      return true;
    }),
    /** Upward moves of the status line, where the count settled against the Working line it replaced, and any brief positions before that. */
    readJumpSampler: () => seed.evalIn(app, () => {
      const state: unknown = Reflect.get(window, "__backgroundTaskJumps");
      if (!state || typeof state !== "object" || !("samples" in state) || !Array.isArray(state.samples) || !("timer" in state) || typeof state.timer !== "number") return null;
      clearInterval(state.timer);
      const samples = state.samples.flatMap((sample: unknown) => sample && typeof sample === "object" && "line" in sample && "top" in sample
        && typeof sample.line === "string" && typeof sample.top === "number" ? [{ line: sample.line, top: sample.top }] : []);
      const lastWorking = samples.findLast((sample) => sample.line === "working");
      const alone = samples.filter((sample) => sample.line === "background-tasks");
      const settled = alone.at(-1);
      return {
        upward: samples.filter((sample, index) => index > 0 && sample.top < (samples[index - 1]?.top ?? sample.top)).length,
        // Where the count settled, relative to the Working line it replaced.
        settledMove: lastWorking && settled ? settled.top - lastWorking.top : null,
        // Positions the count passed through before settling (a slow frame can draw it early).
        transient: alone.slice(0, -1).map((sample) => sample.top - (lastWorking?.top ?? sample.top)),
        path: samples.map((sample) => `${sample.line}@${sample.top}`).join(" → "),
      };
    }),
    /** Let one command finish; it prints its output and exits 0. */
    release: (item: BackgroundJob) => writeFile(join(workspacePath, ".release", item.name), "go\n"),
    /** The platform admin turns `backgroundShellTasks` on for the member's organization, as /admin does. */
    async turnFeatureOn() {
      const result = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
        method: "PUT",
        headers: { authorization: `Bearer ${den.admin.token}` },
        body: JSON.stringify({ capabilities: { backgroundShellTasks: true } }),
      });
      if (!result.response.ok) throw new Error(`Turning backgroundShellTasks on failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
    },
  };
}
