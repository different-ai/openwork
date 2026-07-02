/**
 * Provider editor Stage 1+2: entering a base URL + key probes the endpoint,
 * heals URL mistakes, and replaces free-text model IDs with a picker of the
 * models the endpoint actually serves.
 *
 * Drives the real Den web editor (Chrome CDP) against a real local mock
 * OpenAI endpoint started by this flow:
 *   1. Custom provider form: type a base URL with the classic wrong suffix
 *      (/chat/completions) + the key.
 *   2. The form reports "Endpoint reachable", heals the URL field, and
 *      shows the endpoint's model list.
 *   3. Pick two models by clicking rows, create the provider.
 *   4. The provider detail page shows the normalized base URL and exactly
 *      the picked models.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_WEB_URL   Den web origin (e.g. http://localhost:3015)
 * - OPENWORK_EVAL_DEN_EMAIL     Seeded user email (sign-in fallback)
 * - OPENWORK_EVAL_DEN_PASSWORD  Seeded user password (sign-in fallback)
 */

import { createServer } from "node:http";

const MOCK_PORT = 18092;
const GOOD_KEY = "picker-key-123";
const MOCK_MODELS = ["gpt-5-mini", "gpt-5.2-chat", "dall-e-2"];
const PROVIDER_NAME = "Probe Picker Eval";
const PICKED = ["gpt-5-mini", "gpt-5.2-chat"];

function startMockOpenAiServer() {
  const server = createServer((req, res) => {
    const authorized =
      req.headers.authorization === `Bearer ${GOOD_KEY}` || req.headers["api-key"] === GOOD_KEY;
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(authorized ? 200 : 401, { "content-type": "application/json" });
      res.end(
        authorized
          ? JSON.stringify({ object: "list", data: MOCK_MODELS.map((id) => ({ id, object: "model" })) })
          : JSON.stringify({ error: { message: "invalid api key" } }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

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
  id: "llm-provider-probe-picker",
  title: "Editor probes the endpoint, heals the URL, and offers real models to pick",
  spec: "evals/cloud-provider-sync-flows.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_EMAIL", "OPENWORK_EVAL_DEN_PASSWORD"],
  steps: [
    {
      name: "Signed-in dashboard session (signs in if needed) + mock endpoint",
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
        ctx.mockServer = await startMockOpenAiServer();
        ctx.log(`Mock endpoint on 127.0.0.1:${MOCK_PORT}`);
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
      name: "URL + key probe heals the URL and loads the endpoint's models",
      run: async (ctx) => {
        await ctx.prove("Typing URL (with the classic wrong suffix) + key surfaces the real model list", {
          action: async () => {
            await ctx.eval(fillInputExpr(
              `document.querySelector('input[placeholder="Give this key a name"]')`,
              PROVIDER_NAME,
            ));
            await ctx.eval(fillInputExpr(
              `document.querySelector('input[placeholder="https://my-resource.openai.azure.com/openai/v1"]')`,
              `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`,
            ));
            await ctx.eval(fillInputExpr(
              `document.querySelector('input[type="password"]')`,
              GOOD_KEY,
            ));
          },
          assert: async () => {
            await ctx.waitForText("Endpoint reachable — 3 models available.", { timeoutMs: 30_000 });
            const healed = await ctx.eval(
              `document.querySelector('input[placeholder="https://my-resource.openai.azure.com/openai/v1"]')?.value`,
            );
            ctx.assert(
              healed === `http://127.0.0.1:${MOCK_PORT}/v1`,
              `Base URL not healed: ${healed}`,
            );
            for (const id of MOCK_MODELS) {
              await ctx.expectText(id, { timeoutMs: 10_000 });
            }
          },
          screenshot: {
            name: "probe-model-list",
            claim: "The form healed the URL and lists the endpoint's real models to pick.",
            requireText: ["Endpoint reachable — 3 models available.", "gpt-5-mini"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Pick two models by clicking their rows",
      run: async (ctx) => {
        await ctx.prove("Models are picked by click, not typed", {
          action: async () => {
            for (const id of PICKED) {
              // Click the smallest button containing the model id (the
              // selectable row), not the first page-level wrapper div.
              await ctx.waitFor(`(() => {
                const buttons = [...document.querySelectorAll("button")].filter(
                  (el) => (el.textContent ?? "").includes(${JSON.stringify(id)}),
                );
                buttons.sort((a, b) => (a.textContent ?? "").length - (b.textContent ?? "").length);
                const row = buttons[0];
                if (!row) return false;
                row.scrollIntoView({ block: "center" });
                row.click();
                return true;
              })()`, { timeoutMs: 15_000, label: `model row ${id}` });
            }
          },
          assert: async () => {
            await ctx.waitForText("2 models selected", { timeoutMs: 15_000 });
          },
          screenshot: {
            name: "models-picked",
            claim: "Two endpoint models selected via the picker.",
            requireText: ["2 models selected"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Create the provider and verify the stored payload",
      run: async (ctx) => {
        await ctx.prove("The saved provider carries the healed URL and exactly the picked models", {
          action: async () => {
            await ctx.clickText("Create Provider", { timeoutMs: 15_000 });
            await ctx.waitFor(
              "location.pathname.match(/custom-llm-providers\\/lpr_[a-z0-9]+$/) !== null",
              { timeoutMs: 45_000, label: "provider detail page" },
            );
          },
          assert: async () => {
            await ctx.expectText(PROVIDER_NAME, { timeoutMs: 20_000 });
            await ctx.expectText(`http://127.0.0.1:${MOCK_PORT}/v1`, { timeoutMs: 15_000 });
            for (const id of PICKED) {
              await ctx.expectText(id, { timeoutMs: 10_000 });
            }
            await ctx.expectNoText("dall-e-2");
          },
          screenshot: {
            name: "provider-created",
            claim: "Provider detail shows the healed base URL and only the picked models.",
            requireText: [PROVIDER_NAME, ...PICKED],
            rejectText: ["dall-e-2", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        await denApiDelete(ctx, PROVIDER_NAME);
        await new Promise((resolve) => ctx.mockServer?.close(resolve));
      },
    },
  ],
};
