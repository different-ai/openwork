import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * A member whose organization has the Feed (`settledSessions`) on, in the real
 * app in headless Chrome on OpenCode v2 (the Feed and settling ship for v2
 * only). Den, the local server, the engine and its pending questions are
 * real; only the model is a scripted witness, so one task asks
 * a question and one simply finishes.
 */
export async function calmFeed(seed: Seed) {
  const engine = "v2";
  const question = {
    title: "Pick the launch format",
    prompt: "CALM-QUESTION Help me pick the launch format",
    question: "Which launch format should we use?",
    answer: "Short video",
  };
  const resting = {
    title: "Summarize the launch notes",
    prompt: "CALM-REST Summarize the launch notes",
    reply: "The launch notes are summarized in three short points.",
  };
  const mock = seed.mock({
    isolatedProcessEnv: true,
    agentWorkloads: [
      {
        promptMarker: "CALM-QUESTION", latestUserTurn: true,
        finalReply: "Unused: the person answers the question.", finalReplyFrom: "last-tool-text",
        steps: [{ tool: "question", arguments: { questions: [{
          header: "Launch format", question: question.question,
          options: [
            { label: question.answer, description: "A one-minute video" },
            { label: "Blog post", description: "A written announcement" },
          ],
        }] } }],
      },
      { promptMarker: "CALM-REST", latestUserTurn: true, finalReply: resting.reply, steps: [] },
    ],
  });
  const { den, webPort } = await denForAppWeb(seed);
  await enableOrganizationCapabilities(seed, den.admin, { settledSessions: true });
  // The engine stores realpath'd roots (macOS /tmp is a symlink).
  const requested = seed.tmpPath("calm-feed");
  const workspacePath = join(realpathSync(dirname(requested)), basename(requested));
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, engine, name: "calm-feed", workspacePath, mocks: { agent: mock },
  });
  const agentMock = app.mocks.agent;
  if (!agentMock) throw new Error("The app-web fixture did not boot the Calm Feed model witness.");
  const providerId = "calm-feed-witness";
  const modelId = "calm-feed-model";
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { question: "allow" },
    provider: { [providerId]: {
      npm: "@ai-sdk/openai-compatible", name: "Calm Feed witness",
      options: { baseURL: `${agentMock.url}/v1`, apiKey: "sk-calm-feed" },
      models: { [modelId]: { name: "Calm Feed witness" } },
    } },
  }, engine);
  const session = async (title: string) => {
    const deadline = Date.now() + 60_000;
    let last: unknown = null;
    while (Date.now() < deadline) {
      try { return await seed.session(app, { title }); } catch (error) { last = error; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Session ${title} was not created: ${last instanceof Error ? last.message : String(last)}`);
  };
  const questionSession = await session(question.title);
  const restingSession = await session(resting.title);
  // The app picks Command on macOS and Control elsewhere; the browser runs on this host.
  const shortcutModifier = process.platform === "darwin"
    ? { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, modifiers: 4, label: "Command" }
    : { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2, label: "Control" };
  const { label, ...keyEvent } = shortcutModifier;
  return {
    app, workspace, engine, mock: agentMock,
    question: { ...question, ...questionSession },
    resting: { ...resting, ...restingSession },
    shortcutModifierLabel: label,
    // TODO(primitive): hold a key as trusted input. `user.press` always releases
    // at once, but the session shortcuts appear only while the modifier is held.
    holdShortcutModifier: () => app.client.send("Input.dispatchKeyEvent", { type: "keyDown", ...keyEvent }),
    releaseShortcutModifier: () => app.client.send("Input.dispatchKeyEvent", { type: "keyUp", ...keyEvent, modifiers: 0 }),
  };
}
