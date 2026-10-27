import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allocateFreePorts } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

/** One command the agent leaves running, and how its run ends. */
type BackgroundJob = { name: string; command: string; output: string; prompt: string; started: string; wake: string };

function job(name: string, output: string, prompt: string, started: string, wake: string): BackgroundJob {
  return { name, command: `sh scripts/${name}.sh`, output, prompt, started, wake };
}

/**
 * A signed-in member whose agent starts commands with the generally available
 * shell tool's `background: true`.
 * Background commands only exist on OpenCode v2, so the app runs on v2
 * whatever engine the lane defaults to. Each command is a real process that
 * waits until the world releases it; when it ends, the engine wakes the agent
 * with its output and the model replies.
 */
export async function backgroundTasksShimmer(seed: Seed) {
  const engine = "v2";
  const dir = seed.tmpPath("background-tasks-shimmer");
  await mkdir(join(dir, "scripts"), { recursive: true });
  await mkdir(join(dir, ".release"), { recursive: true });
  const workspacePath = await realpath(dir);

  const report = job("export-report", "Report exported", "Export the quarterly report in the background and tell me when it's done.",
    "Exporting the report in the background. I'll tell you when it's done.", "The quarterly report is exported.");
  const images = job("resize-images", "Images resized", "Also resize the product images in the background.",
    "Resizing the images in the background too.", "The product images are resized.");
  const jobs = [report, images];
  for (const item of jobs) {
    const script = join(workspacePath, "scripts", `${item.name}.sh`);
    // Waits for the world's release file, so the command runs exactly as long as a step needs.
    await writeFile(script, `#!/bin/sh\nwhile [ ! -f .release/${item.name} ]; do sleep 0.2; done\necho "${item.output}"\n`);
    await chmod(script, 0o755);
  }

  const [webPort] = await allocateFreePorts(1);
  if (!webPort) throw new Error("No app-web port available for the background tasks world");
  const den = await seed.den({ trustedOrigins: [`http://127.0.0.1:${webPort}`] });

  const providerId = "background-shell-mock";
  const modelId = "background-shell-model";
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: jobs.flatMap((item) => [
    { promptMarker: item.prompt, latestUserTurn: true, finalReply: item.started,
      // The images turn keeps working a few seconds after starting its command, so the chat can be seen mid-turn.
      ...(item === images ? { finalReplyDelayMs: 8_000 } : {}),
      steps: [{ tool: "shell", arguments: { command: item.command, description: `Run ${item.name}`, background: true } }] },
    // The engine wakes the agent with the command's output once it ends.
    { promptMarker: item.output, latestUserTurn: true, finalReply: item.wake, steps: [] },
  ]) });
  const app = await seed.appWeb({ name: "background-tasks-shimmer", workspacePath, webPort, den: den.ref, engine, mocks: { agent: mock } });
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
  }, engine);
  const session = await seed.session(app, { title: "Background tasks" });

  return {
    app, den, workspace, session, report, images,
    /** Let one command finish; it prints its output and exits 0. */
    release: (item: BackgroundJob) => writeFile(join(workspacePath, ".release", item.name), "go\n"),
  };
}
