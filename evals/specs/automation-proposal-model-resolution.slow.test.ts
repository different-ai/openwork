import { expect } from "vitest";
import { screenshot, validate } from "@openwork/fraimz";
import {
  denFetch,
  evalIn,
  go,
  readAvailableModels,
  selectModel,
  sendComposerMessage,
  visibleText,
  waitFor,
  waitForText,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { app, needs, server, test } from "@openwork/testkit";

const REQUEST_TIMEOUT_MS = 10_000;
const MODEL_TURN_TIMEOUT_MS = 5 * 60_000;
const PROVIDER_NAME = "DeepSeek Eval";
const PROVIDER_KEY = "deepseek";
const MODEL_ID = "deepseek-v4-flash";
const FALLBACK_NOTICE = "The proposed model isn't available for Automations, so runs use the free starter model.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

async function activeOrganizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: auth(session),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const activeId = isRecord(result.body) && typeof result.body.activeOrgId === "string"
    ? result.body.activeOrgId
    : "";
  const active = organizations.find((organization) => organization.isActive === true) ?? organizations[0];
  const orgId = activeId || (active && typeof active.id === "string" ? active.id : "");
  if (!result.response.ok || !orgId) {
    throw new Error(`Finding the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return orgId;
}

async function selectOrganization(session: DenSession, orgId: string): Promise<void> {
  const result = await denFetch(session, "/v1/me/active-organization", {
    method: "POST",
    headers: auth(session),
    body: JSON.stringify({ organizationId: orgId }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!result.response.ok) {
    throw new Error(`Selecting the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

async function createProvider(admin: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: {
      ...auth(admin),
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({
      name: PROVIDER_NAME,
      source: "custom",
      customConfig: {
        id: PROVIDER_KEY,
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        env: ["EVAL_PROVIDER_API_KEY"],
        models: [{ id: MODEL_ID, name: "DeepSeek V4 Flash" }],
      },
      allMembers: true,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(result.response.status).toBe(201);
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider)
    ? result.body.llmProvider
    : null;
  const providerId = provider && typeof provider.id === "string" ? provider.id : "";
  if (!providerId) throw new Error("The created LLM provider response did not include an id.");
  expect(providerId).toMatch(/^lpr_/);
  return providerId;
}

interface ProposalCardState {
  createdId: string;
  resolution: string;
  text: string;
}

async function waitForProposalCard(
  desktop: Surface,
  name: string,
  resolution: "mapped" | "fallback",
  created: boolean,
): Promise<ProposalCardState> {
  await waitFor(desktop, `(() => {
    const card = [...document.querySelectorAll('[data-openwork-automation-proposal]')]
      .find((candidate) => (candidate.textContent ?? '').includes(${JSON.stringify(name)}));
    if (!card || card.getAttribute('data-automation-model-resolution') !== ${JSON.stringify(resolution)}) return false;
    const createdId = card.getAttribute('data-automation-created') ?? '';
    return ${created ? "createdId.length > 0" : "createdId.length === 0"};
  })()`, {
    timeoutMs: created ? 120_000 : MODEL_TURN_TIMEOUT_MS,
    label: `${resolution} Automation proposal card ${created ? "created" : "ready"}`,
  });
  const value = await evalIn(desktop, `(() => {
    const card = [...document.querySelectorAll('[data-openwork-automation-proposal]')]
      .find((candidate) => (candidate.textContent ?? '').includes(${JSON.stringify(name)}));
    if (!card) return null;
    card.scrollIntoView({ block: 'center' });
    return {
      createdId: card.getAttribute('data-automation-created') ?? '',
      resolution: card.getAttribute('data-automation-model-resolution') ?? '',
      text: card.innerText ?? '',
    };
  })()`);
  if (!isRecord(value)) throw new Error(`Could not read the proposal card for ${name}.`);
  return {
    createdId: typeof value.createdId === "string" ? value.createdId : "",
    resolution: typeof value.resolution === "string" ? value.resolution : "",
    text: typeof value.text === "string" ? value.text : "",
  };
}

async function clickCreateAutomation(desktop: Surface, name: string): Promise<void> {
  await waitFor(desktop, `(() => {
    const card = [...document.querySelectorAll('[data-openwork-automation-proposal]')]
      .find((candidate) => (candidate.textContent ?? '').includes(${JSON.stringify(name)}));
    const button = card?.querySelector('[data-create-automation]');
    return button instanceof HTMLButtonElement && !button.disabled;
  })()`, { timeoutMs: 60_000, label: `enabled create button for ${name}` });
  const clicked = await evalIn(desktop, `(() => {
    const card = [...document.querySelectorAll('[data-openwork-automation-proposal]')]
      .find((candidate) => (candidate.textContent ?? '').includes(${JSON.stringify(name)}));
    const button = card?.querySelector('[data-create-automation]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
}

interface StoredAutomationModel {
  providerId: string;
  modelId: string;
}

async function storedAutomationModel(
  admin: DenSession,
  orgId: string,
  name: string,
): Promise<StoredAutomationModel> {
  const result = await denFetch(admin, "/v1/automations", {
    headers: {
      ...auth(admin),
      "x-openwork-org-id": orgId,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(result.response.status).toBe(200);
  const items = isRecord(result.body) && Array.isArray(result.body.items)
    ? result.body.items.filter(isRecord)
    : [];
  const item = items.find((candidate) =>
    isRecord(candidate.automation) && candidate.automation.name === name
  );
  const revision = item && isRecord(item.revision) ? item.revision : null;
  const model = revision && isRecord(revision.model) ? revision.model : null;
  if (!model || typeof model.providerId !== "string" || typeof model.modelId !== "string") {
    throw new Error(`Automation ${name} was not returned with a stored model.`);
  }
  return { providerId: model.providerId, modelId: model.modelId };
}

async function recordProposalScreenshot(desktop: Surface, claims: string[]): Promise<void> {
  const shot = await screenshot(desktop);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const seen = await validate(shot, claims);
      expect(seen.ok, seen.why).toBe(true);
      return;
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

test("chat Automation proposals map Den providers and disclose a safe fallback", async ({ evidence, place }) => {
  needs({ model: "tool-capable", optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  await using den = await server({ place });
  const orgId = await activeOrganizationId(den.admin);
  await selectOrganization(den.admin, orgId);
  const providerRecordId = await createProvider(den.admin, orgId);
  const stamp = Date.now();
  const mappedName = `Feedback digest ${stamp}`;
  const fallbackName = `Local model check ${stamp}`;

  await using desktop = await app({ den, as: "admin", place });
  await go(desktop, `/workspace/${desktop.workspaceId}/session`);
  await waitFor(desktop, "Boolean(document.querySelector('[contenteditable=true]'))", {
    timeoutMs: 120_000,
    label: "session composer",
  });
  const evalModel = process.env.OPENWORK_EVAL_MODEL?.trim() ?? "";
  const models = await readAvailableModels(desktop);
  const evalModelOption = models.find((model) =>
    model.selectable && (model.id === evalModel || model.id.endsWith(`/${evalModel}`))
  );
  expect(evalModelOption, `Could not select ${evalModel}; saw ${models.map((model) => model.id).join(", ")}`).toBeDefined();
  if (!evalModelOption) throw new Error(`The eval model ${evalModel} is not selectable.`);
  await selectModel(desktop, evalModelOption.id);
  await evalIn(desktop, `(() => {
    document.documentElement.dataset.automationProposalLegacyErrorSeen =
      document.body.innerText.toLowerCase().includes('no longer available') ? 'true' : 'false';
    const observer = new MutationObserver(() => {
      if (document.body.innerText.toLowerCase().includes('no longer available')) {
        document.documentElement.dataset.automationProposalLegacyErrorSeen = 'true';
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return true;
  })()`);

  const mappedPrompt = `Use the openwork_execute tool exactly once with arguments: {"id":"automation.propose","args":{"name":${JSON.stringify(mappedName)},"instructions":"Summarize new OpenWork feedback and post one short digest.","schedule":{"kind":"weekly","timezone":"UTC","daysOfWeek":[1],"hour":9,"minute":0},"model":{"providerId":"deepseek","modelId":"deepseek-v4-flash"}}}. This is a tool-call test; do not ask questions, do not call any other tool, and reply only after the tool call.`;
  expect(mappedPrompt).not.toContain(providerRecordId);
  await sendComposerMessage(desktop, mappedPrompt);
  const mappedCard = await waitForProposalCard(desktop, mappedName, "mapped", false);
  expect(mappedCard.resolution).toBe("mapped");
  expect(mappedCard.text).toContain(`Runs with ${PROVIDER_NAME}`);
  expect(mappedCard.text).not.toContain(FALLBACK_NOTICE);
  await recordProposalScreenshot(desktop, [
    `A Suggested Automation named ${mappedName} is visible in the chat`,
    `The proposal says it runs with ${PROVIDER_NAME} and does not show a free-starter-model fallback notice`,
    "The proposal is waiting for the person to create it and no provider-unavailable error is visible",
  ]);

  await clickCreateAutomation(desktop, mappedName);
  const mappedCreatedCard = await waitForProposalCard(desktop, mappedName, "mapped", true);
  await waitForText(desktop, "Automation created and active", { timeoutMs: 120_000 });
  const mappedPageText = await visibleText(desktop);
  expect(mappedPageText).not.toMatch(/no longer available/i);
  expect(mappedPageText).toContain("Automation created and active");
  const mappedModel = await storedAutomationModel(den.admin, orgId, mappedName);
  expect(mappedModel.providerId).toBe(providerRecordId);
  expect(mappedModel.providerId).not.toBe(PROVIDER_KEY);
  expect(mappedModel.modelId).toBe(MODEL_ID);
  evidence.fact(
    "The mapped proposal created with Den's canonical provider record",
    `${mappedName} was created as ${mappedModel.providerId}/${mappedModel.modelId}, not ${PROVIDER_KEY}/${MODEL_ID}.`,
    mappedCreatedCard.createdId.length > 0
      && mappedModel.providerId === providerRecordId
      && mappedModel.modelId === MODEL_ID,
  );
  await recordProposalScreenshot(desktop, [
    `The ${mappedName} proposal visibly says Automation created and active`,
    `The created Automation still says it runs with ${PROVIDER_NAME}`,
    "No provider-unavailable error or failed creation message is visible",
  ]);

  const fallbackPrompt = `Use the openwork_execute tool exactly once with arguments: {"id":"automation.propose","args":{"name":${JSON.stringify(fallbackName)},"instructions":"Summarize new OpenWork feedback and post one short digest.","schedule":{"kind":"weekly","timezone":"UTC","daysOfWeek":[1],"hour":9,"minute":0},"model":{"providerId":"local-only-provider","modelId":"mystery-model"}}}. This is a tool-call test; do not ask questions, do not call any other tool, and reply only after the tool call.`;
  expect(fallbackPrompt).not.toContain(providerRecordId);
  await sendComposerMessage(desktop, fallbackPrompt);
  const fallbackCard = await waitForProposalCard(desktop, fallbackName, "fallback", false);
  expect(fallbackCard.resolution).toBe("fallback");
  expect(fallbackCard.text).toContain("free starter model");
  expect(fallbackCard.text).toContain("Runs with OpenCode Zen");
  await recordProposalScreenshot(desktop, [
    `A Suggested Automation named ${fallbackName} is visible in the chat`,
    "An amber notice discloses that the unavailable proposed model will use the free starter model",
    "The proposal says Runs with OpenCode Zen and no provider-unavailable failure is visible",
  ]);

  await clickCreateAutomation(desktop, fallbackName);
  const fallbackCreatedCard = await waitForProposalCard(desktop, fallbackName, "fallback", true);
  const fallbackPageText = await visibleText(desktop);
  expect(fallbackPageText).not.toMatch(/no longer available/i);
  expect(fallbackPageText).toContain("Automation created and active");
  const fallbackModel = await storedAutomationModel(den.admin, orgId, fallbackName);
  expect(fallbackModel).toEqual({ providerId: "opencode", modelId: "big-pickle" });
  evidence.fact(
    "The fallback was disclosed and created with the free starter model",
    `${fallbackName} showed the fallback notice and was created as ${fallbackModel.providerId}/${fallbackModel.modelId}.`,
    fallbackCard.text.includes("free starter model")
      && fallbackCard.text.includes("Runs with OpenCode Zen")
      && fallbackCreatedCard.createdId.length > 0
      && fallbackModel.providerId === "opencode"
      && fallbackModel.modelId === "big-pickle",
  );
  await recordProposalScreenshot(desktop, [
    `The ${fallbackName} proposal visibly says Automation created and active`,
    "The created Automation says it runs with OpenCode Zen · Big Pickle",
    "No provider-unavailable error or failed creation message is visible",
  ]);

  const legacyErrorSeen = await evalIn(
    desktop,
    "document.documentElement.dataset.automationProposalLegacyErrorSeen === 'true'",
  );
  const finalPageText = await visibleText(desktop);
  const legacyErrorAbsent = legacyErrorSeen === false && !/no longer available/i.test(finalPageText);
  evidence.fact(
    "The legacy provider-unavailable error never appeared",
    "A DOM observer covered both proposal creations and the final page contains no 'no longer available' message.",
    legacyErrorAbsent,
  );
  expect(legacyErrorAbsent).toBe(true);
}, 20 * 60_000);
