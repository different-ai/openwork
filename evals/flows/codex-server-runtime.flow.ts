import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "codex-server-runtime";
const TASK_PROMPT = "Run hostname and create server-proof.md on the remote worker.";
const FINAL_ANSWER = "Done on the remote worker. I ran hostname and created server-proof.md.";

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

let workspaceRoute = "";

async function dismissUnavailableModelPicker(ctx: FlowContext): Promise<void> {
  if (!(await ctx.hasText("No models available. Connect a provider to get started."))) return;
  await ctx.clickText("Done");
  await ctx.waitFor(
    `!document.body.innerText.includes("No models available. Connect a provider to get started.")`,
    { timeoutMs: 10_000, label: "unavailable-model picker closes" },
  );
}

async function currentRoute(ctx: FlowContext): Promise<string> {
  const value = await ctx.eval("String(window.__openworkControl.snapshot().route || '')");
  ctx.assert(typeof value === "string", "OpenWork control route was not available.");
  return typeof value === "string" ? value : "";
}

async function disconnectChatGptIfNeeded(ctx: FlowContext): Promise<void> {
  if (!(await ctx.hasText("ChatGPT connected ·"))) return;
  const clicked = await ctx.eval(`(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const button = buttons.find((candidate) => (candidate.textContent || "").trim() === "Disconnect");
    if (!button) return false;
    button.click();
    return true;
  })()`);
  ctx.assert(clicked === true, "Could not disconnect the existing Codex ChatGPT account.");
  await ctx.waitForText("ChatGPT not connected", { timeoutMs: 20_000 });
}

export default defineFlow({
  id: FLOW_ID,
  title: "ChatGPT Codex executes on a remote OpenWork worker",
  kind: "user-facing",
  precondition: async (ctx) => {
    await ctx.eval("location.reload()");
    await new Promise((resolve) => setTimeout(resolve, 750));
    await ctx.reconnect({ timeoutMs: 30_000 });
    await ctx.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 60_000,
      label: "OpenWork control API",
    });
    const route = await currentRoute(ctx);
    const match = route.match(/^(\/workspace\/[^/]+)/);
    if (!match) return "OpenWork is not currently inside a workspace.";
    workspaceRoute = match[1] ?? "";
    return await ctx.hasText("Codex Remote Worker")
      ? null
      : "The Codex Remote Worker eval fixture is not connected.";
  },
  steps: [
    {
      name: "Remote worker is the active workspace",
      run: async (ctx) => {
        await ctx.prove("OpenWork is connected to the remote worker before any Codex task starts", {
          voiceover: vo[0],
          action: async () => {
            await ctx.control("route.session");
            await dismissUnavailableModelPicker(ctx);
            await ctx.waitForText("What do you need done?");
          },
          assert: async () => {
            await ctx.expectRoute(`${workspaceRoute}/session`, { timeoutMs: 10_000 });
            await ctx.expectText("Codex Remote Worker");
            await ctx.expectText("Connected. No tasks found on this remote workspace.");
          },
          screenshot: {
            name: "remote-worker-connected",
            requireText: ["Codex Remote Worker", "Connected. No tasks found on this remote workspace."],
          },
        });
      },
    },
    {
      name: "Codex Server runtime is selected",
      run: async (ctx) => {
        await ctx.prove("The remote worker exposes Codex Server as an experimental runtime alongside OpenCode", {
          voiceover: vo[1],
          action: async () => {
            await ctx.control("route.settings.providers");
            await ctx.expectRoute(`${workspaceRoute}/settings/ai`, { timeoutMs: 10_000 });
            await ctx.waitFor(`(() => {
              const button = Array.from(document.querySelectorAll("button"))
                .find((candidate) => (candidate.textContent || "").includes("Codex Server"));
              return Boolean(button && !button.disabled);
            })()`, { timeoutMs: 40_000, label: "Codex runtime card enabled after worker status" });
            if (!(await ctx.hasText("Codex on remote worker"))) {
              await ctx.clickText("Codex Server");
            }
            await ctx.waitForText("Codex on remote worker");
            await disconnectChatGptIfNeeded(ctx);
          },
          assert: async () => {
            await ctx.expectText("Agent runtime");
            await ctx.expectText("Experimental");
            await ctx.expectText("OpenCode");
            await ctx.expectText("Codex Server");
            await ctx.expectText("Healthy");
            await ctx.expectText("ChatGPT not connected");
          },
          screenshot: {
            name: "codex-runtime-selected",
            requireText: ["Agent runtime", "Experimental", "Codex Server", "Healthy"],
          },
        });
      },
    },
    {
      name: "ChatGPT device sign-in starts on the worker",
      run: async (ctx) => {
        await ctx.prove("OpenWork starts ChatGPT device-code authentication for the server-hosted Codex runtime", {
          voiceover: vo[2],
          action: async () => {
            // Keep the proof focused on OpenWork's device-code UI. Opening the
            // external OpenAI page adds a Cloudflare-heavy tab that can starve
            // CDP screenshots without changing the worker-side auth result.
            await ctx.eval("window.open = () => null; true");
            await ctx.clickText("Connect ChatGPT");
            await ctx.waitForText("OPEN-WORK", { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText("Finish signing in to ChatGPT");
            await ctx.expectText("OPEN-WORK");
            await ctx.expectText("Credentials stay on the worker.");
            await ctx.expectText("Waiting for ChatGPT authorization");
          },
          screenshot: {
            name: "chatgpt-device-code",
            requireText: ["Finish signing in to ChatGPT", "OPEN-WORK", "Credentials stay on the worker."],
          },
        });
      },
    },
    {
      name: "ChatGPT account is connected remotely",
      run: async (ctx) => {
        await ctx.prove("The worker reports the ChatGPT subscription and Codex provider as connected", {
          voiceover: vo[3],
          action: async () => {
            await ctx.waitForText("ChatGPT connected · server@example.test", { timeoutMs: 30_000 });
            await ctx.waitForText("1 provider connected", { timeoutMs: 15_000 });
          },
          assert: async () => {
            await ctx.expectText("Codex on remote worker");
            await ctx.expectText("ChatGPT connected · server@example.test");
            await ctx.expectText("1 provider connected");
            await ctx.expectText("Codex (ChatGPT)");
          },
          screenshot: {
            name: "chatgpt-connected-on-worker",
            requireText: ["ChatGPT connected · server@example.test", "1 provider connected", "Codex (ChatGPT)"],
          },
        });
      },
    },
    {
      name: "Codex starts the task on the server",
      run: async (ctx) => {
        await ctx.prove("A new OpenWork task reaches Codex and surfaces its remote command approval", {
          voiceover: vo[4],
          action: async () => {
            await ctx.control("route.session");
            await dismissUnavailableModelPicker(ctx);
            await ctx.waitForText("What do you need done?", { timeoutMs: 20_000 });
            await ctx.control("session.create_task");
            await ctx.expectRoute(`${workspaceRoute}/session/thread_remote_1`, { timeoutMs: 20_000 });
            await ctx.eval("location.reload()");
            await new Promise((resolve) => setTimeout(resolve, 750));
            await ctx.reconnect({ timeoutMs: 30_000 });
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 30_000,
              label: "OpenWork control API for the remote task",
            });
            await ctx.waitFor(`window.__openworkControl.listActions()
              .some((candidate) => candidate.id === "composer.set_text" && !candidate.disabled)`, {
              timeoutMs: 20_000,
              label: "session composer available",
            });
            await ctx.control("composer.set_text", { text: TASK_PROMPT });
            await ctx.waitFor(`window.__openworkControl.listActions()
              .some((candidate) => candidate.id === "composer.send" && !candidate.disabled)`, {
              timeoutMs: 10_000,
              label: "session composer send enabled",
            });
            await ctx.control("composer.send");
            await ctx.waitForText("Approve command.execute?", { timeoutMs: 20_000 });
          },
          assert: async () => {
            await ctx.expectRoute(`${workspaceRoute}/session/thread_remote_1`, { timeoutMs: 20_000 });
            await ctx.expectText(TASK_PROMPT);
            await ctx.expectText("hostname");
            await ctx.expectText("Allow once");
          },
          screenshot: {
            name: "remote-command-awaits-approval",
            requireText: [TASK_PROMPT, "hostname", "Allow once"],
          },
        });
      },
    },
    {
      name: "Permission continues the remote turn",
      run: async (ctx) => {
        await ctx.prove("Approving the Codex command in OpenWork lets the remote turn finish with its file change", {
          voiceover: vo[5],
          action: async () => {
            await ctx.clickText("Allow once");
            await ctx.waitForText(FINAL_ANSWER, { timeoutMs: 20_000 });
          },
          assert: async () => {
            await ctx.expectText(FINAL_ANSWER);
            await ctx.expectText("server-proof.md");
            await ctx.expectNoText("Approve command.execute?");
          },
          screenshot: {
            name: "remote-turn-completed",
            requireText: [FINAL_ANSWER, "server-proof.md"],
            rejectText: ["Approve command.execute?"],
          },
        });
      },
    },
    {
      name: "Conversation and server file survive a new client load",
      run: async (ctx) => {
        await ctx.prove("Reloading the client restores the same remote conversation and opens the file created on the worker", {
          voiceover: vo[6],
          action: async () => {
            await ctx.eval("location.reload()");
            await new Promise((resolve) => setTimeout(resolve, 750));
            await ctx.reconnect({ timeoutMs: 30_000 });
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 30_000,
              label: "OpenWork control API after reload",
            });
            await ctx.waitForText(FINAL_ANSWER, { timeoutMs: 30_000 });
            await ctx.clickText("server-proof.md", { selector: "button" });
            await ctx.waitForText("created on the remote worker", { timeoutMs: 20_000 });
          },
          assert: async () => {
            await ctx.expectRoute(`${workspaceRoute}/session/thread_remote_1`, { timeoutMs: 20_000 });
            await ctx.expectText(FINAL_ANSWER);
            await ctx.expectText("created on the remote worker");
          },
          screenshot: {
            name: "remote-history-and-file-restored",
            requireText: [FINAL_ANSWER, "created on the remote worker"],
          },
        });
      },
    },
    {
      name: "Diagnostics prove the process lives on the worker",
      run: async (ctx) => {
        await ctx.prove("Runtime diagnostics show a healthy private stdio app-server on the remote worker", {
          voiceover: vo[7],
          action: async () => {
            await ctx.control("route.settings.providers");
            await ctx.waitForText("Codex on remote worker", { timeoutMs: 20_000 });
          },
          assert: async () => {
            await ctx.expectRoute(`${workspaceRoute}/settings/ai`, { timeoutMs: 10_000 });
            await ctx.expectText("Healthy");
            await ctx.expectText("Runtime: Codex app-server");
            await ctx.expectText("Location: Remote worker");
            await ctx.expectText("Transport: stdio (private)");
            await ctx.expectText("Public control port: None");
          },
          screenshot: {
            name: "worker-runtime-diagnostics",
            requireText: ["Healthy", "Location: Remote worker", "Transport: stdio (private)", "Public control port: None"],
          },
        });
      },
    },
  ],
});
