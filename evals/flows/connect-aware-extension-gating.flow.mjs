/**
 * Internal demo: connect-aware gating of the legacy Google Workspace
 * extension surface behind the org-level `connectEnabled` flag.
 *
 * Protagonist: the OpenWork server surface the agent actually consumes
 * (`/experimental/extensions/*`), driven through the real running app via
 * CDP — every request runs in-page with the app's own port and tokens,
 * exactly like the desktop client and the extensions-preview plugin do.
 *
 * Safety property under proof: gating only ever hides actions that would
 * fail with `google_workspace_not_connected` anyway (legacy unconfigured),
 * and the flag is a live kill switch.
 */
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "connect-aware-extension-gating";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const GW = "google-workspace";
const IMAGE_GEN = "openai-image-generation";
const GW_NON_STATUS = [
  "calendar_list_events",
  "gmail_create_draft",
  "gmail_create_reply_draft",
  "gmail_list_messages",
  "gmail_get_message",
  "gmail_download_attachment",
  "drive_search_files",
  "drive_read_file",
  "drive_update_file",
  "calendar_create_event",
  "chat_list_spaces",
  "chat_list_messages",
  "chat_send_message",
];

/**
 * In-page request against the embedded OpenWork server using the app's own
 * token (in the dev sandbox the client bearer carries host scope; the stored
 * hostToken can be stale across restarts, so we deliberately avoid it).
 */
const serverExpr = (path, { method = "GET", body } = {}) => `(async () => {
  const port = localStorage.getItem("openwork.server.port");
  const token = localStorage.getItem("openwork.server.token");
  if (!port || !token) return { transport: "missing port or token" };
  const response = await fetch("http://127.0.0.1:" + port + ${JSON.stringify(path)}, {
    method: ${JSON.stringify(method)},
    headers: {
      Authorization: "Bearer " + token,
      ...(${JSON.stringify(Boolean(body))} ? { "Content-Type": "application/json" } : {}),
    },
    ...(${JSON.stringify(Boolean(body))} ? { body: ${JSON.stringify(JSON.stringify(body ?? null))} } : {}),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
})()`;

async function server(ctx, path, options) {
  const result = await ctx.eval(serverExpr(path, options), { awaitPromise: true });
  ctx.assert(result && typeof result.status === "number", `server request ${path} reached the app's embedded server (got: ${JSON.stringify(result)})`);
  return result;
}

const actionKey = (item) => `${item.extensionId}:${item.action}`;

async function listActions(ctx) {
  const { status, payload } = await server(ctx, "/experimental/extensions/actions");
  ctx.assert(status === 200 && payload?.ok === true, `actions list responds ok (status ${status})`);
  return payload.actions.map(actionKey);
}

export default {
  id: FLOW_ID,
  title: "Connect flag gates dead legacy Google Workspace actions and redirects the agent to OpenWork Cloud",
  kind: "internal",
  spec: "evals/voiceovers/connect-aware-extension-gating.md",
  steps: [
    {
      name: "Baseline: flag off, full legacy surface (today's behavior)",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "window.__openworkControl" });
        await ctx.waitFor('Boolean(localStorage.getItem("openwork.server.port")) && Boolean(localStorage.getItem("openwork.server.token"))', {
          timeoutMs: 60_000,
          label: "embedded server port/token in localStorage",
        });
        await ctx.prove("With connectEnabled off, every legacy extension action is offered exactly as before", {
          voiceover: vo[0],
          action: async () => {
            // Idempotence: force the flag off regardless of previous runs.
            const put = await server(ctx, "/experimental/connect/state", { method: "PUT", body: { connectEnabled: false } });
            ctx.assert(put.status === 200 && put.payload?.ok === true, `PUT connect/state off succeeds (status ${put.status})`);
          },
          assert: async () => {
            const state = await server(ctx, "/experimental/connect/state");
            ctx.assert(state.payload?.connectEnabled === false, "connect state reports connectEnabled=false");
            ctx.assert(state.payload?.googleWorkspace?.legacyConfigured === false, "no legacy Google OAuth client configured on this device");
            const keys = await listActions(ctx);
            for (const action of GW_NON_STATUS) {
              ctx.assert(keys.includes(`${GW}:${action}`), `baseline offers ${GW}:${action}`);
            }
            ctx.assert(keys.includes(`${GW}:status`), "baseline offers google-workspace:status");
            ctx.assert(keys.includes(`${IMAGE_GEN}:image_generate`), "baseline offers image generation");
            ctx.output("baseline-actions", JSON.stringify({ count: keys.length, actions: keys }, null, 2));
          },
        });
      },
    },
    {
      name: "Org flips connectEnabled — the desktop push endpoint",
      run: async (ctx) => {
        await ctx.prove("PUT /experimental/connect/state {connectEnabled:true} persists and reports the device snapshot", {
          voiceover: vo[1],
          action: async () => {
            const put = await server(ctx, "/experimental/connect/state", { method: "PUT", body: { connectEnabled: true } });
            ctx.assert(put.status === 200 && put.payload?.ok === true, `PUT connect/state on succeeds (status ${put.status})`);
          },
          assert: async () => {
            const state = await server(ctx, "/experimental/connect/state");
            ctx.assert(state.payload?.connectEnabled === true, "connect state reports connectEnabled=true");
            ctx.assert(typeof state.payload?.cloudMcpPresent === "boolean", "snapshot reports whether the openwork-cloud MCP is present");
            ctx.output("connect-state-on", JSON.stringify(state.payload, null, 2));
          },
        });
      },
    },
    {
      name: "Tool surface transforms: dead GW actions vanish, status and image-gen stay",
      run: async (ctx) => {
        await ctx.prove("Gating hides exactly the 13 dead Google Workspace actions and nothing else", {
          voiceover: vo[2],
          assert: async () => {
            const keys = await listActions(ctx);
            for (const action of GW_NON_STATUS) {
              ctx.assert(!keys.includes(`${GW}:${action}`), `gated list no longer offers ${GW}:${action}`);
            }
            ctx.assert(keys.includes(`${GW}:status`), "status probe survives gating");
            ctx.assert(keys.includes(`${IMAGE_GEN}:image_generate`), "image generation is untouched by gating");
            ctx.assert(keys.includes(`${IMAGE_GEN}:status`), "image generation status is untouched by gating");
            ctx.output("gated-actions", JSON.stringify({ count: keys.length, actions: keys }, null, 2));
          },
        });
      },
    },
    {
      name: "Calling a hidden action returns a redirect, not an OAuth dead-end",
      run: async (ctx) => {
        await ctx.prove("A gated call answers use_openwork_cloud with Settings > Connect guidance", {
          voiceover: vo[3],
          assert: async () => {
            const call = await server(ctx, "/experimental/extensions/call", {
              method: "POST",
              body: { extensionId: GW, action: "gmail_list_messages", args: {} },
            });
            ctx.assert(call.status === 200, `gated call responds 200 with a structured payload (status ${call.status})`);
            ctx.assert(call.payload?.ok === false, "gated call is not treated as success");
            ctx.assert(call.payload?.error === "use_openwork_cloud", `gated call error is use_openwork_cloud (got ${call.payload?.error})`);
            ctx.assert(String(call.payload?.message ?? "").includes("Settings > Connect"), "guidance points at Settings > Connect");
            ctx.assert(!String(call.payload?.message ?? "").includes("client secret"), "guidance never mentions OAuth client secrets");
            ctx.output("gated-call-redirect", JSON.stringify(call.payload, null, 2));
          },
        });
      },
    },
    {
      name: "Status carries the same guidance for status-only agents",
      run: async (ctx) => {
        await ctx.prove("GET google-workspace/status includes an additive connect block with guidance", {
          voiceover: vo[4],
          assert: async () => {
            const status = await server(ctx, "/experimental/google-workspace/status");
            ctx.assert(status.status === 200, `status responds 200 (status ${status.status})`);
            ctx.assert(status.payload?.configured === false, "legacy fields are preserved for UI compatibility");
            ctx.assert(status.payload?.connect?.enabled === true, "status carries connect.enabled=true");
            ctx.assert(String(status.payload?.connect?.guidance ?? "").includes("Settings > Connect"), "status guidance points at Settings > Connect");
            ctx.output("gw-status-gated", JSON.stringify(status.payload, null, 2));
          },
        });
      },
    },
    {
      name: "Kill switch: flag off restores the full surface on the next request",
      run: async (ctx) => {
        await ctx.prove("Disabling connectEnabled restores all legacy actions with no restart", {
          voiceover: vo[5],
          action: async () => {
            const put = await server(ctx, "/experimental/connect/state", { method: "PUT", body: { connectEnabled: false } });
            ctx.assert(put.status === 200 && put.payload?.connectEnabled === false, "PUT connect/state off succeeds");
          },
          assert: async () => {
            const keys = await listActions(ctx);
            for (const action of GW_NON_STATUS) {
              ctx.assert(keys.includes(`${GW}:${action}`), `restored list offers ${GW}:${action}`);
            }
            const call = await server(ctx, "/experimental/extensions/call", {
              method: "POST",
              body: { extensionId: GW, action: "status", args: {} },
            });
            ctx.assert(call.payload?.ok === true, "status action call succeeds again");
            ctx.assert(call.payload?.result?.connect === undefined, "connect block is absent when the flag is off");
            ctx.output("restored-actions", JSON.stringify({ count: keys.length }, null, 2));
          },
        });
      },
    },
    {
      name: "The surface users are pointed to exists: Settings > Connect",
      run: async (ctx) => {
        await ctx.prove("Settings > Connect renders as the org connections surface", {
          voiceover: vo[6],
          action: async () => {
            await ctx.navigateHash("#/settings/connect");
            await ctx.waitFor("document.body.innerText.includes('cloud-managed MCP connections')", {
              timeoutMs: 30_000,
              label: "Connect settings surface",
            });
          },
          assert: async () => {
            await ctx.expectHashIncludes("/settings/connect");
            await ctx.expectText("Connect for teams");
          },
          screenshot: {
            name: "settings-connect-surface",
            requireText: ["Connect for teams"],
            hashIncludes: "/settings/connect",
          },
        });
      },
    },
  ],
};
