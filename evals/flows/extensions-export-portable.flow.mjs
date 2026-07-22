/**
 * Portable extensions export: a user's installed skill and an
 * OpenWork-managed runtime MCP (which lives in the runtime DB, not in
 * workspace files) can be exported as one portable bundle — with secret
 * header values redacted — so the agent can package them into a
 * marketplace plugin.
 *
 * The end user is the protagonist:
 *   1. User installs a skill; it is visible in Settings > Skills.
 *   2. User connects an MCP server that carries a secret Authorization
 *      header (the same programmatic path the app's connect flows use);
 *      it is visible in Settings > Extensions as a runtime-managed entry.
 *   3. The new export surface (POST /workspace/:id/extensions/export —
 *      exactly what the bundled openwork_extensions_export agent tool
 *      calls) returns both components; the SKILL.md content round-trips,
 *      the secret never appears, and headers.Authorization is <redacted>.
 *   4. (Agent frame, requires a usable model) The user asks the agent to
 *      export both by name with the openwork_extensions_export tool; the
 *      agent replies with the redacted header value in the transcript.
 *
 * REST calls use the app's own port/token from localStorage (pattern from
 * cloud-config-sync-latency.flow.mjs) and are only how we witness side
 * effects; the export endpoint itself is the experience under test since
 * it is the agent-facing surface.
 */

const SKILL_NAME = "release-notes-eval";
const SKILL_DESCRIPTION = "Draft release notes for the weekly changelog.";
const SKILL_BODY = "## When to use\n- Use when drafting weekly release notes.\n\nCollect merged PRs and summarize them.";
const SKILL_CONTENT = `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${SKILL_BODY}\n`;
const MCP_NAME = "eval-export-mcp";
const MCP_URL = "https://mcp.example.com/eval-export";
const SECRET = "Bearer eval-export-secret-12345";

// The reply must contain values the model can only learn from the tool
// result (the exported MCP url and the redactedKeys entries) — neither is
// present in this prompt, so a match proves the tool actually ran.
const AGENT_MESSAGE = [
  `Call the openwork_extensions_export tool with skills ["${SKILL_NAME}"] and mcps ["${MCP_NAME}"].`,
  'From the tool result, take the exported MCP config "url" and the "redactedKeys" list.',
  "Reply with exactly one line: EXPORT-RESULT <url> <redactedKeys entries joined with commas>.",
  "Write the values verbatim without quotes or angle brackets. Do not run any other tools.",
].join(" ");
const AGENT_REPLY_RE = "EXPORT-RESULT\\s+https:\\/\\/mcp\\.example\\.com\\/eval-export\\s+headers\\.Authorization";

// In-page OpenWork server access using the app's own connection details.
const serverCallExpr = (pathTemplate, init) => `(async () => {
  const port = localStorage.getItem("openwork.server.port");
  const token = localStorage.getItem("openwork.server.token");
  if (!port || !token) return { ok: false, error: "no server port/token in localStorage" };
  const base = "http://127.0.0.1:" + port;
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const wsResponse = await fetch(base + "/workspaces", { headers });
  if (!wsResponse.ok) return { ok: false, error: "workspaces " + wsResponse.status };
  const wsPayload = await wsResponse.json();
  const workspaces = Array.isArray(wsPayload) ? wsPayload : wsPayload.items ?? [];
  const active = localStorage.getItem("openwork.react.activeWorkspace");
  const fromHash = (window.location.hash.match(/workspace\\/(ws_[a-z0-9]+)/) ?? [])[1];
  const workspace = workspaces.find((entry) => entry.id === (fromHash || active)) ?? workspaces[0];
  if (!workspace) return { ok: false, error: "no workspace" };
  const response = await fetch(base + ${JSON.stringify(pathTemplate)}.replace(":id", workspace.id), {
    headers,
    ...${JSON.stringify(init ?? {})},
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = { message: text }; }
  return { ok: response.ok, status: response.status, workspaceId: workspace.id, payload, raw: text };
})()`;

async function serverCall(ctx, pathTemplate, init, { tolerate = false } = {}) {
  const result = await ctx.eval(serverCallExpr(pathTemplate, init), { awaitPromise: true });
  if (!tolerate) {
    ctx.assert(result?.ok, `Server call ${pathTemplate} failed: ${result?.status ?? "?"} ${JSON.stringify(result?.payload ?? {}).slice(0, 300)}`);
  }
  return result;
}

async function pasteComposer(ctx, text) {
  return ctx.eval(
    `(() => {
      const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')
        || document.querySelector('[contenteditable="true"]');
      if (!editor) return { ok: false, reason: 'composer not found' };
      editor.focus();
      const data = new DataTransfer();
      data.setData('text/plain', ${JSON.stringify(text)});
      editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      return { ok: true };
    })()`,
  );
}

export default {
  id: "extensions-export-portable",
  title: "Skill + runtime MCP export as a portable, secret-redacted bundle",
  spec: "apps/server/src/extensions-export.ts",
  precondition: async (ctx) => {
    await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
    const route = await ctx.eval("window.__openworkControl.snapshot().route");
    return typeof route === "string" && (route.startsWith("/welcome") || route.startsWith("/signin"))
      ? "Profile is not onboarded (welcome/signin); flow requires a workspace."
      : null;
  },
  steps: [
    {
      name: "App boots clean",
      run: async (ctx) => {
        await ctx.prove("App boots to a usable surface", {
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API" });
            await ctx.waitFor("document.body.innerText.trim().length > 40", { label: "rendered body text" });
          },
          assert: async () => {
            const route = await ctx.eval("window.__openworkControl.snapshot().route");
            ctx.assert(typeof route === "string" && route.length > 0, "No route reported by control snapshot.");
          },
          screenshot: { name: "booted", rejectText: ["Something went wrong"] },
        });
        // Idempotent re-runs: start from a clean slate (best-effort).
        await serverCall(ctx, `/workspace/:id/skills/${SKILL_NAME}`, { method: "DELETE" }, { tolerate: true });
        await serverCall(ctx, `/workspace/:id/mcp/${MCP_NAME}`, { method: "DELETE" }, { tolerate: true });
      },
    },
    {
      name: "User installs a skill and sees it in Settings > Extensions > Skills",
      run: async (ctx) => {
        await ctx.prove("Installed skill is visible in the Extensions settings (Skills)", {
          action: async () => {
            await serverCall(ctx, "/workspace/:id/skills", {
              method: "POST",
              body: JSON.stringify({ name: SKILL_NAME, content: SKILL_CONTENT, description: SKILL_DESCRIPTION }),
            });
            await ctx.navigateHash("/settings/extensions/skills");
            await ctx.expectHashIncludes("/settings/extensions");
            // Select the Skills filter so the frame shows the skills list.
            await ctx.clickText("Skills", { timeoutMs: 15_000 });
          },
          assert: async () => {
            await ctx.waitForText(SKILL_NAME, { timeoutMs: 30_000 });
            await ctx.expectNoText("Something went wrong");
          },
          screenshot: {
            name: "skill-installed",
            requireText: [SKILL_NAME],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "User connects an MCP server carrying a secret header",
      run: async (ctx) => {
        await ctx.prove("Runtime-managed MCP appears in Settings > Extensions", {
          action: async () => {
            // Same programmatic path the app's own connect flows use
            // (POST /workspace/:id/mcp); stored in the OpenWork runtime DB,
            // not in workspace files. enabled:false keeps it Paused so the
            // engine does not try to reach the placeholder URL.
            await serverCall(ctx, "/workspace/:id/mcp", {
              method: "POST",
              body: JSON.stringify({
                name: MCP_NAME,
                config: { type: "remote", url: MCP_URL, headers: { Authorization: SECRET }, enabled: false },
              }),
            });
            await ctx.navigateHash("/settings/extensions/mcp");
            await ctx.expectHashIncludes("/settings/extensions");
            // Select the MCPs filter so the frame shows the MCP list.
            await ctx.clickText("MCPs", { timeoutMs: 15_000 });
          },
          assert: async () => {
            await ctx.waitForText(MCP_NAME, { timeoutMs: 30_000 });
            await ctx.expectNoText(SECRET);
            // Bring the connected row into the viewport for the frame.
            await ctx.waitFor(`(() => {
              const el = [...document.querySelectorAll("*")]
                .find((node) => node.children.length === 0 && (node.textContent ?? "").includes(${JSON.stringify(MCP_NAME)}));
              if (!el) return false;
              el.scrollIntoView({ block: "center" });
              const rect = el.getBoundingClientRect();
              return rect.top > 0 && rect.bottom < window.innerHeight;
            })()`, { timeoutMs: 15_000, label: "MCP row scrolled into view" });
          },
          screenshot: {
            name: "mcp-connected",
            requireText: [MCP_NAME],
            rejectText: [SECRET, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Export surface returns a portable bundle with the secret redacted",
      run: async (ctx) => {
        await ctx.prove("POST /workspace/:id/extensions/export round-trips skill + MCP, secret redacted", {
          action: async () => {},
          assert: async () => {
            const result = await serverCall(ctx, "/workspace/:id/extensions/export", {
              method: "POST",
              body: JSON.stringify({ skills: [SKILL_NAME], mcps: [MCP_NAME] }),
            });
            const { payload, raw } = result;
            ctx.assert(!raw.includes(SECRET), "Secret leaked into the export response.");
            const skill = (payload.components ?? []).find((item) => item.kind === "skill" && item.name === SKILL_NAME);
            ctx.assert(Boolean(skill), `Skill ${SKILL_NAME} missing from export.`);
            // The server normalizes frontmatter on upsert, so assert the
            // meaningful parts round-trip rather than byte equality.
            ctx.assert(skill.content.includes(`name: ${SKILL_NAME}`), "Exported SKILL.md lost its name frontmatter.");
            ctx.assert(skill.content.includes(SKILL_DESCRIPTION), "Exported SKILL.md lost its description.");
            ctx.assert(skill.content.includes("Collect merged PRs and summarize them."), "Exported SKILL.md lost its body.");
            const mcp = (payload.components ?? []).find((item) => item.kind === "mcp" && item.name === MCP_NAME);
            ctx.assert(Boolean(mcp), `MCP ${MCP_NAME} missing from export.`);
            ctx.assert(mcp.source === "config.remote", `Expected runtime-managed source, got ${mcp.source}.`);
            ctx.assert(mcp.config?.url === MCP_URL, "Exported MCP url mismatch.");
            ctx.assert(mcp.config?.headers?.Authorization === "<redacted>", "Authorization header was not redacted.");
            ctx.assert(
              Array.isArray(mcp.redactedKeys) && mcp.redactedKeys.includes("headers.Authorization"),
              "redactedKeys does not declare headers.Authorization.",
            );
            ctx.assert(
              payload.missing?.skills?.length === 0 && payload.missing?.mcps?.length === 0,
              "Export reported missing components.",
            );
            ctx.log(`export ok: ${payload.components.length} components, redactedKeys=${JSON.stringify(mcp.redactedKeys)}`);
          },
        });
      },
    },
    {
      name: "Agent exports both via the openwork_extensions_export tool",
      run: async (ctx) => {
        await ctx.prove("Agent calls openwork_extensions_export and reports the redacted header", {
          action: async () => {
            // Leave settings; session actions register on the session surface.
            await ctx.navigateHash("/");
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((a) => a.id === 'session.create_task' && !a.disabled)",
              { timeoutMs: 45_000, label: "session.create_task available" },
            );
            await ctx.control("session.create_task");
            await ctx.waitFor(
              `(() => {
                const route = window.__openworkControl.snapshot().route || "";
                return /ses_[A-Za-z0-9]+/.test(route);
              })()`,
              { timeoutMs: 30_000, label: "active session id in route" },
            );
            const pasted = await pasteComposer(ctx, AGENT_MESSAGE);
            ctx.assert(pasted?.ok, `Composer not ready: ${pasted?.reason ?? "unknown"}`);
            const ran = await ctx.eval(`(() => {
              const byLabel = Array.from(document.querySelectorAll('button'))
                .find((b) => /run task|send|run/i.test((b.textContent || "").trim()) && !b.disabled);
              if (byLabel) { byLabel.click(); return "clicked"; }
              const editor = document.querySelector('[contenteditable="true"]');
              if (editor) {
                editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
                return "enter";
              }
              return "none";
            })()`);
            ctx.assert(ran !== "none", "Could not submit the composer message.");
          },
          assert: async () => {
            // The url + redacted key are only in the tool result, not the
            // prompt — the model cannot produce this line without actually
            // calling openwork_extensions_export.
            await ctx.waitFor(
              `Boolean(document.body.innerText.match(new RegExp(${JSON.stringify(AGENT_REPLY_RE)})))`,
              { timeoutMs: 180_000, label: "agent EXPORT-RESULT reply" },
            );
            await ctx.expectNoText(SECRET);
            await ctx.expectNoText("Something went wrong");
          },
          screenshot: {
            name: "agent-export-proof",
            requireText: ["EXPORT-RESULT", MCP_URL],
            rejectText: [SECRET],
          },
        });
      },
    },
  ],
};
