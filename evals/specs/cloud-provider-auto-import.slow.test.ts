import { expect, onTestFinished } from "vitest";
import { screenshot, validate } from "@openwork/fraimz";
import {
  clickButton,
  denFetch,
  evalIn,
  go,
  readAvailableModels,
  readCurrentOrganizationMemberId,
  selectModel,
  waitFor,
  waitForText,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { app, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { NeedsSpec } from "@openwork/testkit";

const requirements: NeedsSpec = { optIn: ["OPENWORK_EVAL_APP_SPECS"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `cloud provider auto import skipped — needs: ${missingRequirements.join(", ")}`
  : "org providers import themselves — settings never shows an Import button";

const providerName = "Auto Import Proof";
const modelId = "gpt-5.4";
const addedModelId = "gpt-5.4-mini";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function denRequest(
  session: DenSession,
  path: string,
  init: RequestInit = {},
  allowedStatuses: number[] = [],
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${session.token}`);
  const result = await denFetch(session, path, { ...init, headers });
  if (!result.response.ok && !allowedStatuses.includes(result.response.status)) {
    throw new Error(`${init.method ?? "GET"} ${path} failed with ${result.response.status}: ${result.text.slice(0, 500)}`);
  }
  return result.body;
}

async function selectOrganization(admin: DenSession): Promise<void> {
  // A reused Den account may belong to several organizations. Explicitly select
  // one so every provider API call and the desktop sign-in use the same org.
  const body = record(await denRequest(admin, "/v1/me/orgs"));
  const organization = records(body.orgs).find((entry) => entry.slug === "default") ?? records(body.orgs)[0];
  const organizationId = stringField(organization?.id);
  if (!organizationId) throw new Error("The eval admin has no organization.");
  await denRequest(admin, "/v1/me/active-organization", {
    method: "POST",
    body: JSON.stringify({ organizationId }),
  });
}

async function deleteProofProviders(admin: DenSession): Promise<void> {
  const body = record(await denRequest(admin, "/v1/llm-providers?scope=manageable"));
  for (const provider of records(body.llmProviders)) {
    if (provider.name !== providerName || typeof provider.id !== "string") continue;
    await denRequest(
      admin,
      `/v1/llm-providers/${encodeURIComponent(provider.id)}`,
      { method: "DELETE" },
      [204, 404],
    );
  }
}

function importedProviderExpression(): string {
  return `(() => {
    const name = ${JSON.stringify(providerName)};
    const title = [...document.querySelectorAll('*')]
      .find((element) => element.children.length === 0 && (element.textContent ?? '').trim() === name);
    let row = title;
    for (let depth = 0; row && depth < 4; depth += 1, row = row.parentElement) {
      const imported = [...row.querySelectorAll('*')]
        .some((element) => element.children.length === 0 && (element.textContent ?? '').trim() === 'Imported');
      if (imported) return true;
    }
    return false;
  })()`;
}

async function exactButtonLabels(desktopApp: Surface): Promise<string[]> {
  const value = await evalIn(
    desktopApp,
    `[...document.querySelectorAll('button')].map((button) => (button.textContent ?? '').trim())`,
  );
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function waitForSelectableModel(desktopApp: Surface, id: string): Promise<void> {
  // The engine catalog arrives asynchronously after both app boot and a cloud
  // provider refresh, so repeatedly reopen/read the real picker rather than
  // trusting its first paint.
  await expect.poll(
    async () => (await readAvailableModels(desktopApp)).some((model) => model.id === id && model.selectable),
    { timeout: 120_000, interval: 3_000 },
  ).toBe(true);
}

test(title, async ({ evidence, place }) => {
  needs(requirements);

  await using den = await server({ place });
  await selectOrganization(den.admin);
  await deleteProofProviders(den.admin);
  onTestFinished(async () => deleteProofProviders(den.admin));

  const adminMemberId = await readCurrentOrganizationMemberId(den.admin);
  const created = record(await denRequest(den.admin, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: providerName,
      source: "models_dev",
      providerId: "openai",
      modelIds: [modelId],
      apiKey: "sk-openwork-local-eval-only",
      memberIds: [adminMemberId],
      teamIds: [],
    }),
  }));
  const providerId = stringField(record(created.llmProvider).id);
  evidence.fact(
    "The admin published an organization provider",
    `${providerName} grants ${modelId} to member ${adminMemberId}.`,
    Boolean(providerId),
  );
  expect(providerId, "The assigned organization provider was not created.").not.toBe("");

  await using desktopApp = await app({ den, as: "admin", place });
  const settingsPath = `/workspace/${desktopApp.workspaceId}/settings/cloud-providers`;

  // Frame 2: opening settings is the import action; there is nothing to click.
  await go(desktopApp, settingsPath);
  await waitForText(desktopApp, providerName, { timeoutMs: 120_000 });
  await waitFor(desktopApp, importedProviderExpression(), {
    timeoutMs: 120_000,
    label: `${providerName} row marked Imported`,
  });
  const initialButtons = await exactButtonLabels(desktopApp);
  const noManualImport = !initialButtons.includes("Import") && !initialButtons.includes("Sync");
  evidence.fact(
    "No Import button exists on the Cloud providers surface",
    `Exact button labels: ${JSON.stringify(initialButtons)}`,
    noManualImport,
  );
  expect(initialButtons).not.toContain("Import");
  expect(initialButtons).not.toContain("Sync");
  {
    const shot = await screenshot(desktopApp);
    const seen = await validate(shot, [
      "The organization provider is visibly Imported in Cloud providers settings",
      "No Import or Sync button is visible in the providers list",
      "No 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  // Frame 3: the imported model is immediately usable in the composer.
  await go(desktopApp, `/workspace/${desktopApp.workspaceId}/session`);
  await waitForSelectableModel(desktopApp, modelId);
  const selected = await selectModel(desktopApp, modelId);
  expect(selected.id).toBe(modelId);
  expect(selected.selectable).toBe(true);
  expect(selected.selected).toBe(true);
  {
    const shot = await screenshot(desktopApp);
    const seen = await validate(shot, [
      "The organization's model is selected and selectable in the composer",
      "No 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  // Frame 4: Den's write route expects the complete provider schema on PATCH.
  await denRequest(den.admin, `/v1/llm-providers/${encodeURIComponent(providerId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      name: providerName,
      source: "models_dev",
      providerId: "openai",
      modelIds: [modelId, addedModelId],
      apiKey: "sk-openwork-local-eval-only",
      memberIds: [adminMemberId],
      teamIds: [],
    }),
  });

  await go(desktopApp, settingsPath);
  await clickButton(desktopApp, "Refresh");
  await waitFor(
    desktopApp,
    `(() => {
      const imported = ${importedProviderExpression()};
      const labels = [...document.querySelectorAll('button')].map((button) => (button.textContent ?? '').trim());
      return imported && !document.body.innerText.includes('Out of sync') && !labels.includes('Import') && !labels.includes('Sync');
    })()`,
    { timeoutMs: 120_000, label: "provider refresh reconciled without Import, Sync, or Out of sync" },
  );
  const refreshedButtons = await exactButtonLabels(desktopApp);
  const reconciledWithoutSync = !refreshedButtons.includes("Import")
    && !refreshedButtons.includes("Sync")
    && await evalIn(desktopApp, "!document.body.innerText.includes('Out of sync')") === true;
  evidence.fact(
    "The model list change reconciled without any manual Sync",
    `The row remained Imported; exact button labels: ${JSON.stringify(refreshedButtons)}.`,
    reconciledWithoutSync,
  );
  expect(reconciledWithoutSync).toBe(true);

  await go(desktopApp, `/workspace/${desktopApp.workspaceId}/session`);
  await waitForSelectableModel(desktopApp, addedModelId);
  const finalModels = await readAvailableModels(desktopApp);
  expect(finalModels.some((model) => model.id === addedModelId && model.selectable)).toBe(true);
  {
    const shot = await screenshot(desktopApp);
    const seen = await validate(shot, [
      "The newly added organization model gpt-5.4-mini is visibly selectable in the model picker",
      "No manual Sync prompt or 'Something went wrong' crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
});
