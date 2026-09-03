import { createServer } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import {
  createAndSelectWorkspace,
  desktop,
  evalIn,
  go,
  readAvailableModels,
  waitFor,
} from "@openwork/testkit/stack";
import { needs, test } from "@openwork/testkit";

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

async function configureProvider(
  app: Parameters<typeof evalIn>[0],
  workspaceId: string,
  config: ReturnType<typeof createOpencodeConfig>,
): Promise<void> {
  const result = await evalIn(app, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return "local_server_unavailable";
    const root = String(info.baseUrl).replace(/\\/+$/, "");
    const headers = {
      Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
      "Content-Type": "application/json",
    };
    const configured = await fetch(root + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/config", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ opencode: ${JSON.stringify(config)} }),
      signal: AbortSignal.timeout(30000),
    });
    if (!configured.ok) return "config:" + configured.status + ":" + (await configured.text()).slice(0, 300);
    const reloaded = await fetch(root + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/engine/reload", {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(60000),
    });
    return reloaded.ok ? "ok" : "reload:" + reloaded.status + ":" + (await reloaded.text()).slice(0, 300);
  })()`, { awaitPromise: true, timeoutMs: 120_000 });
  expect(result).toBe("ok");

  await evalIn(app, "location.reload(); true");
  await waitFor(app, "Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "desktop restored after provider configuration",
  });
}

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
  const workspacePath = `/tmp/openwork-provider-disconnect-${process.pid}-${Date.now()}`;
  onTestFinished(async () => rm(workspacePath, { recursive: true, force: true }));
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "opencode.json"), `${JSON.stringify(opencodeConfig, null, 2)}\n`, "utf8");

  await using app = await desktop({ name: "provider-disconnect-config-defined" });
  const { workspaceId } = await createAndSelectWorkspace(app, { path: workspacePath });
  await configureProvider(app, workspaceId, opencodeConfig);
  await go(app, `/workspace/${workspaceId}/session`);
  await readAvailableModels(app);
  await waitFor(app, `(() => {
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    return Boolean(dialog && dialog.innerText.includes(${JSON.stringify(providerName)}));
  })()`, {
    timeoutMs: 60_000,
    label: "config-defined LiteLLM provider in model picker",
  });
  const expanded = await evalIn(app, `(() => {
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    const header = [...(dialog?.querySelectorAll('button') ?? [])]
      .find((button) => (button.textContent ?? '').includes(${JSON.stringify(providerName)}));
    header?.click();
    return Boolean(header);
  })()`);
  expect(expanded).toBe(true);
  await waitFor(app, `(() => {
    const dialog = document.querySelector('[data-slot="dialog-content"]');
    const header = [...(dialog?.querySelectorAll('button') ?? [])]
      .find((button) => (button.textContent ?? '').includes(${JSON.stringify(providerName)}));
    const group = header?.parentElement?.parentElement;
    return Boolean(group && (group.textContent ?? '').includes(${JSON.stringify(modelId)}));
  })()`, {
    timeoutMs: 15_000,
    label: "config-defined LiteLLM model row",
  });
  const beforeModels = await readAvailableModels(app);
  const fixtureModels = beforeModels.filter(
    (model) => model.providerName === providerName && model.id === modelId,
  );
  expect(fixtureModels, `beforeModels: ${JSON.stringify(beforeModels)}`).not.toHaveLength(0);
  evidence.recordAssertionEvidence(
    "The config-defined provider contributes its model before disconnect",
    `Fixture models: ${JSON.stringify(fixtureModels)}`,
    fixtureModels.length > 0,
  );
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
  const modelStillAvailable = afterModels.some(
    (model) => model.providerName === providerName,
  );
  expect(modelStillAvailable).toBe(false);
  evidence.recordAssertionEvidence(
    "The disconnected provider no longer contributes models",
    `Models matching ${modelId}: ${JSON.stringify(afterModels.filter((model) => model.id === modelId))}`,
    !modelStillAvailable,
  );
});
