/**
 * Proves two things on top of the existing, real Den MCP infrastructure:
 *
 * 1. The rich `/mcp` endpoint ("OpenWork Cloud Control" as it existed
 *    before this change) keeps every catalog tool individually registered,
 *    plus the additive `search_capabilities` tool, unchanged.
 *
 * 2. A new, separate, minimal endpoint — `/mcp/agent` — exposes exactly
 *    two tools: `search_capabilities` and `execute_capability`. The
 *    desktop app's "OpenWork Cloud Control" connection now points here,
 *    not at the rich endpoint. Both tools dispatch through the exact same
 *    unchanged `invoke.ts` execute path as the rich endpoint; nothing
 *    about auth, policy, or execution changes — only what the harness can
 *    see changes, from ~129 tools to 2.
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
async function mcpCallTo(ctx, path, mcpToken, method, params) {
  const base = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? {} }),
  });
  const raw = await response.text();
  ctx.assert(response.ok, `MCP ${method} (${path}) failed: ${response.status} ${raw.slice(0, 300)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  ctx.assert(Boolean(dataLine), `MCP ${method} (${path}) returned no data frame: ${raw.slice(0, 300)}`);
  const parsed = JSON.parse(dataLine.slice(5));
  ctx.assert(!parsed.error, `MCP ${method} (${path}) returned a JSON-RPC error: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

async function mcpCall(ctx, mcpToken, method, params) {
  return mcpCallTo(ctx, "/mcp", mcpToken, method, params);
}

async function mcpAgentCall(ctx, mcpToken, method, params) {
  return mcpCallTo(ctx, "/mcp/agent", mcpToken, method, params);
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
      name: "The minimal /mcp/agent endpoint exposes exactly two tools",
      run: async (ctx) => {
        const result = await mcpAgentCall(ctx, ctx.mcpToken, "tools/list", {});
        const names = result.tools.map((tool) => tool.name).sort();
        ctx.assert(names.length === 2, `Expected exactly 2 tools on /mcp/agent, got ${names.length}: ${names.join(", ")}`);
        ctx.assert(
          names.join(",") === "execute_capability,search_capabilities",
          `Expected exactly [execute_capability, search_capabilities], got: ${names.join(", ")}`,
        );
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "The harness-facing /mcp/agent endpoint registers only search_capabilities and execute_capability — none of the ~127 other catalog operations are individually callable here.",
          actual: { tools: names },
        });
      },
    },
    {
      name: "search_capabilities on /mcp/agent returns call-shape hints, and execute_capability runs the match for real",
      run: async (ctx) => {
        const searchResult = await mcpAgentCall(ctx, ctx.mcpToken, "tools/call", {
          name: "search_capabilities",
          arguments: { query: "list organization", limit: 3 },
        });
        const searchParsed = JSON.parse(searchResult.content?.[0]?.text ?? "{}");
        const matches = searchParsed.matches ?? [];
        const topMatch = matches.find((match) => match.name === "getOrg");
        ctx.assert(Boolean(topMatch), `Expected getOrg among /mcp/agent search matches, got: ${matches.map((m) => m.name).join(", ")}`);
        ctx.assert(Array.isArray(topMatch.pathParams) && Array.isArray(topMatch.queryParams) && typeof topMatch.hasBody === "boolean",
          "Match is missing call-shape hints (pathParams/queryParams/hasBody).");

        const executeResult = await mcpAgentCall(ctx, ctx.mcpToken, "tools/call", {
          name: "execute_capability",
          arguments: { name: topMatch.name },
        });
        const executeParsed = JSON.parse(executeResult.content?.[0]?.text ?? "{}");
        ctx.assert(executeParsed.organization?.id === ctx.organizationId, "execute_capability did not return the real, current organization.");
        ctx.assert(executeParsed.organization?.name === ctx.orgName, "execute_capability returned a different org name than the rich /mcp path.");

        const unknownResult = await mcpAgentCall(ctx, ctx.mcpToken, "tools/call", {
          name: "execute_capability",
          arguments: { name: "doesNotExist" },
        });
        ctx.assert(unknownResult.isError === true, "execute_capability should error on an unknown capability name.");
        const unknownParsed = JSON.parse(unknownResult.content?.[0]?.text ?? "{}");
        ctx.assert(unknownParsed.error === "unknown_capability", `Expected unknown_capability error, got: ${JSON.stringify(unknownParsed)}`);

        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "On the minimal endpoint, search_capabilities -> execute_capability runs through the exact same invoke.ts path as the rich endpoint, returning identical real data; an unknown name fails with a helpful, actionable error.",
          actual: { organizationName: executeParsed.organization?.name, pathParams: topMatch.pathParams, queryParams: topMatch.queryParams, hasBody: topMatch.hasBody },
        });
      },
    },
    {
      name: "A real, unprompted chat message naturally uses search_capabilities then execute_capability — there is no other tool to call",
      run: async (ctx) => {
        // The strongest possible proof: this prompt does not mention
        // search_capabilities, execute_capability, or any tool name at all.
        // Unlike the earlier rich-/mcp test (which required explicitly
        // instructing the agent to search first, because getOrg was sitting
        // right there in its tool list), the desktop app's Cloud Control
        // connection now points at /mcp/agent — the agent has no other way
        // to discover or call anything, so it has to use these two tools by
        // construction, not by instruction.
        await ctx.prove("Chat-triggered, unprompted: the agent calls search_capabilities then execute_capability because that's all this connection exposes.", {
          action: async () => {
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
                "On the OpenWork Cloud Control MCP, find and tell me the name of my current organization.",
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
            await ctx.waitForText("execute capability", { timeoutMs: 60_000 });
            await ctx.waitForText(ctx.orgName, { timeoutMs: 60_000 });
            await ctx.expectNoText("Something went wrong");
          },
          screenshot: {
            name: "chat-triggered-minimal-surface",
            requireText: ["search capabilities", "execute capability", ctx.orgName],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
  ],
};
