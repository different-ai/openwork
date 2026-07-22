/**
 * Creator side of the marketplace lifecycle, max-difficulty credential case:
 * an OAuth MCP with a client id AND client secret.
 *
 * The owner (Alex, Acme Robotics):
 *   1. Signs in to OpenWork Cloud via desktop handoff and creates a workspace.
 *   2. Installs a skill (laptop-refresh-policy — the customer's first use
 *      case) and connects a custom MCP protected by real OAuth (the repo's
 *      mock OAuth MCP server), configured with clientId + clientSecret.
 *      The MCP genuinely reports "Sign in needed" in Settings > Extensions.
 *   3. Exports both via POST /workspace/:id/extensions/export and proves
 *      oauth.clientSecret is redacted while clientId/scope survive.
 *   4. Publishes the EXPORTED bundle to a Den marketplace (find-or-create
 *      "BY IT Marketplace"), building the published MCP payload from the
 *      redacted export — the secret cannot travel because the publisher
 *      never sees it.
 *
 * Pairs with oauth-mcp-install.flow.mjs (member installs on a second app).
 *
 * Required env:
 * - OPENWORK_EVAL_DEN_API_URL  local Den API (e.g. http://127.0.0.1:8790)
 * Prereqs: mock OAuth MCP on :3979 (scripts/mock-oauth-mcp-server.mjs),
 * seeded demo org (alex@acme.test / OpenWorkDemo123!).
 */
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SHARED = {
  OWNER_EMAIL: "alex@acme.test",
  PASSWORD: "OpenWorkDemo123!",
  SKILL_NAME: "laptop-refresh-policy",
  SKILL_DESCRIPTION: "Check whether a laptop is eligible for refresh per IT policy.",
  MCP_NAME: "acme-servicenow",
  MCP_URL: "http://127.0.0.1:3979/mcp",
  OAUTH_CLIENT_ID: "acme-desktop-client",
  OAUTH_CLIENT_SECRET: "acme-oauth-secret-98765",
  OAUTH_SCOPE: "incidents.read",
  MARKETPLACE_NAME: "BY IT Marketplace",
  PLUGIN_NAME: "Laptop Refresh Policy",
};

const SKILL_CONTENT = `---\nname: ${SHARED.SKILL_NAME}\ndescription: ${SHARED.SKILL_DESCRIPTION}\n---\n\n## When to use\n- Use when someone asks if their laptop qualifies for a hardware refresh.\n\nLook up the device age and the IT refresh policy, then answer with eligibility and next steps.\n`;

const CLICK_ANY = "button, [role=button], a, div, article, li, label";

async function denFetch(ctx, path, init = {}) {
  const base = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
  const origin = ctx.env.OPENWORK_EVAL_DEN_ORIGIN?.trim() || base.replace("127.0.0.1", "localhost");
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", origin, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { payload = { message: text }; }
  return { ok: response.ok, status: response.status, payload };
}

async function denSignIn(ctx, email) {
  const result = await denFetch(ctx, "/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password: SHARED.PASSWORD }),
  });
  ctx.assert(result.ok && result.payload.token, `Den sign-in failed for ${email}: ${result.status}`);
  return result.payload.token;
}

async function denAuthed(ctx, token, path, init = {}) {
  const result = await denFetch(ctx, path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  return result;
}

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
  const fromHash = (window.location.hash.match(/workspace\\/(ws_[a-z0-9]+)/) ?? [])[1];
  const active = localStorage.getItem("openwork.react.activeWorkspace");
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

// Drive through post-sign-in onboarding (org choice -> resources -> done)
// by clicking whichever affordance is on screen until we leave /onboarding.
// auth.status can transiently reject with "Already acting" when a previous
// poll is still in flight; retry briefly instead of failing the frame.
async function authStatus(ctx) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await ctx.control("auth.status");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return null;
}

async function handleOnboarding(ctx) {
  await ctx.waitFor(`(() => {
    const hash = window.location.hash;
    if (!hash.includes("/onboarding")) return true;
    const labels = ["Continue with organization", "Continue to workspace", "Continue", "Acme Robotics"];
    const nodes = [...document.querySelectorAll(${JSON.stringify(CLICK_ANY)})];
    for (const label of labels) {
      const matches = nodes.filter((el) => {
        const text = (el.innerText ?? "").trim();
        return label === "Continue" ? text === label : text.includes(label);
      }).filter((el) => !el.disabled);
      // Prefer real buttons, then the most specific (shortest-text) match.
      const node = matches.sort((a, b) =>
        (a.tagName === "BUTTON" ? 0 : 1) - (b.tagName === "BUTTON" ? 0 : 1) ||
        (a.innerText ?? "").length - (b.innerText ?? "").length)[0];
      if (node) { node.click(); return false; }
    }
    return false;
  })()`, { timeoutMs: 45_000, label: "onboarding completed" }).catch(() => {});
}

let exportedBundle = null;

export default {
  id: "oauth-mcp-publish",
  title: "Owner exports skill + OAuth MCP (secret redacted) and publishes to a marketplace",
  spec: "apps/server/src/extensions-export.ts",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "App A boots; owner signs in via desktop handoff",
      run: async (ctx) => {
        await ctx.prove("Owner is signed in to OpenWork Cloud", {
          action: async () => {
            await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 90_000, label: "control API" });
            const status = await authStatus(ctx);
            if (status?.status !== "signed_in") {
              const token = await denSignIn(ctx, SHARED.OWNER_EMAIL);
              const handoff = await denAuthed(ctx, token, "/v1/auth/desktop-handoff", { method: "POST", body: "{}" });
              ctx.assert(handoff.ok && handoff.payload.grant, `Handoff failed: ${handoff.status}`);
              await ctx.control("auth.exchange-grant", { grant: handoff.payload.grant });
            }
            await ctx.waitFor(
              "window.__openworkControl.execute('auth.status').then(r => r.result?.status === 'signed_in').catch(() => false)",
              { timeoutMs: 20_000, label: "auth signed_in" },
            );
            await handleOnboarding(ctx);
          },
          assert: async () => {
            const status = await authStatus(ctx);
            ctx.assert(status?.status === "signed_in", "Not signed in after handoff exchange.");
            ctx.assert(String(status?.user?.email ?? "").includes("alex@"), `Unexpected user: ${status?.user?.email}`);
          },
          screenshot: { name: "owner-signed-in", rejectText: ["Something went wrong"] },
        });
      },
    },
    {
      name: "Owner has a workspace",
      run: async (ctx) => {
        const wsPath = join(homedir(), ".openwork", "two-electron-demo", "eval-workspace-a");
        await mkdir(wsPath, { recursive: true });
        const inWorkspace = await ctx.eval("location.hash.includes('/workspace/')");
        if (!inWorkspace) {
          await handleOnboarding(ctx);
          const onWelcome = await ctx.waitFor("location.hash.includes('/welcome') || location.hash.includes('/workspace/')", { timeoutMs: 30_000 });
          void onWelcome;
          if (await ctx.eval("location.hash.includes('/welcome')")) {
            await ctx.fill("input", wsPath);
            await ctx.clickText("Use this folder", { timeoutMs: 10_000 });
          }
        }
        await ctx.waitFor("location.hash.includes('/workspace/')", { timeoutMs: 45_000, label: "workspace route" });
        // Re-runs may land on a settings page; return to the session surface.
        await ctx.navigateHash("/");
        await ctx.waitFor(
          "document.body.innerText.includes('Run task') || document.body.innerText.includes('Describe your task')",
          { timeoutMs: 60_000, label: "engine ready" },
        );
      },
    },
    {
      name: "Owner installs the skill and connects the OAuth MCP (clientId + clientSecret)",
      run: async (ctx) => {
        await ctx.prove("OAuth MCP genuinely requires sign-in in Settings > Extensions", {
          action: async () => {
            await serverCall(ctx, `/workspace/:id/skills/${SHARED.SKILL_NAME}`, { method: "DELETE" }, { tolerate: true });
            await serverCall(ctx, "/workspace/:id/skills", {
              method: "POST",
              body: JSON.stringify({ name: SHARED.SKILL_NAME, content: SKILL_CONTENT, description: SHARED.SKILL_DESCRIPTION }),
            });
            await serverCall(ctx, "/workspace/:id/mcp", {
              method: "POST",
              body: JSON.stringify({
                name: SHARED.MCP_NAME,
                config: {
                  type: "remote",
                  url: SHARED.MCP_URL,
                  enabled: true,
                  oauth: {
                    clientId: SHARED.OAUTH_CLIENT_ID,
                    clientSecret: SHARED.OAUTH_CLIENT_SECRET,
                    scope: SHARED.OAUTH_SCOPE,
                  },
                },
              }),
            });
            await ctx.navigateHash("/settings/extensions/mcp");
            await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.waitForText(SHARED.MCP_NAME, { timeoutMs: 30_000 });
            // Real OAuth: the engine discovered the mock provider and asks
            // for sign-in. Scroll the row into view and require the status.
            await ctx.waitFor(`(() => {
              const el = [...document.querySelectorAll("*")]
                .find((node) => node.children.length === 0 && (node.textContent ?? "").includes(${JSON.stringify(SHARED.MCP_NAME)}));
              if (!el) return false;
              el.scrollIntoView({ block: "center" });
              return document.body.innerText.includes("Sign in needed");
            })()`, { timeoutMs: 60_000, label: "Sign in needed status" });
            await ctx.expectNoText(SHARED.OAUTH_CLIENT_SECRET);
          },
          screenshot: {
            name: "oauth-mcp-needs-signin",
            requireText: [SHARED.MCP_NAME, "Sign in needed"],
            rejectText: [SHARED.OAUTH_CLIENT_SECRET],
          },
        });
      },
    },
    {
      name: "Export redacts the OAuth client secret but keeps clientId/scope",
      run: async (ctx) => {
        await ctx.prove("Portable export never contains the client secret", {
          action: async () => {},
          assert: async () => {
            const result = await serverCall(ctx, "/workspace/:id/extensions/export", {
              method: "POST",
              body: JSON.stringify({ skills: [SHARED.SKILL_NAME], mcps: [SHARED.MCP_NAME] }),
            });
            const { payload, raw } = result;
            ctx.assert(!raw.includes(SHARED.OAUTH_CLIENT_SECRET), "OAuth client secret leaked into the export.");
            const mcp = (payload.components ?? []).find((item) => item.kind === "mcp" && item.name === SHARED.MCP_NAME);
            ctx.assert(Boolean(mcp), "MCP missing from export.");
            ctx.assert(mcp.config?.oauth?.clientSecret === "<redacted>", "clientSecret was not redacted.");
            ctx.assert(mcp.config?.oauth?.clientId === SHARED.OAUTH_CLIENT_ID, "clientId did not survive export.");
            ctx.assert(mcp.config?.oauth?.scope === SHARED.OAUTH_SCOPE, "scope did not survive export.");
            ctx.assert(mcp.redactedKeys.includes("oauth.clientSecret"), "redactedKeys missing oauth.clientSecret.");
            const skill = (payload.components ?? []).find((item) => item.kind === "skill" && item.name === SHARED.SKILL_NAME);
            ctx.assert(Boolean(skill?.content), "Skill missing from export.");
            exportedBundle = { skill, mcp };
            ctx.log(`export ok, redactedKeys=${JSON.stringify(mcp.redactedKeys)}`);
          },
        });
      },
    },
    {
      name: "Owner publishes the exported bundle to the BY IT Marketplace",
      run: async (ctx) => {
        await ctx.prove("Marketplace carries the plugin; published MCP has no secret", {
          action: async () => {
            ctx.assert(exportedBundle, "Export step did not run.");
            // Fresh privileged session (den enforces 15-min freshness).
            const token = await denSignIn(ctx, SHARED.OWNER_EMAIL);

            // Find-or-create marketplace, org-wide viewer access.
            const list = await denAuthed(ctx, token, "/v1/marketplaces?status=active&limit=100");
            ctx.assert(list.ok, `List marketplaces failed: ${list.status}`);
            let marketplace = (list.payload.items ?? []).find((item) => item.name === SHARED.MARKETPLACE_NAME);
            if (!marketplace) {
              const created = await denAuthed(ctx, token, "/v1/marketplaces", {
                method: "POST",
                body: JSON.stringify({ name: SHARED.MARKETPLACE_NAME, description: "IT self-service plugins" }),
              });
              ctx.assert(created.ok, `Create marketplace failed: ${created.status} ${JSON.stringify(created.payload)}`);
              marketplace = created.payload.item;
              const grant = await denAuthed(ctx, token, `/v1/marketplaces/${marketplace.id}/access`, {
                method: "POST",
                body: JSON.stringify({ orgWide: true, role: "viewer" }),
              });
              ctx.assert(grant.ok, `Marketplace access grant failed: ${grant.status}`);
            }

            // Find-or-create plugin from the EXPORTED bundle.
            const resolved = await denAuthed(ctx, token, `/v1/marketplaces/${marketplace.id}/resolved`);
            const already = resolved.ok && JSON.stringify(resolved.payload).includes(SHARED.PLUGIN_NAME);
            if (!already) {
              const plugin = await denAuthed(ctx, token, "/v1/plugins", {
                method: "POST",
                body: JSON.stringify({ name: SHARED.PLUGIN_NAME, description: SHARED.SKILL_DESCRIPTION }),
              });
              ctx.assert(plugin.ok, `Create plugin failed: ${plugin.status} ${JSON.stringify(plugin.payload)}`);
              const pluginId = plugin.payload.item.id;
              await denAuthed(ctx, token, `/v1/plugins/${pluginId}/access`, {
                method: "POST",
                body: JSON.stringify({ orgWide: true, role: "viewer" }),
              });

              // Skill config object: exported SKILL.md verbatim.
              const skillObject = await denAuthed(ctx, token, "/v1/config-objects", {
                method: "POST",
                body: JSON.stringify({
                  type: "skill",
                  sourceMode: "cloud",
                  pluginIds: [pluginId],
                  input: {
                    rawSourceText: exportedBundle.skill.content,
                    metadata: { name: SHARED.SKILL_NAME, description: SHARED.SKILL_DESCRIPTION },
                  },
                }),
              });
              ctx.assert(skillObject.ok, `Skill config object failed: ${skillObject.status} ${JSON.stringify(skillObject.payload)}`);

              // MCP config object BUILT FROM THE REDACTED EXPORT: drop every
              // redacted value; keep clientId/scope so installers can sign in.
              const oauth = Object.fromEntries(
                Object.entries(exportedBundle.mcp.config.oauth).filter(([, value]) => value !== "<redacted>"),
              );
              const mcpObject = await denAuthed(ctx, token, "/v1/config-objects", {
                method: "POST",
                body: JSON.stringify({
                  type: "mcp",
                  sourceMode: "cloud",
                  pluginIds: [pluginId],
                  input: {
                    normalizedPayloadJson: {
                      mcpServers: {
                        [SHARED.MCP_NAME]: { type: "remote", url: exportedBundle.mcp.config.url, oauth },
                      },
                    },
                    metadata: { name: SHARED.MCP_NAME, description: "ServiceNow (OAuth) MCP" },
                  },
                }),
              });
              ctx.assert(mcpObject.ok, `MCP config object failed: ${mcpObject.status} ${JSON.stringify(mcpObject.payload)}`);
              for (const objectId of [skillObject.payload.item.id, mcpObject.payload.item.id]) {
                await denAuthed(ctx, token, `/v1/config-objects/${objectId}/access`, {
                  method: "POST",
                  body: JSON.stringify({ orgWide: true, role: "viewer" }),
                });
              }
              const published = await denAuthed(ctx, token, `/v1/marketplaces/${marketplace.id}/plugins`, {
                method: "POST",
                body: JSON.stringify({ pluginId }),
              });
              ctx.assert(published.ok, `Publish to marketplace failed: ${published.status} ${JSON.stringify(published.payload)}`);
            }
          },
          assert: async () => {
            // Witness on the Den side: the resolved marketplace carries the
            // plugin, and NOTHING in the resolved payload contains the secret.
            const token = await denSignIn(ctx, SHARED.OWNER_EMAIL);
            const list = await denAuthed(ctx, token, "/v1/marketplaces?status=active&limit=100");
            const marketplace = (list.payload.items ?? []).find((item) => item.name === SHARED.MARKETPLACE_NAME);
            ctx.assert(marketplace, "Marketplace not found after publish.");
            const resolved = await denAuthed(ctx, token, `/v1/marketplaces/${marketplace.id}/resolved`);
            ctx.assert(resolved.ok, `Resolve marketplace failed: ${resolved.status}`);
            const text = JSON.stringify(resolved.payload);
            ctx.assert(text.includes(SHARED.PLUGIN_NAME), "Plugin missing from resolved marketplace.");
            ctx.assert(!text.includes(SHARED.OAUTH_CLIENT_SECRET), "SECRET FOUND in resolved marketplace payload.");
            // The full component payload — exactly what installers download —
            // lives on the plugin resolution endpoint.
            const pluginEntry = (resolved.payload.item?.plugins ?? []).find((entry) => entry.name === SHARED.PLUGIN_NAME);
            ctx.assert(pluginEntry, "Plugin entry missing from resolved marketplace.");
            const pluginResolved = await denAuthed(ctx, token, `/v1/plugins/${pluginEntry.id}/resolved`);
            ctx.assert(pluginResolved.ok, `Resolve plugin failed: ${pluginResolved.status}`);
            const pluginText = JSON.stringify(pluginResolved.payload);
            ctx.assert(!pluginText.includes(SHARED.OAUTH_CLIENT_SECRET), "SECRET FOUND in resolved plugin payload.");
            ctx.assert(pluginText.includes(SHARED.OAUTH_CLIENT_ID), "clientId missing from published MCP payload.");
          },
        });
      },
    },
    {
      name: "Owner sees the plugin in the Extension Marketplace UI",
      run: async (ctx) => {
        await ctx.prove("Published plugin is visible in the marketplace view", {
          action: async () => {
            await ctx.control("settings.panel.open", { panel: "cloud-marketplaces" });
            await ctx.waitFor("location.hash.includes('/settings/cloud-marketplaces')", { timeoutMs: 15_000 });
            await ctx.control("extensions.refresh-marketplace").catch(() => {});
          },
          assert: async () => {
            await ctx.waitForText(SHARED.PLUGIN_NAME, { timeoutMs: 45_000 });
            await ctx.expectNoText(SHARED.OAUTH_CLIENT_SECRET);
          },
          screenshot: {
            name: "plugin-published",
            requireText: [SHARED.PLUGIN_NAME],
            rejectText: [SHARED.OAUTH_CLIENT_SECRET, "Something went wrong"],
          },
        });
      },
    },
  ],
};
