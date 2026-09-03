import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import {
  createAndSelectWorkspace,
  evalIn,
  go,
  readAvailableModels,
  waitFor,
} from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { eventually, needs, test } from "@openwork/testkit";

const providerId = "litellm-disconnect-fixture";
const providerName = "Config-defined LiteLLM";
const modelId = "litellm-disconnect-model";
const createOpencodeConfig = (baseURL: string) => ({
  $schema: "https://opencode.ai/config.json",
  provider: {
    [providerId]: {
      npm: "@ai-sdk/openai-compatible",
      name: providerName,
      options: {
        apiKey: "fixture-key",
        baseURL,
      },
      models: {
        [modelId]: { name: "LiteLLM disconnect model" },
      },
    },
  },
});

async function closeModelPicker(app: Parameters<typeof evalIn>[0]): Promise<void> {
  await evalIn(app, `(() => {
    const close = document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]');
    if (close instanceof HTMLElement) close.click();
    return true;
  })()`);
  await waitFor(app, `!document.querySelector('[data-slot="dialog-content"]')`, {
    timeoutMs: 15_000,
    label: "model picker closed",
  });
}

test("disconnect disables a config-defined provider", async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  const provider = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  });
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("The provider fixture did not bind a TCP port.");
  const opencodeConfig = createOpencodeConfig(`http://127.0.0.1:${address.port}/v1`);
  const profileDir = `/tmp/openwork-provider-disconnect-${process.pid}-${Date.now()}`;
  const workspacePath = join(profileDir, "workspace");
  const globalConfigDir = join(profileDir, "opencode-config");
  onTestFinished(async () => rm(profileDir, { recursive: true, force: true }));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(globalConfigDir, { recursive: true });
  await writeFile(join(workspacePath, "opencode.json"), `${JSON.stringify(opencodeConfig, null, 2)}\n`, "utf8");
  await writeFile(join(globalConfigDir, "opencode.json"), `${JSON.stringify(opencodeConfig, null, 2)}\n`, "utf8");

  await using app = await desktop({ name: "provider-disconnect-config-defined", profileDir });
  const { workspaceId } = await createAndSelectWorkspace(app, { path: workspacePath });
  const beforeModels = await eventually(() => readAvailableModels(app), {
    within: 90_000,
    intervalMs: 2_000,
    label: "config-defined LiteLLM model in picker",
    until: (models) => models.some((model) => model.id === modelId && model.selectable),
  });
  expect(beforeModels.some((model) => model.id === modelId && model.selectable)).toBe(true);
  await closeModelPicker(app);

  await go(app, `/workspace/${workspaceId}/settings/ai`);
  await waitFor(app, `document.body.innerText.includes(${JSON.stringify(providerName)})`, {
    timeoutMs: 60_000,
    label: "config-defined provider row",
  });
  const disconnected = await evalIn(app, `(() => {
    const title = [...document.querySelectorAll('span')]
      .find((element) => (element.textContent ?? '').trim() === ${JSON.stringify(providerName)});
    let row = title;
    while (row && ![...row.querySelectorAll('button')]
      .some((button) => (button.textContent ?? '').trim() === 'Disconnect')) {
      row = row.parentElement;
    }
    const button = [...(row?.querySelectorAll('button') ?? [])]
      .find((element) => (element.textContent ?? '').trim() === 'Disconnect' && !element.disabled);
    button?.click();
    return Boolean(button);
  })()`);
  expect(disconnected).toBe(true);
  await waitFor(app, `(() => {
    const page = document.body.innerText;
    const toastVisible = [...document.querySelectorAll('[data-sonner-toast]')]
      .some((toast) => (toast.textContent ?? '').includes(${JSON.stringify(`Disconnected ${providerId}`)}));
    return !page.includes(${JSON.stringify(providerName)}) && toastVisible;
  })()`, { timeoutMs: 60_000, label: "provider removed with disconnect confirmation" });
  const settingsState = await evalIn(app, `({
    providerVisible: document.body.innerText.includes(${JSON.stringify(providerName)}),
    providerEnabled: document.body.innerText.includes(${JSON.stringify(providerName)})
      && document.body.innerText.includes('Enabled'),
  })`);
  expect(settingsState).toEqual({ providerVisible: false, providerEnabled: false });
  evidence.recordAssertionEvidence(
    "Disconnect removes the config-defined provider from AI Providers",
    `Settings state after disconnect: ${JSON.stringify(settingsState)}`,
    true,
  );

  await go(app, `/workspace/${workspaceId}/session`);
  const afterModels = await readAvailableModels(app);
  const modelStillAvailable = afterModels.some((model) => model.id === modelId);
  expect(modelStillAvailable).toBe(false);
  evidence.recordAssertionEvidence(
    "The disconnected provider no longer contributes models",
    `Models matching ${modelId}: ${JSON.stringify(afterModels.filter((model) => model.id === modelId))}`,
    !modelStillAvailable,
  );
});
