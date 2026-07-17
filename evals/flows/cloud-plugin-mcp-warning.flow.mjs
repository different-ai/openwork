import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "cloud-plugin-mcp-warning";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const RUN_TAG = Date.now().toString(36);
const MARKETPLACE_NAME = `MCP warning proof ${RUN_TAG}`;
const BROKEN_PLUGIN_NAME = `Broken MCP Bundle ${RUN_TAG}`;
const VALID_PLUGIN_NAME = `Valid MCP Bundle ${RUN_TAG}`;
const BROKEN_SKILL_TITLE = `Broken bundle skill ${RUN_TAG}`;
const VALID_SKILL_TITLE = `Valid bundle skill ${RUN_TAG}`;
const BROKEN_SKILL_NAME = slugify(BROKEN_SKILL_TITLE);
const VALID_WARNING = 'MCP component "Broken MCP" could not be installed: no server config with a "url" or "command" was found.';

const state = {
  marketplaceId: "",
  brokenPluginId: "",
  validPluginId: "",
  workspacePath: "",
};

function slugify(value) {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "skill";
}

function baseWorkspacePath(ctx) {
  return ctx.env.OPENWORK_EVAL_WORKSPACE_PATH.trim().replace(/\/+$/, "");
}

async function denJson(ctx, path, options = {}) {
  const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  ctx.assert(
    response.ok,
    `${options.method ?? "GET"} ${path} failed: ${response.status} ${typeof body === "string" ? body : JSON.stringify(body)}`,
  );
  return body;
}

async function createMarketplace(ctx) {
  const body = await denJson(ctx, "/v1/marketplaces", {
    method: "POST",
    body: JSON.stringify({
      name: MARKETPLACE_NAME,
      description: "Eval-only marketplace for cloud plugin MCP warning proof.",
    }),
  });
  ctx.assert(typeof body.item?.id === "string", "Marketplace create response was missing item.id.");
  state.marketplaceId = body.item.id;
}

function skillSource(title, purpose) {
  return `# ${title}\n\nUse this eval-only skill to verify that ${purpose}.`;
}

async function createPlugin(ctx, input) {
  const body = await denJson(ctx, "/v1/plugins", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      description: input.description,
      orgWide: true,
      marketplaceId: state.marketplaceId,
      components: [
        {
          type: "skill",
          input: {
            rawSourceText: skillSource(input.skillTitle, input.skillPurpose),
            metadata: {
              name: input.skillTitle,
              description: input.skillDescription,
            },
          },
        },
        {
          type: "mcp",
          input: {
            normalizedPayloadJson: input.mcpPayload,
            metadata: {
              name: input.mcpTitle,
              description: input.mcpDescription,
            },
          },
        },
      ],
    }),
  });
  ctx.assert(typeof body.item?.id === "string", `Plugin create response for ${input.name} was missing item.id.`);
  return body.item.id;
}

async function setupCloudPlugins(ctx) {
  await createMarketplace(ctx);
  state.brokenPluginId = await createPlugin(ctx, {
    name: BROKEN_PLUGIN_NAME,
    description: "A skill plus an intentionally malformed MCP payload.",
    skillTitle: BROKEN_SKILL_TITLE,
    skillDescription: "Installed even when the bundled MCP is malformed.",
    skillPurpose: "a skill survives a malformed bundled MCP component",
    mcpTitle: "Broken MCP",
    mcpDescription: "Uses serverUrl instead of url so it should warn and skip MCP install.",
    mcpPayload: {
      mcpServers: {
        broken: { type: "sse", serverUrl: "https://x.example/mcp" },
      },
    },
  });
  state.validPluginId = await createPlugin(ctx, {
    name: VALID_PLUGIN_NAME,
    description: "A skill plus a valid remote Linear MCP server.",
    skillTitle: VALID_SKILL_TITLE,
    skillDescription: "Installed with the valid Linear MCP bundle.",
    skillPurpose: "a valid bundled remote MCP is installed and synced",
    mcpTitle: "Linear MCP",
    mcpDescription: "Valid remote Linear MCP server.",
    mcpPayload: {
      mcpServers: {
        linear: { type: "remote", url: "https://mcp.linear.app/sse" },
      },
    },
  });
  ctx.log(`Created marketplace ${state.marketplaceId} with plugins ${state.brokenPluginId}, ${state.validPluginId}.`);
}

async function signInViaHandoff(ctx) {
  const apiBase = ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
  const response = await fetch(`${apiBase}/v1/auth/desktop-handoff`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  const payload = await response.json();
  ctx.assert(response.ok && typeof payload.grant === "string", `Handoff create failed: ${response.status}`);
  await ctx.control("auth.exchange-grant", { grant: payload.grant, baseUrl: apiBase });
  await ctx.waitFor(
    "window.__openworkControl.execute('auth.status').then(r => r.result?.status === 'signed_in')",
    { timeoutMs: 30_000, label: "auth signed_in" },
  );
  await ctx.waitFor(
    "Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())",
    { timeoutMs: 60_000, label: "active org resolved" },
  );
}

async function clickOptional(ctx, text, options = {}) {
  await ctx.clickText(text, options).catch(() => {});
}

async function handleOnboarding(ctx) {
  await clickOptional(ctx, "Continue with organization", { timeoutMs: 5_000 });
  await clickOptional(ctx, "Continue to workspace", { timeoutMs: 5_000 });
}

async function useWelcomeFolder(ctx) {
  await ctx.navigateHash("/welcome");
  await ensureRenderedApp(ctx);
  await ctx.waitForText("Use this folder", { timeoutMs: 20_000 });
  await ctx.fill("input", state.workspacePath);
  await ctx.waitFor(
    `(() => [...document.querySelectorAll("button")].some((button) => (button.textContent ?? "").includes("Use this folder") && !button.disabled))()`,
    { timeoutMs: 10_000, label: "welcome folder button enabled" },
  );
  await ctx.clickText("Use this folder", { timeoutMs: 10_000 });
  await ctx.waitFor("location.hash.includes('/workspace/')", {
    timeoutMs: 45_000,
    label: "workspace route after welcome folder selection",
  });
}

async function waitForNewWorkspaceRoute(ctx, previousWorkspaceId, label) {
  await ctx.waitFor(
    `(() => {
      const workspaceId = (location.hash.match(/\\/workspace\\/([^/]+)/) || [])[1] || "";
      return workspaceId && workspaceId !== ${JSON.stringify(previousWorkspaceId)};
    })()`,
    { timeoutMs: 60_000, label },
  );
}

async function createFreshWorkspace(ctx) {
  state.workspacePath = join(baseWorkspacePath(ctx), `${FLOW_ID}-${RUN_TAG}`);
  await mkdir(state.workspacePath, { recursive: true });
  await handleOnboarding(ctx);

  const hasActiveWorkspace = await ctx.eval(
    "location.hash.includes('/workspace/') || Boolean(localStorage.getItem('openwork.react.activeWorkspace'))",
  );
  if (!hasActiveWorkspace) {
    await useWelcomeFolder(ctx);
    return;
  }

  const onWelcome = await ctx.eval("location.hash.includes('/welcome')");
  if (onWelcome) {
    await useWelcomeFolder(ctx);
    return;
  }

  const previousWorkspaceId = await activeWorkspaceId(ctx);
  await ctx.navigateHash(`/workspace/${previousWorkspaceId}/session`);
  await ctx.waitFor(
    `location.hash.includes(${JSON.stringify(`/workspace/${previousWorkspaceId}/session`)})`,
    { timeoutMs: 20_000, label: "current workspace session route" },
  );
  await ensureRenderedApp(ctx);
  await ctx.waitFor(
    "Boolean(window.__openworkControl?.listActions().find(a => a.id === 'workspace.create'))",
    { timeoutMs: 20_000, label: "workspace.create control action on session route" },
  );
  await ctx.control("workspace.create", {
    path: state.workspacePath,
    projectLabel: "Cloud plugin MCP warning proof",
  });
  await waitForNewWorkspaceRoute(ctx, previousWorkspaceId, "workspace route after session workspace.create");
}

async function waitForWorkspaceReady(ctx) {
  await ctx.waitFor(
    "document.body.innerText.includes('Ready for new tasks') || document.body.innerText.includes('Run task') || location.hash.includes('/settings/')",
    { timeoutMs: 60_000, label: "workspace shell ready" },
  );
}

async function activeWorkspaceId(ctx) {
  const workspaceId = await ctx.eval(
    "(location.hash.match(/\\/workspace\\/([^/]+)/) || [])[1] || localStorage.getItem('openwork.react.activeWorkspace') || ''",
  );
  ctx.assert(typeof workspaceId === "string" && workspaceId.trim().length > 0, "No active workspace id for settings route.");
  return workspaceId.trim();
}

async function openWorkspaceSettings(ctx, panel) {
  const workspaceId = await activeWorkspaceId(ctx);
  const hashPath = `/workspace/${workspaceId}/settings/${panel}`;
  await ctx.navigateHash(hashPath);
  await ctx.waitFor(
    `location.hash.includes(${JSON.stringify(hashPath)})`,
    { timeoutMs: 20_000, label: `workspace settings ${panel}` },
  );
  await ensureRenderedApp(ctx);
}

async function ensureRenderedApp(ctx) {
  const ready = await ctx.waitFor(
    "Boolean(window.__openworkControl) && document.body.innerText.trim().length > 20",
    { timeoutMs: 8_000, label: "rendered app shell" },
  ).then(() => true).catch(() => false);
  if (ready) return;
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API after app reload",
  });
  await ctx.waitFor("document.body.innerText.trim().length > 20", {
    timeoutMs: 30_000,
    label: "body rendered after app reload",
  });
}

async function openMarketplace(ctx) {
  await ensureRenderedApp(ctx);
  await openWorkspaceSettings(ctx, "cloud-marketplaces");
  await ctx.waitForText("Marketplace", { timeoutMs: 30_000 });
  const hasRefresh = await ctx.eval(
    "Boolean(window.__openworkControl?.listActions().find(a => a.id === 'extensions.refresh-marketplace'))",
  );
  if (hasRefresh) {
    await ctx.control("extensions.refresh-marketplace");
  }
  await ctx.waitForText(BROKEN_PLUGIN_NAME, { timeoutMs: 45_000 });
  await ctx.waitForText(VALID_PLUGIN_NAME, { timeoutMs: 45_000 });
}

async function searchMarketplace(ctx, value) {
  await ctx.fill('input[placeholder="Search marketplace extensions..."]', value);
  await ctx.waitFor(
    `document.body.innerText.includes(${JSON.stringify(value)})`,
    { timeoutMs: 15_000, label: `marketplace search result ${value}` },
  );
}

async function openMarketplacePluginDetail(ctx, pluginName) {
  await searchMarketplace(ctx, pluginName);
  await ctx.clickText(pluginName, { selector: "button", timeoutMs: 20_000 });
  await ctx.waitForText("COMPOSITION", { timeoutMs: 20_000 });
}

async function readMarketplacePluginDialog(ctx) {
  return ctx.eval(`(() => {
    const compact = (entry) => (entry?.innerText ?? entry?.textContent ?? '').replace(/\\s+/g, ' ').trim();
    const dialog = document.querySelector('[role="dialog"]');
    return {
      text: compact(dialog),
      buttonTexts: [...(dialog?.querySelectorAll('button') ?? [])].map(compact),
    };
  })()`);
}

function assertNoDialogInstallButtons(ctx, state) {
  const forbidden = state.buttonTexts.filter((text) => ["Add", "Install", "Update"].includes(text));
  ctx.assert(forbidden.length === 0, `Removed marketplace install/update buttons rendered in dialog: ${JSON.stringify(forbidden)}`);
}

async function workspaceServerJson(ctx, path) {
  return ctx.eval(`(async () => {
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!bridge) throw new Error("Electron bridge unavailable");
    const info = await bridge("openworkServerInfo");
    const baseUrl = String(info?.baseUrl ?? "").replace(/\\/+$/, "");
    const token = String(info?.ownerToken || info?.clientToken || "").trim();
    const workspaceId = (location.hash.match(/\\/workspace\\/([^/]+)/) || [])[1] || localStorage.getItem("openwork.react.activeWorkspace") || "";
    if (!baseUrl || !token || !workspaceId) throw new Error("Missing OpenWork server connection");
    const response = await fetch(baseUrl + "/workspace/" + encodeURIComponent(workspaceId) + ${JSON.stringify(path)}, {
      headers: { authorization: "Bearer " + token },
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!response.ok) throw new Error(${JSON.stringify(path)} + " -> " + response.status + " " + text.slice(0, 200));
    return body;
  })()`, { awaitPromise: true });
}

async function readMcpState(ctx) {
  const body = await workspaceServerJson(ctx, "/mcp");
  const names = Array.isArray(body.items) ? body.items.map((item) => item.name) : [];
  return { names, engineSync: body.engineSync ?? null };
}

async function assertNoBrokenMcp(ctx) {
  const mcp = await readMcpState(ctx);
  ctx.assert(!mcp.names.includes("broken"), `Broken MCP was installed unexpectedly: ${JSON.stringify(mcp.names)}`);
  ctx.log(`MCP servers after broken install: ${JSON.stringify(mcp.names)}`);
}

async function assertNoSkill(ctx, skillName) {
  const body = await workspaceServerJson(ctx, "/skills");
  const names = Array.isArray(body.items) ? body.items.map((item) => item.name) : [];
  ctx.assert(!names.includes(skillName), `Skill ${skillName} should not have been installed locally: ${JSON.stringify(names)}`);
}

async function openMcpSettings(ctx) {
  await ensureRenderedApp(ctx);
  await openWorkspaceSettings(ctx, "extensions/mcp");
  await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
  await ctx.clickText("MCPs", { selector: "button", timeoutMs: 10_000 }).catch(() => {});
  await ctx.clickText("Refresh", { selector: "button", timeoutMs: 10_000 }).catch(() => {});
}

export default {
  id: FLOW_ID,
  title: "Retired local import warning path: marketplace plugins are cloud-delivered only",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN", "OPENWORK_EVAL_WORKSPACE_PATH"],
  steps: [
    {
      name: "Prepare Den plugins and desktop workspace",
      run: async (ctx) => {
        await ensureRenderedApp(ctx);
        await setupCloudPlugins(ctx);
        await signInViaHandoff(ctx);
        await createFreshWorkspace(ctx);
        await waitForWorkspaceReady(ctx);
        await ensureRenderedApp(ctx);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Signed-in user sees both org marketplace plugins as cloud-delivered", {
          voiceover: vo[0],
          action: async () => {
            await openMarketplace(ctx);
            await searchMarketplace(ctx, RUN_TAG);
          },
          assert: async () => {
            await ctx.expectText(BROKEN_PLUGIN_NAME);
            await ctx.expectText(VALID_PLUGIN_NAME);
            await ctx.expectText("Runs in cloud");
          },
          screenshot: {
            name: "marketplace-shows-bundles",
            requireText: ["Marketplace", BROKEN_PLUGIN_NAME, VALID_PLUGIN_NAME, "Runs in cloud"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/cloud-marketplaces",
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The old broken-bundle import path is retired and exposes no Add action", {
          voiceover: vo[1],
          action: async () => {
            await openMarketplacePluginDetail(ctx, BROKEN_PLUGIN_NAME);
          },
          assert: async () => {
            const dialog = await readMarketplacePluginDialog(ctx);
            ctx.assert(dialog.text.includes("Active · runs in cloud"), `Cloud-active status missing: ${dialog.text}`);
            assertNoDialogInstallButtons(ctx, dialog);
            await ctx.expectNoText(VALID_WARNING);
            await assertNoSkill(ctx, BROKEN_SKILL_NAME);
            await assertNoBrokenMcp(ctx);
          },
          screenshot: {
            name: "broken-bundle-cloud-only-detail",
            requireText: [BROKEN_PLUGIN_NAME, "Active · runs in cloud"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/cloud-marketplaces",
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Persistent local state stays untouched after viewing the broken bundle", {
          voiceover: vo[2],
          action: async () => {
            await openMcpSettings(ctx);
          },
          assert: async () => {
            await assertNoSkill(ctx, BROKEN_SKILL_NAME);
            await assertNoBrokenMcp(ctx);
          },
          screenshot: {
            name: "mcp-settings-still-no-broken-row",
            requireText: ["Add Custom App", "MCPs", "YOUR APPS"],
            rejectText: ["Something went wrong", BROKEN_PLUGIN_NAME, "Broken MCP"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("The valid remote MCP bundle is also cloud-only with no local install", {
          voiceover: vo[3],
          action: async () => {
            await openMarketplace(ctx);
            await openMarketplacePluginDetail(ctx, VALID_PLUGIN_NAME);
          },
          assert: async () => {
            const dialog = await readMarketplacePluginDialog(ctx);
            ctx.assert(dialog.text.includes("Active · runs in cloud"), `Cloud-active status missing: ${dialog.text}`);
            assertNoDialogInstallButtons(ctx, dialog);
            await assertNoSkill(ctx, slugify(VALID_SKILL_TITLE));
            const mcp = await readMcpState(ctx);
            ctx.assert(!mcp.names.includes("linear"), `Linear MCP should not have been installed locally: ${JSON.stringify(mcp.names)}`);
          },
          screenshot: {
            name: "valid-bundle-cloud-only-detail",
            requireText: [VALID_PLUGIN_NAME, "Active · runs in cloud"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/cloud-marketplaces",
          },
        });
      },
    },
  ],
};
