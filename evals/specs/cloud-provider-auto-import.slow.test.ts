import { expect, onTestFinished } from "vitest";
import { screenshot, validate } from "@openwork/fraimz";
import { denFetch, evalIn, go, readAvailableModels, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { app, needs, server, test } from "@openwork/testkit";

const ORGANIZATION_NAME = "Cloud Provider Auto Import";
const PROVIDER_NAME = "Automatic Team Models";
const PROVIDER_KEY = "automatic-team-models";
const MODEL_ID = "automatic-proof-model";
const REQUEST_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: auth(session),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((entry) => entry.name === ORGANIZATION_NAME);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the test organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
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
        env: ["AUTO_IMPORT_PROVIDER_API_KEY"],
        models: [{ id: MODEL_ID, name: "Automatic Proof Model" }],
      },
      apiKey: "sk-openwork-auto-import-eval-only",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider)
    ? result.body.llmProvider
    : null;
  const id = provider && typeof provider.id === "string" ? provider.id : "";
  if (result.response.status !== 201 || !id) {
    throw new Error(`Creating the provider failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function deleteProvider(admin: DenSession, orgId: string, providerId: string): Promise<void> {
  await denFetch(admin, `/v1/llm-providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
    headers: {
      ...auth(admin),
      "x-openwork-org-id": orgId,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

test("granted cloud providers appear automatically in settings and the model picker", async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });
  await using den = await server({
    place,
    org: {
      name: ORGANIZATION_NAME,
      admin: { name: "Provider Admin" },
      members: { member: { name: "Provider Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("The testkit did not provision the organization member.");

  const orgId = await organizationId(den.admin);
  const providerId = await createProvider(den.admin, orgId);
  onTestFinished(async () => {
    await deleteProvider(den.admin, orgId, providerId).catch(() => undefined);
  });

  await using desktopApp = await app({ den, as: "member", place });
  const settingsRoute = `/workspace/${desktopApp.workspaceId}/settings/cloud-providers`;
  await go(desktopApp, settingsRoute);
  await waitFor(desktopApp, `(() => {
    if (!window.location.hash.includes('/settings/cloud-providers')) {
      window.location.hash = ${JSON.stringify(`#${settingsRoute}`)};
      return false;
    }
    const title = [...document.querySelectorAll('span')]
      .find((element) => (element.textContent ?? '').trim() === ${JSON.stringify(PROVIDER_NAME)});
    const row = title?.parentElement?.parentElement?.parentElement;
    return Boolean(row && (row.textContent ?? '').includes('Connected'));
  })()`, { timeoutMs: 120_000, label: "automatically connected provider row" });

  const settingsState = await evalIn(desktopApp, `({
    connected: document.body.innerText.includes(${JSON.stringify(PROVIDER_NAME)})
      && document.body.innerText.includes('Connected'),
    importButton: [...document.querySelectorAll('button')]
      .some((button) => (button.textContent ?? '').trim() === 'Import'),
  })`);
  const connected = isRecord(settingsState) && settingsState.connected === true;
  const importButtonAbsent = isRecord(settingsState) && settingsState.importButton === false;
  evidence.fact(
    "The granted provider connected without an import action",
    `Settings state: ${JSON.stringify(settingsState)}`,
    connected && importButtonAbsent,
  );
  expect(connected).toBe(true);
  expect(importButtonAbsent).toBe(true);
  {
    const shot = await screenshot(desktopApp);
    const seen = await validate(shot, [
      `The Cloud providers page shows ${PROVIDER_NAME} as Connected`,
      "The page is status-only with Sync now and no Import provider action",
      "No error or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  await go(desktopApp, `/workspace/${desktopApp.workspaceId}/session`);
  const models = await readAvailableModels(desktopApp);
  const modelAvailable = models.some((model) => model.id === MODEL_ID && model.selectable);
  evidence.fact(
    "The automatically imported provider contributes its model",
    `Selectable models: ${JSON.stringify(models.filter((model) => model.id === MODEL_ID))}`,
    modelAvailable,
  );
  expect(modelAvailable).toBe(true);
  {
    const shot = await screenshot(desktopApp);
    const seen = await validate(shot, [
      `The open Models picker shows ${MODEL_ID} from the organization provider`,
      "The organization model is visibly selectable without a provider connection prompt",
      "No error or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
});
