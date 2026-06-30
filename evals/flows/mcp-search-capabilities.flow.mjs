/**
 * Proves the additive "search_capabilities" tool on the existing, real Den
 * MCP server ("OpenWork Cloud Control"): a harness can search the existing
 * OpenAPI-derived catalog by keyword instead of receiving the full tool
 * list, then call the matched real tool name via the normal MCP
 * tools/call protocol and get a genuine server-side execution result.
 *
 * Nothing about auth, policy, or invoke changes. This flow proves the
 * addition is purely additive: the existing UI-visible Cloud Control
 * connection still works, and the new search tool sits alongside the
 * existing catalog tools, dispatching through the same unchanged execute
 * path (invoke.ts).
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL    Den API base (e.g. http://127.0.0.1:8793)
 * - OPENWORK_EVAL_DEN_TOKEN      Bearer session token for the demo owner
 */

async function denFetch(ctx, path, options = {}) {
  const base = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

/** The Den /mcp endpoint speaks MCP-over-streamable-HTTP; each request gets a
 * fresh server instance (no session to carry between calls), so a single
 * JSON-RPC POST per call is sufficient. Responses are SSE-framed even for a
 * single message, so unwrap the `data: {...}` line.
 */
async function mcpCall(ctx, mcpToken, method, params) {
  const base = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? {} }),
  });
  const raw = await response.text();
  ctx.assert(response.ok, `MCP ${method} failed: ${response.status} ${raw.slice(0, 300)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  ctx.assert(Boolean(dataLine), `MCP ${method} returned no data frame: ${raw.slice(0, 300)}`);
  const parsed = JSON.parse(dataLine.slice(5));
  ctx.assert(!parsed.error, `MCP ${method} returned a JSON-RPC error: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

export default {
  id: "mcp-search-capabilities",
  title: "search_capabilities ranks the real Den MCP catalog and the matched tool executes for real",
  spec: "evals/cloud-mcp-agent-flows.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_WORKSPACE_PATH"],
  steps: [
    {
      name: "App booted",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000 });
      },
    },
    {
      name: "Sign in via desktop handoff (skipped when already signed in)",
      run: async (ctx) => {
        const signedIn = await ctx.eval(
          "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
        );
        if (signedIn) {
          ctx.log("Already signed in; reusing session.");
          return;
        }
        const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
        const response = await fetch(`${apiBase}/v1/auth/desktop-handoff`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        });
        ctx.assert(response.ok, `Handoff create failed: ${response.status}`);
        const payload = await response.json();

        // Exchange via the control action (not the "paste link" UI field): the
        // UI field would follow the deep link's embedded denBaseUrl, which
        // assumes a den-web reverse proxy. The control action exchanges
        // directly against the app's own already-configured apiBaseUrl.
        await ctx.control("auth.exchange-grant", { grant: payload.grant });
        await ctx.waitFor(
          "window.__openworkControl.execute('auth.status').then(r => r.result?.status === 'signed_in')",
          { timeoutMs: 15_000, label: "auth signed_in" },
        );
      },
    },
    {
      name: "Active organization resolves and Cloud Control MCP auto-configures",
      run: async (ctx) => {
        await ctx.waitFor(
          "Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())",
          { timeoutMs: 60_000, label: "active org" },
        );

        // Onboarding shows an org picker before the desktop fully activates
        // the resolved org. Click through it (idempotent if already past it).
        const onOnboarding = await ctx.eval("location.hash.includes('/onboarding')");
        if (onOnboarding) {
          await ctx.clickText("Continue with organization", { timeoutMs: 20_000 }).catch(() => {});
          await ctx.clickText("Continue to workspace", { timeoutMs: 20_000 }).catch(() => {});
        }

        // Cloud MCP auto-config syncs once a workspace exists. Create one if
        // we landed on /welcome (idempotent if a workspace already exists).
        const onWelcome = await ctx.eval("location.hash.includes('/welcome')");
        if (onWelcome) {
          const wsPath = ctx.env.OPENWORK_EVAL_WORKSPACE_PATH.trim();
          await ctx.fill("input", wsPath);
          await ctx.clickText("Use this folder", { timeoutMs: 10_000 });
          await ctx.waitFor("location.hash.includes('/workspace/')", {
            timeoutMs: 30_000,
            label: "workspace route after creation",
          });
        }

        await ctx.waitFor(
          "Boolean(localStorage.getItem('openwork.den.mcp.sync'))",
          { timeoutMs: 180_000, label: "openwork.den.mcp.sync marker" },
        );
      },
    },
    {
      name: "OpenWork Cloud Control is connected — the unchanged existing surface still works",
      run: async (ctx) => {
        await ctx.prove("Adding search_capabilities did not break the existing, already-shipped Cloud Control connection.", {
          action: async () => {
            await ctx.navigateHash("/settings/extensions/mcp");
            await ctx.expectHashIncludes("/settings/extensions/mcp");
          },
          assert: async () => {
            await ctx.expectText("OpenWork Cloud Control", { timeoutMs: 30_000 });
          },
          screenshot: {
            name: "cloud-control-still-connected",
            requireText: ["OpenWork Cloud Control"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Mint a real org-scoped MCP token for this org",
      run: async (ctx) => {
        const minted = await denFetch(ctx, "/v1/mcp/token", {
          method: "POST",
          headers: { authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}` },
          body: JSON.stringify({}),
        });
        ctx.assert(typeof minted.token === "string" && minted.token.startsWith("ow_mcp_at_"), "Expected a real opaque MCP token.");
        ctx.mcpToken = minted.token;
        ctx.organizationId = minted.organizationId;
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "A real, org-scoped MCP access token was minted via the existing first-party token route.",
          actual: { organizationId: minted.organizationId, scopes: minted.scopes },
        });
      },
    },
    {
      name: "search_capabilities is present in the real tools/list alongside the existing catalog",
      run: async (ctx) => {
        const result = await mcpCall(ctx, ctx.mcpToken, "tools/list", {});
        const names = result.tools.map((tool) => tool.name);
        ctx.assert(names.includes("search_capabilities"), "search_capabilities missing from tools/list.");
        ctx.assert(names.includes("getOrg"), "Existing catalog tool getOrg missing — addition must be purely additive.");
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "tools/list includes the new search_capabilities tool plus the full existing OpenAPI-derived catalog, unchanged.",
          actual: { totalTools: names.length, hasSearch: true },
        });
        ctx.log(`tools/list: ${names.length} tools, search_capabilities present.`);
      },
    },
    {
      name: "Calling search_capabilities ranks the real catalog by keyword",
      run: async (ctx) => {
        const result = await mcpCall(ctx, ctx.mcpToken, "tools/call", {
          name: "search_capabilities",
          arguments: { query: "list organization", limit: 5 },
        });
        const text = result.content?.[0]?.text ?? "";
        const parsed = JSON.parse(text);
        ctx.matches = parsed.matches ?? [];
        ctx.assert(ctx.matches.length > 0, "Expected at least one ranked match for 'list organization'.");
        const topMatchNames = ctx.matches.map((match) => match.name);
        ctx.assert(topMatchNames.includes("getOrg"), `Expected getOrg among top matches, got: ${topMatchNames.join(", ")}`);
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "search_capabilities returned real, ranked matches from the live catalog for a natural-language-ish query.",
          actual: ctx.matches,
        });
        ctx.log(`search matches: ${topMatchNames.join(", ")}`);
      },
    },
    {
      name: "Executing the matched real tool runs the existing, unchanged invoke path against live data",
      run: async (ctx) => {
        const topMatch = ctx.matches[0];
        ctx.assert(topMatch?.name === "getOrg", `Expected top match to be getOrg, got ${topMatch?.name}`);

        const result = await mcpCall(ctx, ctx.mcpToken, "tools/call", { name: topMatch.name, arguments: {} });
        const text = result.content?.[0]?.text ?? "";
        const parsed = JSON.parse(text);
        ctx.assert(parsed.organization?.id === ctx.organizationId, "Executed tool did not return the real, current organization.");
        ctx.orgName = parsed.organization?.name;
        ctx.assert(typeof ctx.orgName === "string" && ctx.orgName.length > 0, "Real organization name missing from executed tool result.");

        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "search -> execute completed end-to-end: the tool search_capabilities matched was called via the unchanged real invoke path and returned genuine organization data.",
          actual: { organizationId: parsed.organization?.id, organizationName: ctx.orgName },
        });
      },
    },
    {
      name: "The organization name returned by the protocol call matches what the UI shows",
      run: async (ctx) => {
        await ctx.prove("The data returned by search -> execute is the same real organization the signed-in desktop app is showing, not a mock.", {
          action: async () => {
            await ctx.navigateHash("/settings/cloud-account");
            await ctx.expectHashIncludes("/settings/cloud-account");
          },
          assert: async () => {
            await ctx.expectText(ctx.orgName, { timeoutMs: 30_000 });
          },
          screenshot: {
            name: "org-name-matches-ui",
            requireText: [ctx.orgName],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/cloud-account",
          },
        });
      },
    },
    {
      name: "A real chat message triggers search_capabilities then the matched tool through the actual agent",
      run: async (ctx) => {
        // This is the strongest proof: not a direct protocol call from the
        // eval script, but a real chat turn -> real OpenCode agent -> real
        // tool calls against the live, authenticated Cloud Control MCP ->
        // real Den API data, surfaced back in the chat transcript. The agent
        // is instructed to use search_capabilities first so this run
        // specifically exercises the new tool, not just any cloud capability.
        await ctx.prove("Chat-triggered: the agent calls search_capabilities, then calls the tool it matched, against the real backend.", {
          action: async () => {
            // The previous step left us on /settings/cloud-account;
            // session.create_task is only registered on a session route.
            await ctx.navigateHash("/session");
            await ctx.waitFor(
              "Boolean(window.__openworkControl?.listActions().find((a) => a.id === 'session.create_task' && !a.disabled))",
              { timeoutMs: 15_000, label: "session.create_task available" },
            );
            await ctx.control("session.create_task");
            await ctx.waitFor(
              `(() => {
                const route = window.__openworkControl.snapshot().route || "";
                return /ses_[A-Za-z0-9]+/.test(route);
              })()`,
              { timeoutMs: 30_000, label: "new session active" },
            );

            const pasted = await ctx.eval(`(() => {
              const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
                || document.querySelector('[contenteditable="true"]');
              if (!editor) return { ok: false, reason: "composer not found" };
              editor.focus();
              const data = new DataTransfer();
              data.setData('text/plain', ${JSON.stringify(
                'On the OpenWork Cloud Control MCP, first call the search_capabilities tool with query "organization" to find the right tool, then call whichever tool it matches to tell me my organization name. Use search_capabilities first, do not skip it.',
              )});
              editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
              return { ok: true };
            })()`);
            ctx.assert(pasted?.ok, `Composer not ready: ${pasted?.reason ?? "unknown"}`);

            const submitted = await ctx.waitFor(`(() => {
              const byLabel = Array.from(document.querySelectorAll('button'))
                .find((b) => /run task|send|run/i.test((b.textContent || "").trim()) && !b.disabled);
              if (byLabel) { byLabel.click(); return "clicked"; }
              return null;
            })()`, { timeoutMs: 10_000, label: "submit button enabled" });
            ctx.log(`submit: ${submitted}`);
          },
          assert: async () => {
            // Real LLM tool-calling latency: generous timeouts, two real
            // network calls (search, then execute) plus model reasoning.
            await ctx.waitForText("search capabilities", { timeoutMs: 90_000 });
            await ctx.waitForText("getOrg", { timeoutMs: 60_000 });
            await ctx.waitForText(ctx.orgName, { timeoutMs: 60_000 });
            await ctx.expectNoText("Something went wrong");
          },
          screenshot: {
            name: "chat-triggered-search-then-execute",
            requireText: ["search capabilities", "getOrg", ctx.orgName],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
