import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "windows-last-workspace-deletion";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const FIXTURES = [
  { name: "Deletion proof alpha", path: "C:\\ow\\delete-fix-fraimz\\alpha" },
  { name: "Deletion proof beta", path: "C:\\ow\\delete-fix-fraimz\\beta" },
];
const MODEL_UNAVAILABLE_TEXT = "The model you were using is no longer available";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDesktop(ctx) {
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", {
    timeoutMs: 60_000,
    label: "desktop bridge",
  });
}

async function desktopWorkspaces(ctx) {
  return ctx.eval("window.__OPENWORK_ELECTRON__.invokeDesktop('workspaceBootstrap')", {
    awaitPromise: true,
  });
}

async function serverRequest(ctx, path, options = {}) {
  return ctx.eval(`(async () => {
    const invoke = window.__OPENWORK_ELECTRON__.invokeDesktop;
    const info = await invoke("openworkServerInfo");
    const baseUrl = String(info?.baseUrl || info?.connectUrl || "").replace(/\\/+$/, "");
    if (!baseUrl) throw new Error("OpenWork server URL is unavailable");
    const headers = { "content-type": "application/json" };
    const token = info?.ownerToken || info?.clientToken || "";
    if (token) headers.authorization = "Bearer " + token;
    if (info?.hostToken) headers["x-openwork-host-token"] = info.hostToken;
    const response = await invoke("__fetch", baseUrl + ${JSON.stringify(path)}, {
      method: ${JSON.stringify(options.method ?? "GET")},
      headers,
      timeoutMs: 20_000,
      ${options.body === undefined ? "" : `body: ${JSON.stringify(JSON.stringify(options.body))},`}
    });
    const body = typeof response?.body === "string" ? JSON.parse(response.body) : response?.body ?? response;
    if (response?.status && response.status >= 400) {
      throw new Error(${JSON.stringify(options.method ?? "GET")} + " " + ${JSON.stringify(path)} + " failed: " + response.status);
    }
    return body;
  })()`, { awaitPromise: true });
}

function serverWorkspaceItems(payload) {
  if (Array.isArray(payload?.workspaces)) return payload.workspaces;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

async function resetFixtures(ctx) {
  await waitForDesktop(ctx);
  const desktopBefore = await desktopWorkspaces(ctx);
  const serverBefore = await serverRequest(ctx, "/workspaces");
  const ids = new Set([
    ...(desktopBefore?.workspaces ?? []).map((workspace) => workspace.id),
    ...serverWorkspaceItems(serverBefore).map((workspace) => workspace.id),
  ]);
  for (const workspaceId of ids) {
    await serverRequest(ctx, `/workspaces/${encodeURIComponent(workspaceId)}`, { method: "DELETE" }).catch(() => null);
    await ctx.eval(`window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceForget", ${JSON.stringify(workspaceId)})`, {
      awaitPromise: true,
    }).catch(() => null);
  }

  const created = [];
  for (const fixture of FIXTURES) {
    const serverState = await serverRequest(ctx, "/workspaces/local", {
      method: "POST",
      body: { folderPath: fixture.path, name: fixture.name, preset: "starter" },
    });
    const workspace = serverWorkspaceItems(serverState).find((item) => item.path === fixture.path);
    const workspaceId = serverState?.activeId || serverState?.selectedId || workspace?.id;
    ctx.assert(Boolean(workspaceId), `Workspace creation returned no id for ${fixture.path}`);
    await ctx.eval(`window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceCreate", ${JSON.stringify({
      folderPath: fixture.path,
      name: fixture.name,
      preset: "starter",
    })})`, { awaitPromise: true });
    created.push({ ...fixture, id: workspaceId });
  }

  const selected = created[created.length - 1];
  await serverRequest(ctx, `/workspaces/${encodeURIComponent(selected.id)}/activate?persist=true`, { method: "POST" });
  await ctx.eval(`(async () => {
    const invoke = window.__OPENWORK_ELECTRON__.invokeDesktop;
    await invoke("workspaceSetSelected", ${JSON.stringify(selected.id)});
    await invoke("workspaceSetRuntimeActive", ${JSON.stringify(selected.id)});
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem("openwork.preferences") || "{}"); } catch {}
    localStorage.setItem("openwork.preferences", JSON.stringify({ ...prefs, hasCompletedOnboarding: true }));
    location.hash = ${JSON.stringify(`#/workspace/${selected.id}/session`)};
    location.reload();
    return true;
  })()`, { awaitPromise: true }).catch(() => null);
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 90_000, label: "app after fixture setup" });
  await ctx.waitForText(FIXTURES[0].name, { timeoutMs: 90_000 });
  await ctx.waitForText(FIXTURES[1].name, { timeoutMs: 90_000 });
  const sidebarCollapsed = await ctx.eval('document.querySelector(\'[data-slot="sidebar"]\')?.getAttribute("data-state") === "collapsed"');
  if (sidebarCollapsed) {
    await ctx.clickText("Toggle Sidebar", { selector: "button", timeoutMs: 15_000 });
    await ctx.waitFor('document.querySelector(\'[data-slot="sidebar"]\')?.getAttribute("data-state") === "expanded"', {
      timeoutMs: 15_000,
      label: "fixture sidebar expanded",
    });
  }
  return created;
}

async function removeWorkspaceThroughSidebar(ctx, workspaceName) {
  const opened = await ctx.eval(`(() => {
    window.confirm = () => true;
    const label = Array.from(document.querySelectorAll("span")).find(
      (element) => element.textContent?.trim() === ${JSON.stringify(workspaceName)},
    );
    const header = label?.closest("button")?.parentElement;
    const button = header?.querySelector('button[aria-label="Workspace options"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  ctx.assert(opened === true, `Workspace options were unavailable for ${workspaceName}`);
  await ctx.waitForText("Remove workspace", { timeoutMs: 15_000 });
  await ctx.clickText("Remove workspace", { selector: '[role="menuitem"]', timeoutMs: 15_000 });
  await ctx.waitFor(`!document.body.innerText.includes(${JSON.stringify(workspaceName)})`, {
    timeoutMs: 90_000,
    label: `${workspaceName} removed from sidebar`,
  });
}

async function assertEmpty(ctx) {
  const desktop = await desktopWorkspaces(ctx);
  const server = await serverRequest(ctx, "/workspaces");
  ctx.assert((desktop?.workspaces ?? []).length === 0, "Expected zero persisted desktop workspaces");
  ctx.assert(serverWorkspaceItems(server).length === 0, "Expected zero server workspaces");
  await ctx.expectHashIncludes("/session");
  await ctx.expectText("Create or connect a workspace");
  await ctx.expectNoText("Preparing workspace");
  await ctx.expectNoText(MODEL_UNAVAILABLE_TEXT);
}

export default {
  id: FLOW_ID,
  title: "Last Windows workspace stays deleted",
  kind: "user-facing",
  steps: [
    {
      name: "Remove one populated workspace",
      run: async (ctx) => {
        await ctx.prove("Removing one workspace leaves the other workspace ready", {
          voiceover: vo[0],
          action: async () => {
            ctx.fixtures = await resetFixtures(ctx);
            await removeWorkspaceThroughSidebar(ctx, FIXTURES[0].name);
          },
          assert: async () => {
            const desktop = await desktopWorkspaces(ctx);
            ctx.assert((desktop?.workspaces ?? []).length === 1, "Expected one desktop workspace after the first removal");
            await ctx.expectText(FIXTURES[1].name);
            await ctx.expectNoText(FIXTURES[0].name);
          },
          screenshot: {
            name: "one-workspace-remains",
            requireText: [FIXTURES[1].name],
            rejectText: [FIXTURES[0].name, MODEL_UNAVAILABLE_TEXT],
          },
        });
      },
    },
    {
      name: "Remove the final workspace",
      run: async (ctx) => {
        await ctx.prove("Removing the final workspace opens the clean empty workspace screen", {
          voiceover: vo[1],
          action: async () => {
            await removeWorkspaceThroughSidebar(ctx, FIXTURES[1].name);
          },
          assert: async () => {
            await assertEmpty(ctx);
            await ctx.eval("performance.clearResourceTimings(); true");
          },
          screenshot: {
            name: "final-workspace-removed",
            requireText: ["Create or connect a workspace", "Create workspace"],
            rejectText: [...FIXTURES.map((fixture) => fixture.name), "Preparing workspace", MODEL_UNAVAILABLE_TEXT],
            hashIncludes: ["/session"],
          },
        });
      },
    },
    {
      name: "Empty state remains quiet",
      run: async (ctx) => {
        await ctx.prove("Deleted workspaces do not resume polling or open the model picker", {
          voiceover: vo[2],
          action: async () => {
            await sleep(15_000);
            await ctx.clickText("Toggle Sidebar", { selector: "button", timeoutMs: 15_000 });
            await ctx.waitFor('document.querySelector(\'[data-slot="sidebar"]\')?.getAttribute("data-state") === "collapsed"', {
              timeoutMs: 15_000,
              label: "empty sidebar collapsed",
            });
          },
          assert: async () => {
            await assertEmpty(ctx);
            const staleRequests = await ctx.eval(`performance.getEntriesByType("resource")
              .map((entry) => entry.name)
              .filter((name) => ${JSON.stringify(ctx.fixtures.map((fixture) => fixture.id))}.some(
                (workspaceId) => name.includes("/workspace/" + workspaceId + "/") || name.includes("workspace=" + workspaceId),
              ))`);
            ctx.assert(staleRequests.length === 0, `Found stale deleted-workspace requests: ${JSON.stringify(staleRequests)}`);
          },
          screenshot: {
            name: "empty-state-stays-quiet",
            requireText: ["Create or connect a workspace", "Create workspace"],
            rejectText: [...FIXTURES.map((fixture) => fixture.name), "Preparing workspace", MODEL_UNAVAILABLE_TEXT],
            hashIncludes: ["/session"],
          },
        });
      },
    },
    {
      name: "Empty state survives restart",
      run: async (ctx) => {
        await ctx.prove("The empty workspace registry remains authoritative after restart", {
          voiceover: vo[3],
          action: async () => {
            await ctx.eval("window.__OPENWORK_ELECTRON__.shell.relaunch()", { awaitPromise: true }).catch(() => null);
            await sleep(2_000);
            await ctx.reconnect({ timeoutMs: 120_000 });
            await waitForDesktop(ctx);
            await ctx.waitForText("Create or connect a workspace", { timeoutMs: 90_000 });
            await ctx.clickText("Create workspace", { selector: "button", timeoutMs: 15_000 });
            await ctx.waitForText("Initialize a new folder-based workspace", { timeoutMs: 15_000 });
          },
          assert: async () => {
            await assertEmpty(ctx);
            await ctx.expectText("Local workspace");
          },
          screenshot: {
            name: "empty-state-after-restart",
            requireText: ["Create Workspace", "Initialize a new folder-based workspace", "Local workspace"],
            rejectText: [...FIXTURES.map((fixture) => fixture.name), "Preparing workspace", MODEL_UNAVAILABLE_TEXT],
            hashIncludes: ["/session"],
          },
        });
      },
    },
  ],
};
