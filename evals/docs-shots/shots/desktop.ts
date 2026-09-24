import { browserScript } from "@openwork/cdp";
import { clickButton, denFetch, waitFor } from "@openwork/behaviors";
import { provider } from "../ctx.ts";
import { inPage } from "../inpage.ts";
import { DOCS_APP, DOCS_MEMBER, DOCS_PROMPT_CARDS, org } from "../seed.ts";
import { desktop } from "../surfaces.ts";
import type { DesktopShotSurface } from "../surfaces.ts";
import { dismissOverlays, fillForm, keepExpanded } from "../steps.ts";
import { startModelWitness } from "../witness.ts";
import { shot } from "./shot.ts";

const WITNESS_PROVIDER_ID = "docs-shots-provider";
const WITNESS_MODEL_ID = "docs-shots-model";
const ORGANIZATION_PROMPT_INTRO = "Try one of your organization's prompts:";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const model = provider(async (ctx) => {
  const witness = await startModelWitness({
    providerId: WITNESS_PROVIDER_ID,
    modelId: WITNESS_MODEL_ID,
    script: () => { throw new Error("Desktop settings and empty prompt-card screenshots must not send model requests."); },
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
  const titlesVisible = browserScript((titles) => titles.every(title => document.body.innerText.includes(title)), [expectedTitles]);
  await waitFor(surface, titlesVisible, {
    timeoutMs: 60_000,
    label: "organization prompt config settled",
  });
  const task = await inPage(surface, async () => {
    const deadline = Date.now() + 60000;
    let last = null;
    while (Date.now() < deadline) {
      last = await window.__openworkControl.execute("session.create_task", null);
      if (last?.ok === true) return last;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return last;
  }, {}, { awaitPromise: true, timeoutMs: 70_000 });
  if (!isRecord(task) || task.ok !== true) throw new Error(`Creating an empty prompt-card session failed: ${JSON.stringify(task)}`);
  await waitFor(surface, browserScript((intro, titles) => document.body.innerText.includes(intro) && titles.every(title => document.body.innerText.includes(title)), [ORGANIZATION_PROMPT_INTRO, expectedTitles]), {
    timeoutMs: 60_000,
    label: "member-facing organization prompt cards",
  });
  await inPage(surface, () => {
    const label = [...document.querySelectorAll("span")]
      .find((element) => (element.textContent ?? "").trim() === "Notifications");
    const item = label?.closest("a, button");
    const badge = item && [...item.querySelectorAll("span")]
      .find((element) => (element.textContent ?? "").trim() === "1");
    if (badge instanceof HTMLElement) badge.style.display = "none";
    const account = document.querySelector<HTMLElement>('[data-testid="account-status-menu"]');
    const status = account && [...account.children]
      .find((element) => element instanceof HTMLElement && element.classList.contains("size-4"));
    if (status instanceof HTMLElement) status.style.display = "none";
    return true;
  }, {});
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
  await inPage(surface, () => {
    document.querySelector<HTMLElement>("[data-inventory-group]")?.scrollIntoView({ block: "start" });
    const toggle = [...document.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").includes("Advanced settings"));
    toggle?.scrollIntoView({ block: "center" });
    return true;
  }, {});
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
