/**
 * den-api `POST /v1/llm-providers/test-connection`: probing an
 * OpenAI-compatible endpoint returns the models it actually serves, heals
 * common base-URL mistakes, distinguishes bad keys, and refuses cloud
 * metadata targets.
 *
 * Driven from a real signed-in Den web session (Chrome CDP): every request
 * goes through the dashboard's `/api/den` proxy with the session cookie —
 * i.e. exactly what the provider editor will call in the follow-up PR. The
 * upstream endpoint is a real local HTTP server started by this flow.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_WEB_URL   Den web origin (e.g. http://localhost:3015)
 * - OPENWORK_EVAL_DEN_EMAIL     Seeded user email (sign-in fallback)
 * - OPENWORK_EVAL_DEN_PASSWORD  Seeded user password (sign-in fallback)
 */

import { createServer } from "node:http";

const MOCK_PORT = 18091;
const GOOD_KEY = "test-key-123";
const MOCK_MODELS = ["gpt-5-mini", "gpt-5.2-chat", "dall-e-2"];

function startMockOpenAiServer() {
  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const apiKey = req.headers["api-key"];
    const authorized = auth === `Bearer ${GOOD_KEY}` || apiKey === GOOD_KEY;
    if (req.method === "GET" && req.url === "/v1/models") {
      if (!authorized) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid api key" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: MOCK_MODELS.map((id) => ({ id, object: "model" })) }));
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

// Runs a probe from inside the signed-in dashboard page (session cookie +
// same-origen /api/den proxy — the exact path the provider editor uses).
const probeExpr = (body) => `(async () => {
  const response = await fetch("/api/den/v1/llm-providers/test-connection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: ${JSON.stringify(JSON.stringify(body))},
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, result: payload?.result ?? null };
})()`;

export default {
  id: "llm-provider-test-connection-api",
  title: "Provider test-connection probe returns real models and heals URLs",
  spec: "evals/cloud-provider-sync-flows.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_EMAIL", "OPENWORK_EVAL_DEN_PASSWORD"],
  steps: [
    {
      name: "Signed-in dashboard session is available (signs in if needed)",
      run: async (ctx) => {
        const origin = ctx.env.OPENWORK_EVAL_DEN_WEB_URL.trim().replace(/\/+$/, "");
        const onOrigin = await ctx.eval(`location.origin === ${JSON.stringify(origin)}`);
        if (!onOrigin) {
          await ctx.eval(`(() => { location.href = ${JSON.stringify(`${origin}/`)}; return true; })()`);
        }
        await ctx.waitFor(
          `location.origin === ${JSON.stringify(origin)} && document.readyState === "complete"`,
          { timeoutMs: 30_000, label: "den web loaded" },
        );

        const me = await ctx.eval(
          `fetch("/api/den/v1/me", { credentials: "include" }).then((r) => r.status)`,
          { awaitPromise: true },
        );
        if (me !== 200) {
          ctx.log("No session; signing in via the auth API.");
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
          const meAfter = await ctx.eval(
            `fetch("/api/den/v1/me", { credentials: "include" }).then((r) => r.status)`,
            { awaitPromise: true },
          );
          ctx.assert(meAfter === 200, `Session still not valid after sign-in (GET /v1/me -> ${meAfter}).`);
        }
      },
    },
    {
      name: "Start the mock OpenAI-compatible endpoint",
      run: async (ctx) => {
        ctx.mockServer = await startMockOpenAiServer();
        ctx.log(`Mock endpoint listening on 127.0.0.1:${MOCK_PORT}`);
      },
    },
    {
      name: "Probe heals a wrong URL suffix and returns the served models",
      run: async (ctx) => {
        await ctx.prove("A probe with the exact real-world URL mistake still finds the models", {
          action: async () => {
            // The literal mistake from the customer session: a pasted URL
            // ending in /chat/completions instead of the bare /v1 base.
            ctx.probe = await ctx.eval(
              probeExpr({ api: `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`, apiKey: GOOD_KEY }),
              { awaitPromise: true },
            );
          },
          assert: async () => {
            const { status, result } = ctx.probe;
            ctx.assert(status === 200, `Probe endpoint returned ${status}`);
            ctx.assert(result?.ok === true, `Probe not ok: ${JSON.stringify(result)}`);
            ctx.assert(
              result.normalizedApi === `http://127.0.0.1:${MOCK_PORT}/v1`,
              `URL not normalized: ${result.normalizedApi}`,
            );
            const ids = (result.models ?? []).map((m) => m.id);
            for (const id of MOCK_MODELS) {
              ctx.assert(ids.includes(id), `Missing model ${id} in ${ids.join(",")}`);
            }
            ctx.recordEvidence({
              type: "assertion",
              status: "passed",
              assertion: `Probe normalized ${MOCK_PORT}/v1/chat/completions -> /v1 and returned ${ids.length} real models`,
            });
          },
          screenshot: {
            name: "probe-ok",
            claim: "Signed-in dashboard session can probe an endpoint and get its real model list.",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "A bad key is reported as a key problem, not a mystery",
      run: async (ctx) => {
        const { status, result } = await ctx.eval(
          probeExpr({ api: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: "wrong-key" }),
          { awaitPromise: true },
        );
        ctx.assert(status === 200, `Probe endpoint returned ${status}`);
        ctx.assert(result?.ok === false, "Expected ok=false for a rejected key");
        ctx.assert(result.status === 401, `Expected upstream 401, got ${result.status}`);
        ctx.assert(/key/i.test(result.hint ?? ""), `Hint does not mention the key: ${result.hint}`);
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "Rejected key produced ok=false, upstream 401, and a key-focused hint",
        });
      },
    },
    {
      name: "Cloud metadata targets are refused",
      run: async (ctx) => {
        const { status, result } = await ctx.eval(
          probeExpr({ api: "http://169.254.169.254/v1", apiKey: "k" }),
          { awaitPromise: true },
        );
        ctx.assert(status === 200, `Probe endpoint returned ${status}`);
        ctx.assert(result?.ok === false, "Expected ok=false for a metadata target");
        ctx.assert(/not allowed/i.test(result.hint ?? ""), `Hint missing block reason: ${result.hint}`);
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "SSRF guard refused the cloud metadata endpoint",
        });
      },
    },
    {
      name: "Stop the mock endpoint",
      run: async (ctx) => {
        await new Promise((resolve) => ctx.mockServer?.close(resolve));
      },
    },
  ],
};
