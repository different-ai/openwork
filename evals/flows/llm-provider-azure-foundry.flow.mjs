/**
 * Custom Azure Foundry provider, end to end against the REAL Azure resource:
 * an admin sets up a gpt-5 deployment with nothing but a name, a lazily
 * pasted base URL, and a key — no JSON, no custom fields.
 *
 *   1. Custom provider form: name + provider id + the *bare* resource origin
 *      (no /openai/v1) + the key.
 *   2. The probe heals the URL to /openai/v1 and — because this is Azure —
 *      lists the resource's real *deployments* (exactly `gpt-5-mini`), not
 *      the 300+ model catalog that /models answers with.
 *   3. Pick gpt-5-mini, press Create: verify-on-save runs a real completion,
 *      Azure rejects max_tokens, and the provider is silently switched to
 *      the OpenAI request shape (@ai-sdk/openai).
 *   4. The detail page + persisted config match what an expert would have
 *      hand-written: right npm package, right env var, right base URL.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_WEB_URL          Den web origin
 * - OPENWORK_EVAL_DEN_EMAIL            Seeded admin email
 * - OPENWORK_EVAL_DEN_PASSWORD         Seeded admin password
 * - OPENWORK_EVAL_AZURE_FOUNDRY_RESOURCE  Azure AI Foundry resource name
 * - OPENWORK_EVAL_AZURE_FOUNDRY_API_KEY   Azure AI Foundry key (throwaway)
 */

const RESOURCE_ORIGIN = `https://${process.env.OPENWORK_EVAL_AZURE_FOUNDRY_RESOURCE ?? ""}.services.ai.azure.com`;
const HEALED_API = `${RESOURCE_ORIGIN}/openai/v1`;
const PROVIDER_NAME = "Acme Azure Foundry";
const PROVIDER_ID = "acme-foundry";
const DEPLOYMENT = "gpt-5-mini";
const CATALOG_NOISE = "gpt-5-mini-2025-08-07";

const fillInputExpr = (selectorExpr, value) => `(() => {
  const input = ${selectorExpr};
  if (!input) return false;
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

async function denApiDelete(ctx, name) {
  await ctx.eval(`(async () => {
    const list = await (await fetch("/api/den/v1/llm-providers", { credentials: "include" })).json();
    for (const provider of list.llmProviders ?? []) {
      if (provider.name === ${JSON.stringify(name)}) {
        await fetch("/api/den/v1/llm-providers/" + encodeURIComponent(provider.id), { method: "DELETE", credentials: "include" });
      }
    }
    return true;
  })()`, { awaitPromise: true });
}

export default {
  id: "llm-provider-azure-foundry",
  title: "Azure Foundry sets up gpt-5-mini with only name + URL + key",
  spec: "evals/cloud-provider-sync-flows.md",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_DEN_EMAIL",
    "OPENWORK_EVAL_DEN_PASSWORD",
    "OPENWORK_EVAL_AZURE_FOUNDRY_RESOURCE",
    "OPENWORK_EVAL_AZURE_FOUNDRY_API_KEY",
  ],
  steps: [
    {
      name: "Signed-in dashboard session (signs in if needed)",
      run: async (ctx) => {
        const origin = ctx.env.OPENWORK_EVAL_DEN_WEB_URL.trim().replace(/\/+$/, "");
        await ctx.eval(`(() => { location.href = ${JSON.stringify(`${origin}/`)}; return true; })()`);
        await ctx.waitFor(
          `location.origin === ${JSON.stringify(origin)} && document.readyState === "complete"`,
          { timeoutMs: 30_000, label: "den web loaded" },
        );
        const me = await ctx.eval(
          `fetch("/api/den/v1/me", { credentials: "include" }).then((r) => r.status)`,
          { awaitPromise: true },
        );
        if (me !== 200) {
          const signIn = await ctx.eval(`(async () => {
            const response = await fetch("/api/auth/sign-in/email", {
              method: "POST",
              headers: { "content-type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                email: ${JSON.stringify(ctx.env.OPENWORK_EVAL_DEN_EMAIL)},
                password: ${JSON.stringify(ctx.env.OPENWORK_EVAL_DEN_PASSWORD)},
              }),
            });
            return response.status;
          })()`, { awaitPromise: true });
          ctx.assert(signIn === 200, `Sign-in failed (${signIn}).`);
        }
        await denApiDelete(ctx, PROVIDER_NAME);
      },
    },
    {
      name: "Open the custom provider form",
      run: async (ctx) => {
        const origin = ctx.env.OPENWORK_EVAL_DEN_WEB_URL.trim().replace(/\/+$/, "");
        await ctx.eval(`(() => { location.href = ${JSON.stringify(`${origin}/dashboard/custom-llm-providers/new`)}; return true; })()`);
        await ctx.waitForText("Add a new LLM provider", { timeoutMs: 45_000 });
        await ctx.clickText("Custom provider", { selector: "button, [role=tab]", timeoutMs: 15_000 });
        await ctx.waitForText("No JSON required", { timeoutMs: 15_000 });
      },
    },
    {
      name: "Lazy URL + key: heal to /openai/v1 and list the real deployment",
      run: async (ctx) => {
        await ctx.prove(
          "Pasting the bare Azure resource origin + key surfaces the resource's one real deployment, not the model catalog",
          {
            action: async () => {
              await ctx.eval(fillInputExpr(
                `document.querySelector('input[placeholder="Give this key a name"]')`,
                PROVIDER_NAME,
              ));
              await ctx.eval(fillInputExpr(
                `document.querySelector('input[placeholder="azure-foundry"]')`,
                PROVIDER_ID,
              ));
              await ctx.eval(fillInputExpr(
                `document.querySelector('input[placeholder="https://my-resource.openai.azure.com/openai/v1"]')`,
                RESOURCE_ORIGIN,
              ));
              await ctx.eval(fillInputExpr(
                `document.querySelector('input[type="password"]')`,
                ctx.env.OPENWORK_EVAL_AZURE_FOUNDRY_API_KEY,
              ));
            },
            assert: async () => {
              await ctx.waitForText("Endpoint reachable — 1 model available.", { timeoutMs: 45_000 });
              const healed = await ctx.eval(
                `document.querySelector('input[placeholder="https://my-resource.openai.azure.com/openai/v1"]')?.value`,
              );
              ctx.assert(healed === HEALED_API, `Base URL not healed: ${healed}`);
              await ctx.expectText(DEPLOYMENT, { timeoutMs: 10_000 });
              await ctx.expectNoText(CATALOG_NOISE);
              await ctx.expectNoText("dall-e");
            },
            screenshot: {
              name: "probe-deployments",
              claim: "URL healed to /openai/v1; the picker lists exactly the deployed gpt-5-mini.",
              requireText: ["Endpoint reachable — 1 model available.", DEPLOYMENT],
              rejectText: [CATALOG_NOISE, "dall-e", "Something went wrong"],
            },
          },
        );
      },
    },
    {
      name: "Pick the deployment by click",
      run: async (ctx) => {
        await ctx.prove("The model is picked from the endpoint's list, not typed", {
          action: async () => {
            await ctx.waitFor(`(() => {
              const buttons = [...document.querySelectorAll("button")].filter(
                (el) => (el.textContent ?? "").includes(${JSON.stringify(DEPLOYMENT)}),
              );
              buttons.sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length);
              const row = buttons[0];
              if (!row) return false;
              row.scrollIntoView({ block: "center" });
              row.click();
              return true;
            })()`, { timeoutMs: 15_000, label: `model row ${DEPLOYMENT}` });
          },
          assert: async () => {
            await ctx.waitForText("1 model selected", { timeoutMs: 15_000 });
          },
          screenshot: {
            name: "deployment-picked",
            claim: "gpt-5-mini selected via the picker.",
            requireText: ["1 model selected"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Create: verify-on-save adjusts gpt-5 to the OpenAI request shape",
      run: async (ctx) => {
        await ctx.prove(
          "Create runs a real completion, detects the max_tokens rejection, and saves with @ai-sdk/openai",
          {
            action: async () => {
              await ctx.clickText("Create Provider", { timeoutMs: 15_000 });
              // Verification sends a real gpt-5-mini completion — allow time.
              await ctx.waitFor(
                "location.pathname.match(/custom-llm-providers\\/lpr_[a-z0-9]+$/) !== null",
                { timeoutMs: 90_000, label: "provider detail page" },
              );
            },
            assert: async () => {
              await ctx.expectText(PROVIDER_NAME, { timeoutMs: 20_000 });
              await ctx.expectText("@ai-sdk/openai", { timeoutMs: 15_000 });
              await ctx.expectText(HEALED_API, { timeoutMs: 15_000 });
              await ctx.expectText(DEPLOYMENT, { timeoutMs: 10_000 });
              const persisted = await ctx.eval(`(async () => {
                const list = await (await fetch("/api/den/v1/llm-providers", { credentials: "include" })).json();
                const provider = (list.llmProviders ?? []).find((p) => p.name === ${JSON.stringify(PROVIDER_NAME)});
                if (!provider) return null;
                const raw = provider.providerConfig;
                const config = typeof raw === "string" ? JSON.parse(raw) : raw;
                return { config, modelIds: (provider.models ?? []).map((m) => m.id) };
              })()`, { awaitPromise: true });
              ctx.assert(persisted !== null, "Saved provider config not found via the API.");
              const { config, modelIds } = persisted;
              ctx.assert(config.npm === "@ai-sdk/openai", `Wrong npm package persisted: ${config?.npm}`);
              ctx.assert(config.api === HEALED_API, `Wrong api persisted: ${config?.api}`);
              ctx.assert(
                JSON.stringify(config.env) === JSON.stringify(["ACME_FOUNDRY_API_KEY"]),
                `Wrong env persisted: ${JSON.stringify(config?.env)}`,
              );
              ctx.assert(
                JSON.stringify(modelIds) === JSON.stringify([DEPLOYMENT]),
                `Wrong models persisted: ${JSON.stringify(modelIds)}`,
              );
            },
            screenshot: {
              name: "provider-created-openai-shape",
              claim: "Detail page shows the provider saved with @ai-sdk/openai, the healed API base, and gpt-5-mini.",
              requireText: [PROVIDER_NAME, "@ai-sdk/openai", DEPLOYMENT],
              rejectText: ["Something went wrong"],
            },
          },
        );
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        await denApiDelete(ctx, PROVIDER_NAME);
      },
    },
  ],
};
