import { clickButton, denFetch, waitFor } from "@openwork/behaviors";
import { connect, debuggerUrlFor, evaluate, listTargets } from "@openwork/cdp";
import { provider } from "../ctx.ts";
import { inPage } from "../inpage.ts";
import { DOCS_APP, DOCS_MEMBER, DOCS_PROMPT_CARDS, org } from "../seed.ts";
import { desktop } from "../surfaces.ts";
import type { DesktopShotSurface } from "../surfaces.ts";
import { dismissOverlays, fillForm, keepExpanded } from "../steps.ts";
import { startModelWitness } from "../witness.ts";
import type { ScriptedChunk } from "../witness.ts";
import { shot } from "./shot.ts";

const WITNESS_PROVIDER_ID = "docs-shots-provider";
const WITNESS_MODEL_ID = "docs-shots-model";
const CHAT_PLUGIN_NAME = "Call Prep";
const CHAT_SKILL_NAME = "call-prep";
const CHAT_SKILL_DESCRIPTION = "Prepare a call brief whenever you ask to prep a call.";
const CHAT_CLOSING_REPLY = "The call-prep skill is saved to your Library and ready to use.";
const resourceUri = "ui://openwork/skill-created/v1/view.html";
const composerMessage = "Turn what we just did into a reusable skill for me";
const ORGANIZATION_PROMPT_INTRO = "Try one of your organization's prompts:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function projectedCreateSkillTool(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.tools)) return null;
  for (const tool of payload.tools) {
    if (!isRecord(tool) || !isRecord(tool.function)) continue;
    const name = tool.function.name;
    if (typeof name === "string" && name.endsWith("_create_skill")) return name;
  }
  return null;
}

function completedToolCount(payload: Record<string, unknown>): number {
  return Array.isArray(payload.messages)
    ? payload.messages.filter((message) => isRecord(message) && message.role === "tool").length
    : 0;
}

function chatSceneScript(payload: Record<string, unknown>): readonly ScriptedChunk[] {
  const toolName = completedToolCount(payload) === 0 ? projectedCreateSkillTool(payload) : null;
  if (!toolName) {
    return [
      { delta: { role: "assistant" } },
      { delta: { content: CHAT_CLOSING_REPLY } },
      { delta: {}, finishReason: "stop" },
    ];
  }
  return [
    { delta: { role: "assistant" } },
    {
      delta: {
        tool_calls: [{
          index: 0,
          id: "call_create_call_prep",
          type: "function",
          function: {
            name: toolName,
            arguments: JSON.stringify({
              pluginName: CHAT_PLUGIN_NAME,
              skillMarkdown: [
                "---",
                `name: ${CHAT_SKILL_NAME}`,
                `description: ${CHAT_SKILL_DESCRIPTION}`,
                "---",
                "",
                "Whenever the user asks to prep a call, build a one-page brief with goals, context, and questions.",
              ].join("\n"),
            }),
          },
        }],
      },
    },
    { delta: {}, finishReason: "tool_calls" },
  ];
}

const model = provider(async (ctx) => {
  const witness = await startModelWitness({
    providerId: WITNESS_PROVIDER_ID,
    modelId: WITNESS_MODEL_ID,
    script: chatSceneScript,
  });
  ctx.onDispose(witness.close);
  return witness;
});

const app = desktop({
  org,
  app: DOCS_APP,
  model,
});

async function openEmptyTeamPromptSession(surface: DesktopShotSurface): Promise<void> {
  const member = surface.organization.den.members[DOCS_MEMBER];
  if (!member) throw new Error("The docs member was not provisioned.");
  const config = await denFetch(member, "/v1/me/desktop-config", {
    headers: {
      authorization: `Bearer ${member.token}`,
      "x-openwork-org-id": surface.organization.orgId,
    },
  });
  const expectedPrompts = DOCS_PROMPT_CARDS.map((card) => card.prompt);
  const expectedTitles = DOCS_PROMPT_CARDS.map((card) => card.title);
  const actualPrompts = isRecord(config.body) && Array.isArray(config.body.onboardingPrompts)
    ? config.body.onboardingPrompts
    : [];
  const actualTitles = isRecord(config.body) && Array.isArray(config.body.onboardingPromptDescriptions)
    ? config.body.onboardingPromptDescriptions
    : [];
  if (!config.response.ok
    || JSON.stringify(actualPrompts) !== JSON.stringify(expectedPrompts)
    || JSON.stringify(actualTitles) !== JSON.stringify(expectedTitles)) {
    throw new Error(`The docs member did not receive the seeded prompt policy: HTTP ${config.response.status} ${config.text.slice(0, 600)}`);
  }
  const titlesVisible = expectedTitles
    .map((title) => `document.body.innerText.includes(${JSON.stringify(title)})`)
    .join(" && ");
  await waitFor(surface, titlesVisible, {
    timeoutMs: 60_000,
    label: "organization prompt config settled",
  });
  const task = await inPage(surface, `async () => {
    const deadline = Date.now() + 60000;
    let last = null;
    while (Date.now() < deadline) {
      last = await window.__openworkControl.execute("session.create_task", null);
      if (last?.ok === true) return last;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return last;
  }`, {}, { awaitPromise: true, timeoutMs: 70_000 });
  if (!isRecord(task) || task.ok !== true) throw new Error(`Creating an empty prompt-card session failed: ${JSON.stringify(task)}`);
  await waitFor(surface, `document.body.innerText.includes(${JSON.stringify(ORGANIZATION_PROMPT_INTRO)}) && ${titlesVisible}`, {
    timeoutMs: 60_000,
    label: "member-facing organization prompt cards",
  });
  await inPage(surface, `() => {
    const label = [...document.querySelectorAll("span")]
      .find((element) => (element.textContent ?? "").trim() === "Notifications");
    const item = label?.closest("a, button");
    const badge = item && [...item.querySelectorAll("span")]
      .find((element) => (element.textContent ?? "").trim() === "1");
    if (badge instanceof HTMLElement) badge.style.display = "none";
    const account = document.querySelector('[data-testid="account-status-menu"]');
    const status = account && [...account.children]
      .find((element) => element instanceof HTMLElement && element.classList.contains("size-4"));
    if (status instanceof HTMLElement) status.style.display = "none";
    return true;
  }`, {});
}

export const desktopTeamPromptCards = shot("desktop-team-prompt-cards", {
  use: app,
  at: (surface) => `/workspace/${surface.workspaceId}`,
  steps: [dismissOverlays, openEmptyTeamPromptSession],
  expect: [
    ORGANIZATION_PROMPT_INTRO,
    ...DOCS_PROMPT_CARDS.map((card) => card.title),
  ],
  never: ["What do you need done?", "Opening session…", "Summarize my week", "Connect a model provider"],
  out: "packages/docs/images/desktop-team-prompt-cards.png",
});

const skillForm = fillForm({
  'input[placeholder="e.g. customer-research"]': "call-brief",
  'input[placeholder="When should an agent use this skill?"]': "Prepare a one-page brief before a customer call.",
  'textarea[placeholder^="# Instructions"]': "# Instructions\n\n1. Pull the account's recent activity.\n2. Summarize the goal of the call in two sentences.\n3. List the three questions to ask.",
});

const showAdvancedSettings = keepExpanded("Advanced settings", "Add workspace MCP");

async function scrollAdvancedSettingsIntoView(surface: DesktopShotSurface): Promise<void> {
  await inPage(surface, `() => {
    document.querySelector("[data-inventory-group]")?.scrollIntoView({ block: "start" });
    const toggle = [...document.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").includes("Advanced settings"));
    toggle?.scrollIntoView({ block: "center" });
    return true;
  }`, {});
}

export const librarySkills = shot("library-skills", {
  use: app,
  at: (surface) => `/workspace/${surface.workspaceId}/extensions/skills`,
  steps: [dismissOverlays],
  expect: ["Library", "Add skill", "customer-research"],
  never: ["Your library is empty."],
  route: /\/extensions\/skills$/,
  out: "packages/docs/images/library-skills-add-skill.png",
});

export const libraryCreateSkillModal = shot("library-create-skill-modal", {
  use: app,
  at: (surface) => `/workspace/${surface.workspaceId}/extensions/skills`,
  steps: [dismissOverlays, (surface) => clickButton(surface, "Add skill", { timeoutMs: 120_000 }), skillForm],
  expect: ["Create a skill", "Name", "Description", "Create skill"],
  never: ["Sign in to OpenWork Cloud"],
  viewport: { width: 1440, height: 1000, deviceScaleFactor: 2 },
  out: "packages/docs/images/library-create-skill-modal.png",
});

export const libraryAdvancedSettings = shot("library-advanced-settings", {
  use: app,
  at: (surface) => `/workspace/${surface.workspaceId}/settings/extensions`,
  steps: [dismissOverlays, showAdvancedSettings, scrollAdvancedSettingsIntoView],
  expect: ["Advanced settings", "Add workspace MCP"],
  never: ["Your library is empty."],
  out: "packages/docs/images/library-advanced-settings.png",
});

export const libraryAddMcpModal = shot("library-add-mcp-modal", {
  use: app,
  at: (surface) => `/workspace/${surface.workspaceId}/settings/extensions`,
  steps: [dismissOverlays, showAdvancedSettings, (surface) => clickButton(surface, "Add workspace MCP", { timeoutMs: 30_000 })],
  expect: ["Add workspace MCP", "App name", "Server URL", "Add App"],
  out: "packages/docs/images/library-add-mcp-modal.png",
});

async function waitForMountedSkillCard(surface: DesktopShotSurface, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    const targets = await listTargets(surface.handle.cdpUrl);
    const sandbox = targets.find((target) => target.type === "iframe"
      && target.url.includes("/mcp-apps/sandbox.html")
      && target.webSocketDebuggerUrl);
    if (sandbox) {
      const client = await connect(debuggerUrlFor(surface.handle.cdpUrl, sandbox));
      try {
        const text = await evaluate(client, `document.querySelector("iframe")?.contentDocument?.body?.innerText ?? ""`);
        if (typeof text === "string") {
          lastText = text;
          const normalized = text.toLocaleLowerCase();
          if (normalized.includes("skill created") && normalized.includes(CHAT_SKILL_NAME)) return;
        }
      } finally {
        client.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The skill-created card did not mount with its content. Last iframe text:\n${lastText.slice(0, 600)}`);
}

async function createSkillFromChat(surface: DesktopShotSurface): Promise<void> {
  const reconciled = await inPage(surface, `async (args) => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(args.workspaceId) + "/mcp/openwork-cloud/reconcile", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          type: "remote",
          url: args.mcpUrl,
          enabled: true,
          headers: { Authorization: "Bearer " + args.mcpToken },
          oauth: false,
        },
        provider: args.providerId,
        model: args.modelId,
        trigger: "docs-shots",
      }),
    });
    const text = await response.text();
    if (!response.ok) return "Cloud MCP reconcile failed: " + response.status + " " + text.slice(0, 1000);
    const health = JSON.parse(text);
    if (health?.phase !== "ready") return "Cloud MCP reconcile was not ready: " + JSON.stringify(health).slice(0, 1000);
    return "ok";
  }`, {
    workspaceId: surface.workspaceId,
    mcpUrl: `${surface.organization.den.ref.apiUrl}/mcp/agent`,
    mcpToken: surface.organization.mcpToken,
    providerId: surface.model.providerId,
    modelId: surface.model.modelId,
  }, { awaitPromise: true, timeoutMs: 90_000 });
  if (reconciled !== "ok") throw new Error(`Connecting the Cloud MCP failed: ${String(reconciled)}`);

  const task = await inPage(surface, `async () => {
    const deadline = Date.now() + 60000;
    let last = null;
    while (Date.now() < deadline) {
      last = await window.__openworkControl.execute("session.create_task", null);
      if (last?.ok === true) return last;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return last;
  }`, {}, { awaitPromise: true, timeoutMs: 70_000 });
  if (!isRecord(task) || task.ok !== true) throw new Error(`Creating a task failed: ${JSON.stringify(task)}`);
  await waitFor(surface, `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'))`, {
    timeoutMs: 30_000,
    label: "composer ready",
  });
  const focused = await inPage(surface, `() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return true;
  }`, {});
  if (focused !== true) throw new Error("Focusing the composer failed.");
  await surface.client.send("Input.insertText", { text: composerMessage });
  await clickButton(surface, "Run task", { timeoutMs: 30_000 });
  await waitFor(surface, `document.body.innerText.includes(${JSON.stringify(CHAT_CLOSING_REPLY)})`, {
    timeoutMs: 180_000,
    label: "closing reply",
  });
  await waitFor(surface, `Boolean(document.querySelector(${JSON.stringify(`[data-mcp-app-resource="${resourceUri}"] iframe`)}))`, {
    timeoutMs: 60_000,
    label: "skill-created MCP App frame",
  });
  await waitForMountedSkillCard(surface, 60_000);
  await waitFor(surface, `!document.body.innerText.includes("Pulling in the latest messages")`, {
    timeoutMs: 60_000,
    label: "session sync settled",
  });
  await inPage(surface, `(args) => {
    document.querySelector('[data-mcp-app-resource="' + args.resourceUri + '"]')?.scrollIntoView({ block: "center" });
    return true;
  }`, { resourceUri });
}

export const skillCreatedCard = shot("skill-created-card", {
  use: app,
  at: (surface) => `/workspace/${surface.workspaceId}`,
  steps: [createSkillFromChat],
  expect: [CHAT_CLOSING_REPLY],
  never: ["Interactive view unavailable", "MCP_APP_RESOURCE_NOT_FOUND"],
  out: "packages/docs/images/skill-created-mcp-app-card.png",
});
