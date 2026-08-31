import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import {
  createAndSelectWorkspace,
  evalIn,
  fill,
  go,
  readAvailableModels,
  selectModel,
  signInInBrowser,
  waitFor,
  waitForAssistantReply,
  writeComposerText,
} from "@openwork/behaviors";
import { chrome, electronProfilePaths } from "@openwork/hosts";
import {
  app,
  eventually,
  needs,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import {
  AZURE_BYOK_ADMIN_EMAIL,
  AZURE_BYOK_ORGANIZATION,
  bootAzureByok,
} from "../../worlds/azure-byok.ts";

const ORGANIZATION_NAME = AZURE_BYOK_ORGANIZATION;
const ADMIN_EMAIL = AZURE_BYOK_ADMIN_EMAIL;
const ADMIN_PASSWORD = "OpenWorkEval123!";
const RESOURCE_ENV = "AZURE_RESOURCE_NAME";
const API_KEY_ENV = "AZURE_FOUNDRY_API_KEY";
const AZURE_CATALOG_API_KEY_ENV = "AZURE_API_KEY";
const DEPLOYMENT_ENV = "AZURE_DEPLOYMENT_ID";
const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_AZURE_BYOK_LIVE"],
  env: [RESOURCE_ENV, API_KEY_ENV, DEPLOYMENT_ENV],
  commands: ["docker"],
  placement: "local",
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `#4096 live Azure BYOK reproduction skipped — needs: ${missingRequirements.join(", ")}`
  : "#4096 live: Azure BYOK answers through the managed provider in isolated Electron";

interface CatalogChoiceFacts {
  exactAzureOptions: number;
  cognitiveOptions: number;
  clicked: boolean;
}

interface AzureDiscoveryFacts {
  ready: boolean;
  matchingRows: number;
  selectedMatchingRows: number;
}

interface AccessFacts {
  everyone: boolean;
  defaultAdmin: boolean;
}

interface AuthFacts {
  filePresent: boolean;
  providerEntryPresent: boolean;
  apiType: boolean;
  matchesResourceValue: boolean;
  matchesApiKeyValue: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Required live Azure input ${name} is unavailable.`);
  return value;
}

function errorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

async function chooseExactAzure(surface: Parameters<typeof evalIn>[0]): Promise<CatalogChoiceFacts> {
  await fill(surface, 'input[aria-label="Provider"]', "Azure", { timeoutMs: 60_000 });
  await waitFor(surface, `(() => {
    const options = [...document.querySelectorAll('[role="option"]')];
    return options.some((option) => (option.querySelector("p")?.textContent ?? "").trim() === "Azure");
  })()`, { timeoutMs: 60_000, label: "exact Azure catalog option" });
  const value = await evalIn(surface, `(() => {
    const options = [...document.querySelectorAll('[role="option"]')];
    const labels = options.map((option) => (option.querySelector("p")?.textContent ?? "").trim());
    const exact = options.filter((option) => (option.querySelector("p")?.textContent ?? "").trim() === "Azure");
    const target = exact[0];
    if (target instanceof HTMLElement) {
      target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, isPrimary: true }));
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      target.click();
    }
    return {
      exactAzureOptions: exact.length,
      cognitiveOptions: labels.filter((label) => label === "Azure Cognitive Services").length,
      clicked: target instanceof HTMLElement,
    };
  })()`);
  if (!isRecord(value)) throw new Error("The Azure catalog choice returned an invalid result.");
  return {
    exactAzureOptions: typeof value.exactAzureOptions === "number" ? value.exactAzureOptions : 0,
    cognitiveOptions: typeof value.cognitiveOptions === "number" ? value.cognitiveOptions : 0,
    clicked: value.clicked === true,
  };
}

async function fillCredential(
  surface: Parameters<typeof evalIn>[0],
  envName: string,
  value: string,
): Promise<void> {
  try {
    const filled = await evalIn(surface, `(() => {
      const label = [...document.querySelectorAll("label")]
        .find((candidate) => (candidate.querySelector("code")?.textContent ?? "").trim() === ${JSON.stringify(envName)});
      const input = label?.querySelector('input[type="password"]');
      if (!(input instanceof HTMLInputElement)) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) return false;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`, { timeoutMs: 15_000 });
    if (filled !== true) throw new Error("credential input unavailable");
  } catch {
    throw new Error(`Could not fill the ${envName} credential input.`);
  }
}

async function readAzureDiscovery(
  surface: Parameters<typeof evalIn>[0],
  deploymentId: string,
): Promise<AzureDiscoveryFacts> {
  let value: unknown;
  try {
    value = await evalIn(surface, `(() => {
      const section = [...document.querySelectorAll("section")].find((candidate) =>
        [...candidate.querySelectorAll("h2")].some((heading) => (heading.textContent ?? "").trim() === "Models"));
      if (!section) return { ready: false, matchingRows: 0, selectedMatchingRows: 0 };
      const rows = [...section.querySelectorAll("button")].filter((button) =>
        [...button.querySelectorAll("p")].some((part) => (part.textContent ?? "").trim() === ${JSON.stringify(deploymentId)}));
      return {
        ready: (section.textContent ?? "").includes("available on your Azure resource"),
        matchingRows: rows.length,
        selectedMatchingRows: rows.filter((row) => row.getAttribute("aria-pressed") === "true").length,
      };
    })()`, { timeoutMs: 15_000 });
  } catch {
    throw new Error("Could not inspect Azure deployment discovery.");
  }
  if (!isRecord(value)) throw new Error("Azure deployment discovery returned an invalid result.");
  return {
    ready: value.ready === true,
    matchingRows: typeof value.matchingRows === "number" ? value.matchingRows : 0,
    selectedMatchingRows: typeof value.selectedMatchingRows === "number" ? value.selectedMatchingRows : 0,
  };
}

async function selectConfiguredDeployment(
  surface: Parameters<typeof evalIn>[0],
  deploymentId: string,
): Promise<void> {
  try {
    const selected = await evalIn(surface, `(() => {
      const section = [...document.querySelectorAll("section")].find((candidate) =>
        [...candidate.querySelectorAll("h2")].some((heading) => (heading.textContent ?? "").trim() === "Models"));
      const row = [...(section?.querySelectorAll("button") ?? [])].find((button) =>
        [...button.querySelectorAll("p")].some((part) => (part.textContent ?? "").trim() === ${JSON.stringify(deploymentId)}));
      if (!(row instanceof HTMLButtonElement)) return false;
      row.scrollIntoView({ block: "center" });
      row.click();
      return true;
    })()`, { timeoutMs: 15_000 });
    if (selected !== true) throw new Error("deployment row unavailable");
  } catch {
    throw new Error("Could not select the configured Azure deployment.");
  }
}

async function readAccessFacts(surface: Parameters<typeof evalIn>[0]): Promise<AccessFacts> {
  const value = await evalIn(surface, `(() => {
    const everyone = document.querySelector('[data-testid="llm-provider-all-members"]');
    const bar = document.querySelector('[data-testid="llm-provider-save-bar"]');
    const everyoneChecked = everyone?.getAttribute("aria-checked") === "true";
    return {
      everyone: everyoneChecked,
      defaultAdmin: !everyoneChecked && (bar?.textContent ?? "").includes("1 person"),
    };
  })()`);
  if (!isRecord(value)) throw new Error("The provider access controls returned an invalid result.");
  return { everyone: value.everyone === true, defaultAdmin: value.defaultAdmin === true };
}

async function providerIdFromPath(surface: Parameters<typeof evalIn>[0]): Promise<string> {
  const path = await evalIn(surface, "location.pathname");
  if (typeof path !== "string") return "";
  return /\/custom-llm-providers\/(lpr_[^/]+)$/.exec(path)?.[1] ?? "";
}

async function clickRouteLink(surface: Parameters<typeof evalIn>[0], href: string): Promise<void> {
  await waitFor(surface, `(() => {
    const link = document.querySelector('a[href=${JSON.stringify(href)}]');
    if (!(link instanceof HTMLAnchorElement)) return false;
    link.click();
    return true;
  })()`, {
    timeoutMs: 60_000,
    label: `Den Web link ${href}`,
  });
  await waitFor(surface, `location.pathname === ${JSON.stringify(href)}`, {
    timeoutMs: 60_000,
    label: `Den Web route ${href}`,
  });
}

async function sendPromptThroughControl(surface: Parameters<typeof evalIn>[0], prompt: string): Promise<void> {
  await writeComposerText(surface, prompt);
  await waitFor(surface, `Boolean([...document.querySelectorAll("button")]
    .find((button) => (button.textContent ?? "").trim() === "Run task" && !button.disabled))`, {
    timeoutMs: 30_000,
    label: "enabled isolated Electron run button",
  });
  const clicked = await evalIn(surface, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => (entry.textContent ?? "").trim() === "Run task" && !entry.disabled);
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`);
  if (clicked !== true) throw new Error("The isolated Electron run button did not submit the Azure prompt.");
}

async function localServerRequest(
  desktop: Parameters<typeof evalIn>[0],
  path: string,
  input: { method?: string; body?: Record<string, unknown> } = {},
): Promise<{ status: number; body: unknown }> {
  const value = await evalIn(desktop, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    const clientToken = localStorage.getItem("openwork.server.token") ?? "";
    if (!info?.running || !info.baseUrl || !info.hostToken || !clientToken) {
      return { status: 0, body: { error: "local_server_unavailable" } };
    }
    const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + ${JSON.stringify(path)}, {
      method: ${JSON.stringify(input.method ?? "GET")},
      headers: {
        Authorization: "Bearer " + clientToken,
        "Content-Type": "application/json",
        "x-openwork-host-token": String(info.hostToken),
      },
      body: ${input.body ? JSON.stringify(JSON.stringify(input.body)) : "undefined"},
    });
    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, body };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  if (!isRecord(value) || typeof value.status !== "number") {
    throw new Error("The local server returned an invalid response shape.");
  }
  return { status: value.status, body: value.body };
}

async function readAuthFacts(
  profileDir: string,
  providerId: string,
  resourceName: string,
  apiKey: string,
): Promise<AuthFacts> {
  const paths = electronProfilePaths(profileDir);
  const candidates = [
    join(paths.userDataDir, "openwork-dev-data", "xdg", "data", "opencode", "auth.json"),
    join(paths.dataHome, "opencode", "auth.json"),
  ];
  let raw: string | null = null;
  for (const authPath of candidates) {
    try {
      raw = await readFile(authPath, "utf8");
      break;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw new Error("Could not read the isolated OpenCode auth store.");
      }
    }
  }
  if (raw === null) {
    return {
      filePresent: false,
      providerEntryPresent: false,
      apiType: false,
      matchesResourceValue: false,
      matchesApiKeyValue: false,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("The isolated OpenCode auth store is not valid JSON.");
  }
  const entry = isRecord(parsed) && isRecord(parsed[providerId]) ? parsed[providerId] : null;
  const key = entry && typeof entry.key === "string" ? entry.key : "";
  return {
    filePresent: true,
    providerEntryPresent: entry !== null && key.length > 0,
    apiType: entry?.type === "api",
    matchesResourceValue: key === resourceName,
    matchesApiKeyValue: key === apiKey,
  };
}

async function probeAzureDeployment(resourceName: string, apiKey: string, deploymentId: string): Promise<number> {
  let response: Response;
  try {
    response = await fetch(
      `https://${resourceName}.openai.azure.com/openai/deployments/${encodeURIComponent(deploymentId)}/chat/completions?api-version=2024-10-21`,
      {
        method: "POST",
        headers: { "api-key": apiKey, "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "Reply with OK." }],
          max_completion_tokens: 32,
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
  } catch {
    throw new Error("The direct Azure deployment probe could not reach the configured resource.");
  }
  await response.body?.cancel().catch(() => undefined);
  return response.status;
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 30 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);
  const resourceName = requiredEnv(RESOURCE_ENV);
  const apiKey = requiredEnv(API_KEY_ENV);
  const deploymentId = requiredEnv(DEPLOYMENT_ENV);
  expect(resourceName).not.toBe(apiKey);

  await using stack = new AsyncDisposableStack();
  const world = await bootAzureByok(stack, place);
  expect(Object.keys(world).sort()).toEqual(["admin", "den", "org"]);
  expect(world.admin.email).toBe(ADMIN_EMAIL);
  expect(world.org.name).toBe(ORGANIZATION_NAME);
  evidence.recordAssertionEvidence(
    "The live reproduction starts only a fresh isolated self-hosted Den",
    `The world has zero app surfaces and provisions ${ORGANIZATION_NAME} with the expected provider admin.`,
    Object.keys(world).length === 3
      && world.admin.email === ADMIN_EMAIL
      && world.org.name === ORGANIZATION_NAME,
  );

  await using browser = await chrome({
    name: "azure-byok-den-web",
    startUrl: world.den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await signInInBrowser(browser, `${world.den.ref.webUrl}/dashboard`, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  await clickRouteLink(browser, "/dashboard/inference");
  await clickRouteLink(browser, "/dashboard/custom-llm-providers");
  await clickRouteLink(browser, "/dashboard/custom-llm-providers/new");
  await waitFor(browser, `document.body.innerText.includes("Add a new LLM provider")
    && Boolean(document.querySelector('input[aria-label="Provider"]'))`, {
    timeoutMs: 90_000,
    label: "Den Web add provider editor",
  });

  const catalogChoice = await chooseExactAzure(browser);
  await waitFor(browser, `document.querySelector('input[aria-label="Provider"]')?.value === "Azure"
    && document.body.innerText.includes("AZURE_RESOURCE_NAME")
    && document.body.innerText.includes("AZURE_API_KEY")`, {
    timeoutMs: 60_000,
    label: "exact Azure catalog detail",
  });
  const exactAzureSelected = catalogChoice.exactAzureOptions === 1 && catalogChoice.clicked;
  expect(exactAzureSelected).toBe(true);
  evidence.recordAssertionEvidence(
    "Den Web selects the catalog provider Azure, not Azure Cognitive Services",
    `The filtered catalog exposed ${catalogChoice.exactAzureOptions} exact Azure option and ${catalogChoice.cognitiveOptions} Azure Cognitive Services option(s); the exact Azure row was selected.`,
    exactAzureSelected,
  );

  await fillCredential(browser, RESOURCE_ENV, resourceName);
  await fillCredential(browser, AZURE_CATALOG_API_KEY_ENV, apiKey);
  const discovered = await eventually(() => readAzureDiscovery(browser, deploymentId), {
    within: 120_000,
    intervalMs: 1_000,
    label: "configured Azure deployment in live discovery",
    until: (facts) => facts.ready && facts.matchingRows >= 1,
  });
  expect(discovered.ready).toBe(true);
  expect(discovered.matchingRows).toBeGreaterThanOrEqual(1);
  evidence.recordAssertionEvidence(
    "The real Azure credential pair discovers the configured deployment in Den Web",
    `Azure discovery completed and returned ${discovered.matchingRows} exact matching deployment row(s).`,
    discovered.ready && discovered.matchingRows >= 1,
  );

  await selectConfiguredDeployment(browser, deploymentId);
  const selectedDeployment = await eventually(() => readAzureDiscovery(browser, deploymentId), {
    within: 30_000,
    intervalMs: 250,
    label: "configured Azure deployment selected",
    until: (facts) => facts.selectedMatchingRows === 1,
  });
  expect(selectedDeployment.selectedMatchingRows).toBe(1);

  const access = await eventually(() => readAccessFacts(browser), {
    within: 30_000,
    intervalMs: 250,
    label: "default provider admin access",
    until: (facts) => facts.everyone || facts.defaultAdmin,
  });
  expect(access.everyone || access.defaultAdmin).toBe(true);
  evidence.recordAssertionEvidence(
    "The configured deployment is selected and retains the UI's access grant",
    `One configured deployment row is selected; access is everyone=${String(access.everyone)}, default admin=${String(access.defaultAdmin)}.`,
    selectedDeployment.selectedMatchingRows === 1 && (access.everyone || access.defaultAdmin),
  );

  const createClicked = await evalIn(browser, `(() => {
    const button = document.querySelector('[data-testid="llm-provider-save"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(createClicked).toBe(true);
  const providerId = await eventually(() => providerIdFromPath(browser), {
    within: 90_000,
    intervalMs: 500,
    label: "created lpr provider route",
    until: (id) => /^lpr_/.test(id),
  });
  expect(providerId).toMatch(/^lpr_/);
  evidence.recordAssertionEvidence(
    "Den Web creates the selected catalog provider",
    `The browser navigated to the resulting managed provider route for ${providerId}.`,
    /^lpr_/.test(providerId),
  );

  const workspacePath = join(tmpdir(), `openwork-azure-live-${process.pid}-${Date.now()}`);
  const profileDir = await mkdtemp(join(tmpdir(), "openwork-azure-live-profile-"));
  await using initialDesktop = await app({
    den: world.den,
    as: "admin",
    place,
    profileDir,
    workspacePath,
  });
  const activeOrgId = await evalIn(initialDesktop, 'localStorage.getItem("openwork.den.activeOrgId")');
  if (typeof activeOrgId !== "string" || !activeOrgId) {
    throw new Error("The isolated Electron app did not select the world organization.");
  }
  const sessionSet = await localServerRequest(initialDesktop, "/den-session", {
    method: "PUT",
    body: { baseUrl: world.den.ref.apiUrl, token: world.den.admin.token, orgId: activeOrgId },
  });
  expect(sessionSet.status).toBe(204);
  const syncRun = await localServerRequest(initialDesktop, "/cloud-provider-sync/run", {
    method: "POST",
    body: { reason: "eval_azure_byok_live" },
  });
  expect(syncRun.status).toBe(200);
  const syncStatus = await eventually(
    async () => localServerRequest(initialDesktop, "/cloud-provider-sync/status"),
    {
      within: 120_000,
      intervalMs: 2_000,
      label: "terminal live Azure provider sync",
      until: (result) => {
        if (result.status !== 200 || !isRecord(result.body)) return false;
        const lastRun = isRecord(result.body.lastRun) ? result.body.lastRun : {};
        const providers = Array.isArray(result.body.providers) ? result.body.providers.filter(isRecord) : [];
        return (lastRun.status === "applied" || lastRun.status === "noop")
          && result.body.reloadPending === false
          && providers.some((provider) => provider.cloudProviderId === providerId);
      },
    },
  );
  const syncBody = isRecord(syncStatus.body) ? syncStatus.body : {};
  const syncLastRun = isRecord(syncBody.lastRun) ? syncBody.lastRun : {};
  const syncProviders = Array.isArray(syncBody.providers) ? syncBody.providers.filter(isRecord) : [];
  const synced = (syncLastRun.status === "applied" || syncLastRun.status === "noop")
    && syncBody.reloadPending === false
    && syncProviders.some((provider) => provider.cloudProviderId === providerId);
  expect(synced).toBe(true);

  if (initialDesktop.handle.hostKind !== "local" || !initialDesktop.handle.profileDir) {
    throw new Error("The live Azure reproduction requires an isolated local Electron profile.");
  }
  const authFacts = await eventually(
    () => readAuthFacts(profileDir, providerId, resourceName, apiKey),
    {
      within: 60_000,
      intervalMs: 500,
      label: "secret-safe managed provider auth selection",
      until: (facts) => facts.providerEntryPresent,
    },
  );
  const correctCredentialDelivered = authFacts.filePresent
    && authFacts.providerEntryPresent
    && authFacts.apiType
    && !authFacts.matchesResourceValue
    && authFacts.matchesApiKeyValue;
  expect(authFacts.matchesResourceValue).toBe(false);
  expect(authFacts.matchesApiKeyValue).toBe(true);
  expect(correctCredentialDelivered).toBe(true);
  evidence.recordAssertionEvidence(
    "The isolated auth.json selects the API-key value, not the resource-name value",
    `Secret-safe auth facts: ${JSON.stringify(authFacts)}.`,
    correctCredentialDelivered,
  );

  const directProbeStatus = await probeAzureDeployment(resourceName, apiKey, deploymentId);
  expect(directProbeStatus).toBe(200);
  evidence.recordAssertionEvidence(
    "The same Azure resource, deployment, and real API key succeed directly",
    `The secret-safe deployment-style REST probe returned HTTP ${directProbeStatus}.`,
    directProbeStatus === 200,
  );

  await initialDesktop.stop();
  await using desktop = await app({
    den: world.den,
    as: "admin",
    place,
    profileDir,
    workspacePath,
  });
  const relaunchedSession = await localServerRequest(desktop, "/den-session", {
    method: "PUT",
    body: { baseUrl: world.den.ref.apiUrl, token: world.den.admin.token, orgId: activeOrgId },
  });
  expect(relaunchedSession.status).toBe(204);
  const relaunchedSync = await localServerRequest(desktop, "/cloud-provider-sync/run", {
    method: "POST",
    body: { reason: "eval_azure_byok_live_relaunch" },
  });
  expect(relaunchedSync.status).toBe(200);

  const { workspaceId } = await createAndSelectWorkspace(desktop, {
    path: join(tmpdir(), `openwork-azure-live-ready-${process.pid}-${Date.now()}`),
  });
  await go(desktop, `/workspace/${workspaceId}/session`);
  const models = await eventually(() => readAvailableModels(desktop), {
    within: 90_000,
    intervalMs: 2_000,
    label: "selectable managed Azure deployment after isolated relaunch",
    until: (available) => available.some((model) => model.selectable
      && (model.id === deploymentId || model.id.endsWith(`/${deploymentId}`))),
  });
  const model = models.find((candidate) => candidate.selectable
    && (candidate.id === deploymentId || candidate.id.endsWith(`/${deploymentId}`)));
  if (!model) throw new Error("The managed Azure deployment was not selectable after relaunch.");
  const selected = await selectModel(desktop, model.id, { provider: model.providerName });
  expect(selected.selected).toBe(true);

  const prompt = "Reply with exactly AZURE BYOK OK.";
  await sendPromptThroughControl(desktop, prompt);
  const assistant = await waitForAssistantReply(desktop, { timeoutMs: 120_000 });
  const conversationSucceeded = assistant.assistantMessageCount > 0
    && assistant.text.trim().length > 0
    && !/invalid subscription key|wrong api endpoint|rate limit/i.test(assistant.text);
  evidence.recordAssertionEvidence(
    "A real isolated Electron conversation completes through the managed Azure deployment",
    "The selected deployment returned a non-empty assistant reply without an Azure authentication or rate-limit error.",
    selected.selected && conversationSucceeded,
  );
  expect(conversationSucceeded).toBe(true);
});
