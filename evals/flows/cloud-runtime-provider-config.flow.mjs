/**
 * Cloud providers are runtime-managed: importing an org LLM provider from
 * Settings -> Cloud writes it into the OpenWork server's runtime config
 * (per-key provider merge), NOT into the user's opencode.jsonc — and a
 * legacy jsonc block left by pre-runtime builds is migrated (stripped).
 *
 * Flow (real app + real Den):
 *   1. Sign in via desktop handoff.
 *   2. Create a custom LLM provider on Den via API; pre-seed a legacy-style
 *      opencode.jsonc block for its id (migration proof).
 *   3. Settings -> Cloud providers: click "Import". The engine serves the
 *      provider while opencode.jsonc contains NO block for it — including
 *      the seeded legacy block, which the import stripped.
 *   4. PATCH the provider on Den to add a second model; the row shows
 *      "Out of sync"; click "Sync" — the engine reports the new model and
 *      opencode.jsonc stays clean (reimport upserts the runtime entry).
 *   5. Cleanup: delete the provider on Den; per-key runtime null-delete
 *      removes it from the engine.
 *
 * (The palette "Sync cloud config" command and the 30s auto-sync latency
 * assertions lived in the reverted #2414 and return with its re-land.)
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL  Den API base
 * - OPENWORK_EVAL_DEN_TOKEN    Bearer session token for a seeded org owner
 */

const PROVIDER_NAME = "Runtime Config Eval";
const MODEL_A = "sync-model-a";
const MODEL_B = "sync-model-b";

const providerConfig = (modelIds) => ({
  id: "runtime-config-eval",
  name: PROVIDER_NAME,
  npm: "@ai-sdk/openai-compatible",
  env: ["RUNTIME_CONFIG_EVAL_API_KEY"],
  api: "https://runtime-config-eval.example.com/v1",
  models: modelIds.map((id) => ({ id, name: id })),
});

// Reads the engine-reported provider list through the OpenWork server proxy,
// using the app's own token/port from inside the page. The workspace id is
// injected (settings routes do not carry it in the hash). Returns the models
// of the imported cloud provider matched by its lpr_* id, or null when absent.
const engineProviderModelsExpr = (workspaceId, cloudProviderId) => `(async () => {
  const port = localStorage.getItem("openwork.server.port");
  const token = localStorage.getItem("openwork.server.token");
  const workspaceId = ${JSON.stringify(workspaceId)};
  if (!port || !token || !workspaceId) return null;
  const base = "http://127.0.0.1:" + port;
  const headers = { Authorization: "Bearer " + token };
  const wsResponse = await fetch(base + "/workspaces", { headers });
  if (!wsResponse.ok) return null;
  const wsPayload = await wsResponse.json();
  const workspaceList = Array.isArray(wsPayload) ? wsPayload : wsPayload.items ?? [];
  const workspace = workspaceList.find((entry) => entry.id === workspaceId);
  const directory = workspace?.path ?? "";
  const url = base + "/workspace/" + workspaceId + "/opencode/provider" +
    (directory ? "?directory=" + encodeURIComponent(directory) : "");
  const response = await fetch(url, { headers });
  if (!response.ok) return null;
  const payload = await response.json();
  const provider = (payload.all ?? []).find((entry) => entry.id === ${JSON.stringify(cloudProviderId)});
  if (!provider) return null;
  return Object.keys(provider.models ?? {}).sort();
})()`;

async function denRequest(ctx, path, init = {}) {
  const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  ctx.assert(response.ok || init.allowStatuses?.includes(response.status), `${init.method ?? "GET"} ${path} failed: ${response.status} ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : null;
}

// ctx.waitFor cannot await promises, so async engine reads poll from flow code.
async function pollEngineModels(ctx, predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const models = await ctx
      .eval(engineProviderModelsExpr(ctx.workspaceId, ctx.providerId), { awaitPromise: true })
      .catch(() => undefined);
    if (models !== undefined && predicate(models)) return models;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
}

// Read/write the workspace project opencode.jsonc via the OpenWork server
// config-file API, from inside the page (uses the app's own token/port).
const configFileExpr = (workspaceId, method, contentJson) => `(async () => {
  const port = localStorage.getItem("openwork.server.port");
  const token = localStorage.getItem("openwork.server.token");
  const workspaceId = ${JSON.stringify(workspaceId)};
  if (!port || !token || !workspaceId) return null;
  const base = "http://127.0.0.1:" + port;
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  if (${JSON.stringify(method)} === "GET") {
    const file = await (await fetch(base + "/workspace/" + workspaceId + "/opencode-config?scope=project", { headers })).json();
    return file.content ?? "";
  }
  const response = await fetch(base + "/workspace/" + workspaceId + "/opencode-config", {
    method: "POST", headers,
    body: JSON.stringify({ scope: "project", content: ${contentJson} }),
  });
  return response.status;
})()`;

async function readProjectConfig(ctx) {
  return await ctx.eval(configFileExpr(ctx.workspaceId, "GET", "null"), { awaitPromise: true });
}

async function assertNoJsoncFootprint(ctx, context) {
  const raw = await readProjectConfig(ctx);
  ctx.assert(
    typeof raw === "string" && !raw.includes(ctx.providerId),
    `opencode.jsonc contains a block for the imported provider ${context}`,
  );
}

async function openCloudProvidersView(ctx) {
  await ctx.navigateHash("/settings/cloud-providers");
  await ctx.waitFor("window.location.hash.includes('/settings/cloud-providers')", { timeoutMs: 20_000 });
  // Same-route navigation does not remount the view; force a refetch so a
  // provider created moments ago on Den is listed.
  await ctx.clickText("Refresh", { selector: "button", timeoutMs: 30_000 });
  await ctx.waitForText(PROVIDER_NAME, { timeoutMs: 45_000 });
}

// Click the action button (exact label) inside the list row that mentions the
// provider — substring clicks are unsafe here ("Imported 5" contains "Import").
const rowButtonExpr = (label) => `(() => {
  const buttons = [...document.querySelectorAll("button")].filter(
    (el) => (el.textContent ?? "").trim() === ${JSON.stringify(label)},
  );
  for (const button of buttons) {
    let node = button.parentElement;
    for (let depth = 0; depth < 8 && node; depth += 1, node = node.parentElement) {
      const text = node.textContent ?? "";
      if (text.includes(${JSON.stringify(PROVIDER_NAME)}) && text.length < 600) {
        button.scrollIntoView({ block: "center" });
        button.click();
        return true;
      }
    }
  }
  return false;
})()`;

async function clickProviderRowButton(ctx, label) {
  await ctx.waitFor(rowButtonExpr(label), {
    timeoutMs: 30_000,
    label: `"${label}" button on the ${PROVIDER_NAME} row`,
  });
}

export default {
  id: "cloud-runtime-provider-config",
  title: "Cloud provider import/sync lives in runtime config, not opencode.jsonc",
  spec: "evals/cloud-provider-sync-flows.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000 });
        const workspaceId = await ctx.eval(
          "localStorage.getItem('openwork.react.activeWorkspace') ?? ''",
        );
        ctx.assert(Boolean(workspaceId), "No active workspace recorded.");
        ctx.workspaceId = workspaceId;
      },
    },
    {
      name: "Sign in to OpenWork Cloud via desktop handoff",
      run: async (ctx) => {
        const signedIn = await ctx.eval(
          "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
        );
        if (signedIn) {
          ctx.log("Already signed in; reusing session.");
          return;
        }
        const payload = await denRequest(ctx, "/v1/auth/desktop-handoff", {
          method: "POST",
          body: JSON.stringify({ desktopScheme: "openwork" }),
        });
        ctx.assert(typeof payload.openworkUrl === "string" && payload.openworkUrl.length > 0, "No openworkUrl in handoff response.");
        await ctx.navigateHash("/settings/cloud-account");
        await ctx.clickText("Paste sign-in code", { timeoutMs: 30_000 });
        await ctx.fill("#den-signin-link", payload.openworkUrl);
        await ctx.clickText("Finish sign-in");
        await ctx.waitFor(
          "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
          { timeoutMs: 45_000, label: "persisted den auth token" },
        );
      },
    },
    {
      name: "Complete org onboarding when offered",
      run: async (ctx) => {
        // A fresh sign-in routes through the org chooser; a reused session
        // skips it (both dialogs are absent then).
        const clickByText = async (text) =>
          await ctx.eval(`(() => {
            const nodes = [...document.querySelectorAll("button, [role=option], div")].filter(
              (el) => (el.textContent ?? "").trim().startsWith(${JSON.stringify(text)}),
            );
            nodes.sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length);
            if (!nodes[0]) return false;
            nodes[0].click();
            return true;
          })()`);
        if (await ctx.eval(`document.body.innerText.includes("Choose your organization")`)) {
          await clickByText("Acme Robotics");
          await clickByText("Continue with organization");
          await ctx.waitFor(
            `!document.body.innerText.includes("Choose your organization")`,
            { timeoutMs: 20_000, label: "org chooser dismissed" },
          );
        }
        if (await ctx.eval(`document.body.innerText.includes("Continue to workspace")`)) {
          await clickByText("Continue to workspace");
        }
      },
    },
    {
      name: "Create the org LLM provider on Den + seed a legacy jsonc block",
      run: async (ctx) => {
        const existing = await denRequest(ctx, "/v1/llm-providers");
        for (const provider of existing.llmProviders ?? []) {
          if (provider.name === PROVIDER_NAME) {
            await denRequest(ctx, `/v1/llm-providers/${encodeURIComponent(provider.id)}`, { method: "DELETE", allowStatuses: [204, 404] });
          }
        }
        const created = await denRequest(ctx, "/v1/llm-providers", {
          method: "POST",
          body: JSON.stringify({
            name: PROVIDER_NAME,
            source: "custom",
            customConfig: providerConfig([MODEL_A]),
            apiKey: "sk-runtime-config-eval",
            memberIds: [],
            teamIds: [],
          }),
        });
        ctx.providerId = created.llmProvider?.id;
        ctx.assert(typeof ctx.providerId === "string" && ctx.providerId.length > 0, "Provider create returned no id.");
        ctx.log(`Created Den provider ${ctx.providerId}`);

        // Seed a legacy-style jsonc block for this provider id so the flow
        // proves the migration path: the import must strip it. The eval
        // workspace's project config is owned by this flow, so write a
        // canonical file (regex insertion into arbitrary JSONC is how you
        // manufacture trailing commas).
        const raw = await readProjectConfig(ctx);
        ctx.assert(raw !== null, "Could not reach the project opencode.jsonc API.");
        const nextContent = `${JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            provider: {
              [ctx.providerId]: {
                npm: "@ai-sdk/openai-compatible",
                name: "Legacy Stale Block",
                models: { "stale-model": { name: "stale-model" } },
              },
            },
            disabled_providers: [],
          },
          null,
          2,
        )}\n`;
        const status = await ctx.eval(configFileExpr(ctx.workspaceId, "POST", JSON.stringify(nextContent)), { awaitPromise: true });
        ctx.assert(status === 200, `Seeding legacy block failed: ${status}`);
        ctx.log("Seeded legacy jsonc block for migration proof");
      },
    },
    {
      name: "Settings -> Cloud 'Import' injects the provider via runtime config",
      run: async (ctx) => {
        await openCloudProvidersView(ctx);
        await ctx.prove("Importing a cloud provider leaves opencode.jsonc untouched (and migrates the legacy block)", {
          action: async () => {
            await clickProviderRowButton(ctx, "Import");
            // The store returns "Connected <name>"; the view toasts it verbatim.
            await ctx.waitForText(`Connected ${PROVIDER_NAME}`, { timeoutMs: 90_000 });
          },
          assert: async () => {
            await pollEngineModels(
              ctx,
              (models) => Array.isArray(models) && models.includes(MODEL_A),
              90_000,
              "engine reports the imported provider with its model",
            );
            // Runtime injection proof: the provider is served by the engine
            // while the workspace opencode.jsonc contains no block for it —
            // including the legacy block we seeded, which must be migrated.
            await assertNoJsoncFootprint(ctx, "(runtime injection failed or migration did not strip the legacy block)");
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: "Imported provider is engine-visible with zero opencode.jsonc footprint (runtime config injection; legacy block migrated)",
            });
          },
          screenshot: {
            name: "import-runtime-injected",
            claim: "Provider imported from Settings -> Cloud; the engine serves it via runtime config.",
            requireText: [PROVIDER_NAME],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/cloud-providers",
          },
        });
      },
    },
    {
      name: "Den model add -> 'Out of sync' -> Sync upserts the runtime entry",
      run: async (ctx) => {
        await denRequest(ctx, `/v1/llm-providers/${encodeURIComponent(ctx.providerId)}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: PROVIDER_NAME,
            source: "custom",
            customConfig: providerConfig([MODEL_A, MODEL_B]),
            memberIds: [],
            teamIds: [],
          }),
        });
        // Remount the view so it refetches Den state and detects the drift.
        await ctx.navigateHash("/settings/cloud-account");
        await openCloudProvidersView(ctx);
        await ctx.prove("A Den-side model add is offered as 'Out of sync' and lands via Sync", {
          action: async () => {
            await ctx.waitForText("Out of sync", { timeoutMs: 30_000 });
            await clickProviderRowButton(ctx, "Sync");
            await ctx.waitForText(`Synced ${PROVIDER_NAME}.`, { timeoutMs: 90_000 });
          },
          assert: async () => {
            await pollEngineModels(
              ctx,
              (models) => Array.isArray(models) && models.includes(MODEL_B),
              90_000,
              `engine reports ${MODEL_B} after Sync`,
            );
            await assertNoJsoncFootprint(ctx, "after reimport (upsert must stay in runtime config)");
          },
          screenshot: {
            name: "sync-upserts-runtime",
            claim: "Sync pulled the Den model change into the engine; opencode.jsonc still has no provider block.",
            requireText: ["Synced", PROVIDER_NAME],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/cloud-providers",
          },
        });
      },
    },
    {
      name: "Cleanup: delete the provider on Den and null the runtime entry",
      run: async (ctx) => {
        await denRequest(ctx, `/v1/llm-providers/${encodeURIComponent(ctx.providerId)}`, { method: "DELETE", allowStatuses: [204, 404] });
        // Removal UI is not exposed on this view yet (cloudImports race,
        // tracked separately). Clean deterministically via the same per-key
        // runtime merge the store uses: null deletes.
        const status = await ctx.eval(`(async () => {
          const port = localStorage.getItem("openwork.server.port");
          const token = localStorage.getItem("openwork.server.token");
          const workspaceId = ${JSON.stringify(ctx.workspaceId)};
          if (!port || !token || !workspaceId) return null;
          const base = "http://127.0.0.1:" + port;
          const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
          const response = await fetch(base + "/workspace/" + workspaceId + "/config", {
            method: "PATCH", headers,
            body: JSON.stringify({ opencode: { provider: { [${JSON.stringify(ctx.providerId)}]: null } } }),
          });
          return response.status;
        })()`, { awaitPromise: true });
        ctx.assert(status === 200, `Runtime null-delete failed: ${status}`);
        // The store's removal path reloads the engine itself; this direct
        // cleanup needs an explicit reload for the engine to drop the entry.
        await ctx.eval(`(async () => {
          const port = localStorage.getItem("openwork.server.port");
          const token = localStorage.getItem("openwork.server.token");
          const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + ${JSON.stringify(ctx.workspaceId)} + "/engine/reload", {
            method: "POST", headers: { Authorization: "Bearer " + token },
          });
          return response.status;
        })()`, { awaitPromise: true }).catch(() => null);
        await pollEngineModels(
          ctx,
          (models) => models === null,
          90_000,
          "provider removed from the engine after runtime null-delete",
        );
      },
    },
  ],
};
