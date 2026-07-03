/**
 * Memory Bank v0 — end-to-end save -> recall proof (TASK-9).
 *
 * Mirrors mcp-search-capabilities.flow.mjs. Proves, on top of the real Den MCP
 * infrastructure and a signed-in desktop app, that:
 *
 * 1. The agent DISCOVERS the memory-save capability search-first (via
 *    search_capabilities on /mcp/agent) — it is never a bespoke `memory_save`
 *    tool, only `search_capabilities` + `execute_capability` exist here.
 * 2. Executing the matched save capability persists a human-confirmed memory
 *    (POST /v1/memory, owner-scoped) for real.
 * 3. A SEPARATE, fresh MCP call (a new server instance — no session carried)
 *    recalls that memory via a natural-language query (getMemorySearch),
 *    proving cross-session lexical recall.
 * 4. The desktop Memory panel shows the saved memory (UI matches the API).
 *
 * This flow also fails loudly on the B1 (search-first) and B3 (flattened save
 * payload) regressions.
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL    Den API base (e.g. http://127.0.0.1:8788)
 * - OPENWORK_EVAL_DEN_TOKEN      Bearer session token for the demo owner
 * - OPENWORK_EVAL_WORKSPACE_PATH A folder to use as the workspace
 */

async function denFetch(ctx, path, options = {}) {
  const base = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
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

/** JSON-RPC over MCP streamable-HTTP; each request is a fresh server instance. */
async function mcpAgentCall(ctx, mcpToken, method, params) {
  const base = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
  const response = await fetch(`${base}/mcp/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params: params ?? {} }),
  });
  const raw = await response.text();
  ctx.assert(response.ok, `MCP ${method} (/mcp/agent) failed: ${response.status} ${raw.slice(0, 300)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  ctx.assert(Boolean(dataLine), `MCP ${method} returned no data frame: ${raw.slice(0, 300)}`);
  const parsed = JSON.parse(dataLine.slice(5));
  ctx.assert(!parsed.error, `MCP ${method} returned a JSON-RPC error: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

function callText(result) {
  return JSON.parse(result.content?.[0]?.text ?? "{}");
}

const MEMORY_MARKER = `acme-renewal-${Date.now()}`;
const MEMORY_CONTENT = `User's Acme account renews in Q3 at 5000 per month — marker ${MEMORY_MARKER}.`;

export default {
  id: "memory-save-recall",
  title: "Agent discovers the memory capability, saves a memory, and recalls it in a fresh session via natural language",
  spec: "docs/memory-bank-architecture.md",
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
        const signedIn = await ctx.eval("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())");
        if (signedIn) {
          ctx.log("Already signed in; reusing session.");
          return;
        }
        const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
        const response = await fetch(`${apiBase}/v1/auth/desktop-handoff`, {
          method: "POST",
          headers: { authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`, "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        ctx.assert(response.ok, `Handoff create failed: ${response.status}`);
        const payload = await response.json();
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
        await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())", {
          timeoutMs: 60_000,
          label: "active org",
        });
        const onWelcome = await ctx.eval("location.hash.includes('/welcome')");
        if (onWelcome) {
          await ctx.fill("input", ctx.env.OPENWORK_EVAL_WORKSPACE_PATH.trim());
          await ctx.clickText("Use this folder", { timeoutMs: 10_000 });
          await ctx.waitFor("location.hash.includes('/workspace/')", { timeoutMs: 30_000, label: "workspace route" });
        }
      },
    },
    {
      name: "Enable the Memory Bank preview flag so the panel surfaces",
      run: async (ctx) => {
        await ctx.eval(`(() => {
          const key = 'openwork.preferences';
          let prefs = {};
          try { prefs = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch {}
          prefs.featureFlags = { ...(prefs.featureFlags ?? {}), memory: true };
          localStorage.setItem(key, JSON.stringify(prefs));
          return true;
        })()`);
      },
    },
    {
      name: "Mint a real org-scoped MCP token",
      run: async (ctx) => {
        const minted = await denFetch(ctx, "/v1/mcp/token", {
          method: "POST",
          headers: { authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}` },
          body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
        });
        ctx.assert(typeof minted.token === "string" && minted.token.startsWith("ow_mcp_at_"), "Expected a real opaque MCP token.");
        ctx.mcpToken = minted.token;
        ctx.organizationId = minted.organizationId;
      },
    },
    {
      name: "Discover the SAVE capability search-first (B1) — no bespoke memory_save tool",
      run: async (ctx) => {
        const agentTools = await mcpAgentCall(ctx, ctx.mcpToken, "tools/list", {});
        const toolNames = agentTools.tools.map((tool) => tool.name).sort();
        ctx.assert(
          toolNames.join(",") === "execute_capability,search_capabilities",
          `Expected only search_capabilities + execute_capability, got: ${toolNames.join(", ")}`,
        );
        ctx.assert(!toolNames.includes("memory_save") && !toolNames.includes("memory_search"), "A bespoke memory tool must not exist (B1).");

        const search = callText(await mcpAgentCall(ctx, ctx.mcpToken, "tools/call", {
          name: "search_capabilities",
          arguments: { query: "save a memory to the memory bank", limit: 5 },
        }));
        const matches = search.matches ?? [];
        const saveMatch = matches.find((match) => /memory/i.test(match.name) && /post/i.test(match.name));
        ctx.assert(Boolean(saveMatch), `Expected a memory-save capability in matches, got: ${matches.map((m) => m.name).join(", ")}`);
        ctx.assert(saveMatch.hasBody === true, "Save capability must advertise a body (B3 flattened payload).");
        ctx.saveCapability = saveMatch.name;
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "The agent discovered the memory-save capability search-first via search_capabilities; no memory_save tool exists.",
          actual: { saveCapability: saveMatch.name, hasBody: saveMatch.hasBody },
        });
        ctx.log(`save capability: ${saveMatch.name}`);
      },
    },
    {
      name: "Execute the save capability — a human-confirmed memory is persisted (B3 flattened body)",
      run: async (ctx) => {
        const result = await mcpAgentCall(ctx, ctx.mcpToken, "tools/call", {
          name: "execute_capability",
          arguments: { name: ctx.saveCapability, body: { content: MEMORY_CONTENT, tags: ["acme", "deal"] } },
        });
        ctx.assert(result.isError !== true, `Save execute errored: ${result.content?.[0]?.text ?? ""}`);
        const saved = callText(result);
        ctx.assert(typeof saved.memory?.id === "string" && saved.memory.id.startsWith("mem_"), `Expected a mem_ id, got: ${JSON.stringify(saved.memory)}`);
        ctx.assert(saved.memory.scope === "user", "Server must force scope='user'.");
        ctx.memoryId = saved.memory.id;
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "execute_capability persisted a memory via the real POST /v1/memory owner-scoped route, scope forced to 'user'.",
          actual: { memoryId: saved.memory.id, scope: saved.memory.scope },
        });
      },
    },
    {
      name: "Recall it in a FRESH MCP call via a natural-language query (cross-session lexical recall)",
      run: async (ctx) => {
        // A brand-new /mcp/agent request = a fresh server instance with no
        // carried session, so a successful recall proves cross-session persistence.
        const search = callText(await mcpAgentCall(ctx, ctx.mcpToken, "tools/call", {
          name: "search_capabilities",
          arguments: { query: "search my saved memories", limit: 5 },
        }));
        const recallMatch = (search.matches ?? []).find((match) => /memory/i.test(match.name) && /search/i.test(match.name));
        ctx.assert(Boolean(recallMatch), `Expected a memory-search capability, got: ${(search.matches ?? []).map((m) => m.name).join(", ")}`);

        // Query tokens ("Acme", "account") are guaranteed to be in the stored content.
        const recallQuery = "Acme account renewal";
        const recall = await mcpAgentCall(ctx, ctx.mcpToken, "tools/call", {
          name: "execute_capability",
          arguments: { name: recallMatch.name, query: { q: recallQuery } },
        });
        ctx.assert(recall.isError !== true, `Recall execute errored: ${recall.content?.[0]?.text ?? ""}`);
        const results = callText(recall).results ?? [];
        const found = results.find((entry) => entry.id === ctx.memoryId);
        ctx.assert(Boolean(found), `Recall did not return the saved memory. Got ids: ${results.map((r) => r.id).join(", ")}`);
        ctx.assert((found.content ?? "").includes(MEMORY_MARKER), "Recalled memory content did not match what was saved.");
        ctx.recordEvidence({
          type: "assertion",
          status: "passed",
          assertion: "A fresh search_capabilities -> execute_capability recalled the saved memory by natural-language query — cross-session lexical recall works end-to-end.",
          actual: { query: recallQuery, recalledId: found.id },
        });
      },
    },
    {
      name: "The desktop Memory panel shows the saved memory (UI matches the API)",
      run: async (ctx) => {
        await ctx.prove("The memory saved via the agent capability appears in the desktop Memory management panel.", {
          action: async () => {
            await ctx.navigateHash("/settings/memory");
            await ctx.expectHashIncludes("/settings/memory");
          },
          assert: async () => {
            // Assert a phrase that is actually persisted in the memory content.
            await ctx.expectText("Acme account renews", { timeoutMs: 30_000 });
          },
          screenshot: {
            name: "memory-panel-shows-saved-memory",
            requireText: ["Acme account renews"],
            rejectText: ["Something went wrong", "Sign in to your OpenWork account"],
            hashIncludes: "/settings/memory",
          },
        });
      },
    },
    {
      name: "Clean up the test memory via execute_capability(delete)",
      run: async (ctx) => {
        const search = callText(await mcpAgentCall(ctx, ctx.mcpToken, "tools/call", {
          name: "search_capabilities",
          arguments: { query: "delete a memory", limit: 5 },
        }));
        const deleteMatch = (search.matches ?? []).find((match) => /memory/i.test(match.name) && /delete/i.test(match.name));
        if (!deleteMatch) {
          ctx.log("Delete capability not found; leaving test memory (harmless).");
          return;
        }
        await mcpAgentCall(ctx, ctx.mcpToken, "tools/call", {
          name: "execute_capability",
          arguments: { name: deleteMatch.name, path: { id: ctx.memoryId } },
        });
        ctx.log(`deleted test memory ${ctx.memoryId}`);
      },
    },
  ],
};
