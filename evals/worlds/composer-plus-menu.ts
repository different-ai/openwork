import { addInitScript, browserScript } from "@openwork/cdp";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configureProvider } from "./chat.ts";
import { startProviderWitnessProxy } from "./selected-skills.ts";

declare global {
  interface Window { __plusMenuFileStub?: { picked: string[] } }
}

type StagedFile = { name: string; text: string };

const skills = [
  {
    name: "customer-briefing",
    label: "Customer briefing",
    description: "Prepare a short account briefing.",
    body: "When preparing a briefing, include the exact phrase BRIEFING_BODY_4412. Keep it to three bullets.",
  },
  {
    name: "hubspot-deal-summary",
    label: "Hubspot deal summary",
    description: "Summarize open deals.",
    body: "Summarize deals and include the exact phrase DEAL_BODY_9031.",
  },
  {
    name: "slack-standup-digest",
    label: "Slack standup digest",
    description: "Digest standup threads.",
    body: "Digest standups and include the exact phrase STANDUP_BODY_2275.",
  },
] as const;

/** Files the stubbed system file chooser hands out, in order. The last is never picked. */
const stagedFiles: StagedFile[] = [
  { name: "quarterly-notes.txt", text: "Quarterly notes. The marker is NOTES_FILE_5521." },
  { name: "team-roster.txt", text: "Team roster for the example team. The marker is ROSTER_FILE_8830." },
  { name: "unpicked.txt", text: "This file is never attached. The marker is UNPICKED_FILE_6604." },
];

/**
 * The composer + menu in the real app (headless Chrome): workspace skills,
 * three workspace connectors served by the mock MCP, and a provider witness.
 * The OS file chooser cannot be driven, so a picked file is staged instead.
 */
export async function plusMenuWeb(seed: Seed) {
  const engine = resolveEvalEngine();
  const skillPrompt = "Prepare a short briefing for the example account.";
  const skillReply = "The briefing is ready.";
  const attachPrompt = "Summarize the attached files.";
  const attachReply = "Both files are summarized.";
  const workspacePath = seed.tmpPath("composer-plus-menu");
  for (const skill of skills) {
    const directory = join(workspacePath, ".opencode", "skills", skill.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}\n`);
  }
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [
    {
      promptMarker: skillPrompt, latestUserTurn: true, finalReply: skillReply,
      steps: engine === "v1" ? [{ tool: "skill", arguments: { name: skills[0].name } }] : [],
    },
    { promptMarker: attachPrompt, latestUserTurn: true, finalReply: attachReply, steps: [] },
  ] });
  const app = await seed.appWeb({ name: "composer-plus-menu", workspacePath, mocks: { agent: mock } });
  const witness = app.mocks.agent;
  if (!witness) throw new Error("Missing composer plus menu provider witness");
  const { port, providerRequests, dispose } = await startProviderWitnessProxy(witness.url);
  try {
    const stubFileChooser = (files: StagedFile[]) => {
      if (window.__plusMenuFileStub) return;
      const state = { picked: [] as string[] };
      window.__plusMenuFileStub = state;
      const originalClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function click(this: HTMLInputElement) {
        if (this.type !== "file") return originalClick.call(this);
        const next = files[Math.min(state.picked.length, files.length - 2)];
        if (!next) return undefined;
        state.picked.push(next.name);
        const transfer = new DataTransfer();
        transfer.items.add(new File([next.text], next.name, { type: "text/plain" }));
        this.files = transfer.files;
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return undefined;
      };
    };
    await addInitScript(app.client, browserScript(stubFileChooser, [stagedFiles]));
    const workspace = await seed.workspace(app, workspacePath);
    const providerId = "plus-menu-witness";
    const modelId = "plus-menu-model";
    const connector = { type: "remote", url: witness.mcpUrl, enabled: true, oauth: false };
    await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
      permission: { skill: "allow" },
      mcp: { HubSpot: connector, GitHub: connector, Linear: connector },
      provider: { [providerId]: {
        npm: "@ai-sdk/openai-compatible", name: "Plus menu witness",
        options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "synthetic-plus-menu-key" },
        models: { [modelId]: { name: "Plus menu witness", tool_call: true } },
      } },
    }, engine);
    await seed.evalIn(app, browserScript(stubFileChooser, [stagedFiles]));
    // Native catalog readiness is not renderer hydration: wait for the composer model.
    const ready = await seed.evalIn(app, async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (document.querySelector('[aria-label="Change model"]')?.textContent?.includes("Plus menu witness")) return true;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    }, { awaitPromise: true, timeoutMs: 35_000 });
    if (!ready) throw new Error("Plus menu composer did not hydrate the fixture model");
    const session = await seed.session(app, { title: "Composer plus menu" });
    return {
      app, workspace, session, engine,
      skills, stagedFiles, skillPrompt, skillReply, attachPrompt, attachReply,
      /** Everything the engine sent the model provider, serialized per request. */
      providerBodies: () => providerRequests.map((request) => JSON.stringify(request)),
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) { await dispose(); throw error; }
}
