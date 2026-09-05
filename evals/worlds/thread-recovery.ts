import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Place, Seed } from "@openwork/env";
import { seedSessions } from "@openwork/behaviors";
import { arrangeControl, configureProvider } from "./chat.ts";

function recordValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

export const suspendedTurnPrompt = "Continue the deterministic task that spans a laptop sleep.";
export const suspendedTurnReply = "The task finished after the computer resumed.";
export const stoppedTurnPrompt = "Start another task while I review the result.";
export const stoppedTurnReply = "The second task finished.";

/**
 * A model whose first answer goes quiet after its opening chunk and never
 * ends — what a half-open socket looks like after the machine slept — and
 * whose later answers complete. The witness records every completion so a
 * spec can prove the engine re-asked once rather than duplicating work.
 */
export async function suspendedTurn(seed: Seed, { place }: { place: Place }) {
  const modelId = "suspended-turn-model";
  const boot = seed.mock({
    agentWorkloads: [{
      promptMarker: suspendedTurnPrompt,
      finalReply: suspendedTurnReply,
      quietCompletions: 1,
      steps: [{
        tool: "bash",
        arguments: {
          command: "printf '%s\\n' 'suspended-turn-resumed'",
          timeout: 30_000,
          description: "Acknowledge the resumed turn",
        },
      }],
    }, {
      promptMarker: stoppedTurnPrompt,
      finalReply: stoppedTurnReply,
      quietCompletions: 1,
      steps: [],
    }],
  });
  const { handle: agent } = await boot.boot(place);
  try {
    await place.exposeMock(agent);
    const providerId = "lpr_suspended_turn";
    const root = seed.tmpPath("suspended-turn");
    await mkdir(root, { recursive: true });
    // This provider is a project fixture, not a synchronized Cloud import.
    // Keep it on disk so runtime-provider cleanup cannot remove the witness.
    await writeFile(join(root, "opencode.jsonc"), JSON.stringify({
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Sleep recovery model",
          options: { baseURL: `${agent.url}/v1`, apiKey: "sk-suspended-turn-test-only" },
          models: { [modelId]: { name: "Sleep recovery model" } },
        },
      },
    }));
    const app = await seed.desktop({ model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, root);
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {});
    const [session, stoppedSession] = await seedSessions(app, ["Suspended turn", "Stopped turn"]);
    if (!session || !stoppedSession) throw new Error("Recovery sessions were not created");
    const startedAt = new Date().toISOString();
    // Arrange existing in-flight tasks through the real engine. This isolates
    // resume and Stop behavior from the Cloud sign-in/model-picker journey.
    // TODO(primitive): seed a running turn with an explicit provider and model.
    const statuses = await seed.evalIn(app, `async (workspaceId, providerId, modelId, turnsJson) => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      return Promise.all(JSON.parse(turnsJson).map(async ({ sessionId, prompt }) => {
        const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/session/" + sessionId + "/prompt_async", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ model: { providerID: providerId, modelID: modelId }, parts: [{ type: "text", text: prompt }] }),
        });
        return response.status;
      }));
    }`, { args: [workspace.workspaceId, providerId, modelId, JSON.stringify([
      { sessionId: session.sessionId, prompt: suspendedTurnPrompt },
      { sessionId: stoppedSession.sessionId, prompt: stoppedTurnPrompt },
    ])], awaitPromise: true, timeoutMs: 60_000 });
    if (!Array.isArray(statuses) || statuses.length !== 2 || statuses.some((status) => status !== 204)) {
      throw new Error(`Recovery turn setup failed: ${JSON.stringify(statuses)}`);
    }
    await arrangeControl(seed, app, "session.open", { sessionId: stoppedSession.sessionId });
    return {
      [Symbol.asyncDispose]: () => agent.stop(),
      app,
      workspace,
      session,
      /** Kinds of every main completion for this turn, in order. */
      async completionKinds(promptMarker = suspendedTurnPrompt): Promise<string[]> {
        const requests = await agent.agentRequests({ promptMarker, sinceIso: startedAt });
        return requests.filter((request) => request.kind !== "utility").map((request) => request.kind);
      },
      /**
       * Stop the engine process for `ms` and let it continue: from the engine's
       * point of view this is the lid closing and opening again.
       */
      async suspendEngine(ms: number): Promise<void> {
        // TODO(primitive): read the managed engine process id from the desktop runtime.
        const info = await seed.evalIn(app, `window.__OPENWORK_ELECTRON__.invokeDesktop("engineInfo")`, { awaitPromise: true, timeoutMs: 30_000 });
        const pid = recordValue(info, "pid");
        if (typeof pid !== "number") throw new Error(`Engine pid unavailable: ${JSON.stringify(info)}`);
        process.kill(pid, "SIGSTOP");
        try {
          await new Promise((resolveWait) => setTimeout(resolveWait, ms));
        } finally {
          process.kill(pid, "SIGCONT");
        }
      },
      async transcriptFacts(): Promise<{ prompts: number; replies: number; interruptedCards: number; working: boolean }> {
        // TODO(primitive): count transcript occurrences and interrupted-run cards.
        const facts = await seed.evalIn(app, `(prompt, reply) => {
          const text = document.body.innerText;
          return {
            prompts: text.split(prompt).length - 1,
            replies: text.split(reply).length - 1,
            working: /Working [0-9]/.test(text),
            interruptedCards: document.querySelectorAll('[data-testid="session-error-interrupted"]').length,
          };
        }`, { args: [suspendedTurnPrompt, suspendedTurnReply] });
        const working = recordValue(facts, "working");
        const prompts = recordValue(facts, "prompts");
        const replies = recordValue(facts, "replies");
        const interruptedCards = recordValue(facts, "interruptedCards");
        if (typeof working !== "boolean" || typeof prompts !== "number" || typeof replies !== "number" || typeof interruptedCards !== "number") {
          throw new Error(`Transcript facts were invalid: ${JSON.stringify(facts)}`);
        }
        return { prompts, replies, interruptedCards, working };
      },
    };
  } catch (error) {
    await agent.stop();
    throw error;
  }
}

export const authenticatedConnectPrompt = "Find my connected apps using Connect.";
export const authenticatedConnectReply = "Connect is working with my signed-in model.";

/** A real provider auth.loader must supply the transport before Connect can run. */
export async function authenticatedConnect(seed: Seed, { place }: { place: Place }) {
  const providerId = "authenticated-connect-witness";
  const modelId = "authenticated-connect-model";
  const { handle: agent } = await seed.mock({
    allowUnauthenticatedMcp: true,
    agentRequiredHeader: { name: "x-witness-auth", value: "loaded" },
    tools: [{
      name: "search_capabilities",
      description: "Find connected apps.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      result: { content: [{ type: "text", text: "Connected apps are available." }] },
    }],
    agentWorkloads: [{
      promptMarker: authenticatedConnectPrompt,
      finalReply: authenticatedConnectReply,
      steps: [{ tool: "openwork-cloud_search_capabilities", arguments: { query: "connected apps" } }],
    }],
  }).boot(place);
  try {
    await place.exposeMock(agent);
    const root = seed.tmpPath("authenticated-connect");
    await mkdir(root, { recursive: true });
    const pluginPath = join(root, "provider-auth.js");
    await writeFile(pluginPath, `export const WitnessAuth = async () => ({
      auth: {
        provider: ${JSON.stringify(providerId)},
        methods: [{ type: "api", label: "Witness credentials" }],
        loader: async () => ({
          apiKey: "test-only",
          fetch: async (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set("x-witness-auth", "loaded");
            return fetch(input, { ...init, headers });
          },
        }),
      },
    });\n`);
    const app = await seed.desktop({ name: "authenticated-connect", model: `${providerId}/${modelId}` });
    const workspace = await seed.workspace(app, root);
    // TODO(primitive): install a synthetic provider credential in the isolated engine profile.
    const status = await seed.evalIn(app, `async (workspaceId, providerId) => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/auth/" + providerId, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ type: "api", key: "test-only" }),
      });
      return response.status;
    }`, { args: [workspace.workspaceId, providerId], awaitPromise: true, timeoutMs: 60_000 });
    if (status !== 200) throw new Error(`Witness credential setup failed: ${String(status)}`);
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      plugin: [pluginPath],
      permission: { "openwork-cloud_*": "allow" },
      mcp: { "openwork-cloud": { type: "remote", url: agent.mcpUrl, enabled: true, oauth: false } },
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Authenticated Connect witness",
          options: { baseURL: `${agent.url}/v1`, apiKey: "test-only" },
          models: { [modelId]: { name: "Authenticated Connect model" } },
        },
      },
    });
    const [session] = await seedSessions(app, ["Authenticated model uses Connect"]);
    if (!session) throw new Error("Authenticated Connect session was not created");
    await arrangeControl(seed, app, "session.open", { sessionId: session.sessionId });
    return {
      app, workspace, session,
      async completionKinds() {
        return (await agent.agentRequests({ promptMarker: authenticatedConnectPrompt }))
          .filter((request) => request.kind !== "utility").map((request) => request.kind);
      },
      async connectCalls() { return agent.toolCalls({ name: "search_capabilities" }); },
      [Symbol.asyncDispose]: () => agent.stop(),
    };
  } catch (error) {
    await agent.stop();
    throw error;
  }
}

