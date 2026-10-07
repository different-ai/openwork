import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";

/**
 * A person asks a real research question in an ordinary workspace. The scripted
 * model follows the shape recorded from live v1/v2 sessions: one user message,
 * then several model steps (read a file, run a slow command, hand work to a
 * helper agent whose own step takes a while), a short private thought, and the
 * answer. Tool names follow each engine: v1 `bash`/`task`, v2 `shell`/`subagent`.
 */
export async function agentVisibility(seed: Seed) {
  const engine = resolveEvalEngine();
  const dir = seed.tmpPath("agent-visibility");
  await mkdir(dir, { recursive: true });
  const workspacePath = await realpath(dir);
  const notesPath = join(workspacePath, "support-notes.md");
  await writeFile(notesPath, [
    "# Support notes",
    "",
    "- \"I can't tell if the agent is still working.\"",
    "- \"The helper agent vanished, how do I get back to it?\"",
    "- \"Working disappears, then comes back.\"",
    "",
  ].join("\n"));

  const casesPath = join(workspacePath, "activity-cases.md");
  const reproductionPath = join(workspacePath, "reproduction.md");
  await writeFile(casesPath, "Case: a slow command hands its result to a helper.\n");
  await writeFile(reproductionPath, "Reproduce: keep the current work visible until its answer arrives.\n");
  const providerId = "visibility-mock";
  const modelId = "visibility-model";
  const prompt = "Why do people say they can't tell when agents are running? Read our support notes, check the logs, and get a helper to look at the error log.";
  const helperMarker = "Look through the error log and list anything about agents disappearing.";
  const answer = "People lose track of agents because the working line disappears between steps and the helper has no way back.";
  const reasoning = "The notes and the helper agree, so I can answer.";
  const helperAnswer = "Two log lines mention the helper row disappearing.";
  const shell = engine === "v2" ? "shell" : "bash";
  const followUp = "Also check whether the billing page has the same problem.";

  const app = await seed.appWeb({ name: "agent-visibility", workspacePath, mocks: {
    agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
      promptMarker: prompt,
      latestUserTurn: true,
      finalReasoning: reasoning,
      finalReply: answer,
      finalReplyChunks: [answer],
      finalReplyInitiallyReleasedChunks: 0,
      steps: [
        { tool: "read", arguments: { filePath: notesPath, path: notesPath } },
        { tool: "read", arguments: { filePath: casesPath, path: casesPath } },
        { tool: "read", arguments: { filePath: reproductionPath, path: reproductionPath } },
        { tool: shell, arguments: {
          command: "sleep 4 && echo '3 sessions show the helper row disappearing'",
          description: "Check the app logs",
          timeout: 60_000,
        } },
        { tool: engine === "v2" ? "subagent" : "task", arguments: {
          description: "Check the error log",
          prompt: helperMarker,
          ...(engine === "v2" ? { agent: "general", background: false } : { subagent_type: "general" }),
        } },
      ],
    }, {
      promptMarker: helperMarker,
      latestUserTurn: true,
      finalReply: helperAnswer,
      finalReplyChunks: [helperAnswer],
      finalReplyInitiallyReleasedChunks: 0,
      steps: [{ tool: shell, arguments: {
        command: "sleep 2 && echo 'helper row disappeared x2'",
        description: "Search the error log",
        timeout: 60_000,
      } }],
    }, {
      // Only answers if a follow-up actually reaches the model.
      promptMarker: followUp,
      latestUserTurn: true,
      finalReply: "The billing page looks fine.",
      steps: [],
    }] }),
  } });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("Missing visibility model witness");
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { bash: "allow", read: "allow", task: "allow" },
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Visibility mock",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-visibility-fixture" },
      models: { [modelId]: { name: "Visibility model", reasoning: true } },
    } },
  }, engine);
  const session = await seed.session(app, { title: "Agent visibility" });
  const releaseWhenAsked = async (marker: string) => {
    const deadline = Date.now() + 90_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        return await mock.releaseAgentReply(marker);
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`The model never asked for the held reply: ${String(lastError)}`);
  };

  return {
    app, workspace, session, engine, shell, prompt, answer, reasoning, helperAnswer, followUp,
    requests: () => mock.agentRequests({ promptMarker: prompt }),
    helperRequests: () => mock.agentRequests({ promptMarker: helperMarker }),
    followUpRequests: () => mock.agentRequests({ promptMarker: followUp }),
    // A held reply can only be released once the model has actually asked for it;
    // until then the mock answers 404, so keep trying for a bounded time.
    releaseHelper: () => releaseWhenAsked(helperMarker),
    releaseAnswer: () => releaseWhenAsked(prompt),
  };
}
