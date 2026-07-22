/**
 * Catalog (non-custom) Azure provider, end to end against the REAL Azure
 * resource: after the admin selects Azure from the models.dev catalog and
 * enters the resource name + API key, the model list is fetched from the
 * resource itself — only the deployments it actually serves are offered,
 * and the 100+ models.dev Azure catalog entries are ignored.
 *
 *   1. Catalog provider: pick "Azure" from the combobox. The models.dev
 *      list (109 models, including gpt-4o) renders as usual.
 *   2. Fill AZURE_RESOURCE_NAME + AZURE_API_KEY in the credential inputs.
 *      The editor probes the resource and swaps the model list for the one
 *      real deployment (gpt-5-mini); gpt-4o and the rest disappear.
 *   3. Pick gpt-5-mini, create the provider: the save accepts the
 *      deployment id and the detail page shows exactly that model.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_WEB_URL          Den web origin
 * - OPENWORK_EVAL_DEN_EMAIL            Seeded admin email
 * - OPENWORK_EVAL_DEN_PASSWORD         Seeded admin password
 * - OPENWORK_EVAL_AZURE_FOUNDRY_RESOURCE  Azure AI Foundry resource name
 * - OPENWORK_EVAL_AZURE_FOUNDRY_API_KEY   Azure AI Foundry key (throwaway)
 */

const RESOURCE_NAME = process.env.OPENWORK_EVAL_AZURE_FOUNDRY_RESOURCE ?? "";
const PROVIDER_NAME = "Acme Azure (Catalog)";
const DEPLOYMENT = "gpt-5-mini";
const CATALOG_NOISE = "gpt-4o";

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
  id: "llm-provider-azure-catalog-deployments",
  title: "Catalog Azure provider offers only the resource's real deployments",
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
      name: "Pick Azure from the catalog: the models.dev list shows",
      run: async (ctx) => {
        const origin = ctx.env.OPENWORK_EVAL_DEN_WEB_URL.trim().replace(/\/+$/, "");
        await ctx.eval(`(() => { location.href = ${JSON.stringify(`${origin}/dashboard/custom-llm-providers/new`)}; return true; })()`);
        await ctx.waitForText("Add a new LLM provider", { timeoutMs: 45_000 });
        await ctx.eval(fillInputExpr(
          `document.querySelector('input[placeholder="Give this key a name"]')`,
          PROVIDER_NAME,
        ));
        // Open the provider combobox, search, and click the "Azure" option.
        await ctx.waitFor(`(() => {
          const combo = document.querySelector('input[role="combobox"]');
          if (!combo) return false;
          combo.click();
          return true;
        })()`, { timeoutMs: 15_000, label: "combobox open" });
        await ctx.eval(fillInputExpr(`document.querySelector('input[role="combobox"]')`, "Azure"));
        await ctx.waitFor(`(() => {
          const listbox = document.querySelector('[role="listbox"]');
          if (!listbox) return false;
          const options = [...listbox.querySelectorAll('button[role="option"]')].filter(
            (el) => (el.textContent ?? "").includes("Azure"),
          );
          options.sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length);
          const option = options[0];
          if (!option) return false;
          // The combobox selects on mousedown, not click.
          option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          return true;
        })()`, { timeoutMs: 15_000, label: "Azure option" });
        await ctx.prove("Before credentials, the models.dev Azure catalog renders (gpt-4o included)", {
          action: async () => {},
          assert: async () => {
            await ctx.waitForText(CATALOG_NOISE, { timeoutMs: 30_000 });
            await ctx.expectText(DEPLOYMENT, { timeoutMs: 10_000 });
            // Bring the models list into view so the frame shows it.
            await ctx.eval(`(() => {
              const el = [...document.querySelectorAll("h2")].find((h) =>
                (h.textContent ?? "").trim() === "Models",
              );
              el?.scrollIntoView({ block: "start" });
              return true;
            })()`);
          },
          screenshot: {
            name: "catalog-models-dev-list",
            claim: "Azure selected from the catalog; the models.dev model list (including gpt-4o) is offered.",
            requireText: [CATALOG_NOISE],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Resource name + key swap the list for the resource's deployments",
      run: async (ctx) => {
        await ctx.prove(
          "Entering resource name + API key replaces the catalog with the deployments the resource actually serves",
          {
            action: async () => {
              await ctx.eval(fillInputExpr(
                `[...document.querySelectorAll('input[type="password"]')].find((el) => el.placeholder.includes("AZURE_RESOURCE_NAME"))`,
                RESOURCE_NAME,
              ));
              await ctx.eval(fillInputExpr(
                `[...document.querySelectorAll('input[type="password"]')].find((el) => el.placeholder.includes("AZURE_API_KEY"))`,
                ctx.env.OPENWORK_EVAL_AZURE_FOUNDRY_API_KEY,
              ));
            },
            assert: async () => {
              await ctx.waitForText("available on your Azure resource.", { timeoutMs: 60_000 });
              await ctx.expectText(DEPLOYMENT, { timeoutMs: 10_000 });
              await ctx.expectNoText(CATALOG_NOISE);
              // Bring the models section into view so the frame shows it.
              await ctx.eval(`(() => {
                const el = [...document.querySelectorAll("p")].find((p) =>
                  (p.textContent ?? "").includes("available on your Azure resource."),
                );
                el?.scrollIntoView({ block: "center" });
                return true;
              })()`);
            },
            screenshot: {
              name: "deployments-only",
              claim: "Model list now shows only the resource's real deployment (gpt-5-mini); gpt-4o and the rest of models.dev are gone.",
              requireText: ["available on your Azure resource.", DEPLOYMENT],
              rejectText: [CATALOG_NOISE, "Something went wrong"],
            },
          },
        );
      },
    },
    {
      name: "Pick the deployment and create the provider",
      run: async (ctx) => {
        await ctx.prove("The save accepts the deployment id and persists exactly that model", {
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
            await ctx.waitForText("1 model selected", { timeoutMs: 15_000 });
            await ctx.clickText("Create Provider", { timeoutMs: 15_000 });
            await ctx.waitFor(
              "location.pathname.match(/custom-llm-providers\\/lpr_[a-z0-9]+$/) !== null",
              { timeoutMs: 45_000, label: "provider detail page" },
            );
          },
          assert: async () => {
            await ctx.expectText(PROVIDER_NAME, { timeoutMs: 20_000 });
            await ctx.expectText(DEPLOYMENT, { timeoutMs: 10_000 });
            const persisted = await ctx.eval(`(async () => {
              const list = await (await fetch("/api/den/v1/llm-providers", { credentials: "include" })).json();
              const provider = (list.llmProviders ?? []).find((p) => p.name === ${JSON.stringify(PROVIDER_NAME)});
              if (!provider) return null;
              return { providerId: provider.providerId, source: provider.source, modelIds: (provider.models ?? []).map((m) => m.id) };
            })()`, { awaitPromise: true });
            ctx.assert(persisted !== null, "Saved provider not found via the API.");
            ctx.assert(persisted.providerId === "azure", `Wrong providerId: ${persisted?.providerId}`);
            ctx.assert(persisted.source === "models_dev", `Wrong source: ${persisted?.source}`);
            ctx.assert(
              JSON.stringify(persisted.modelIds) === JSON.stringify([DEPLOYMENT]),
              `Wrong models persisted: ${JSON.stringify(persisted?.modelIds)}`,
            );
          },
          screenshot: {
            name: "catalog-provider-created",
            claim: "Catalog Azure provider saved with exactly the picked deployment.",
            requireText: [PROVIDER_NAME, DEPLOYMENT],
            rejectText: [CATALOG_NOISE, "Something went wrong"],
          },
        });
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
