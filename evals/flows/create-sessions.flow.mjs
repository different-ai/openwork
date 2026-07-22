import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUEST = "Create 3 new sessions that look into dolphins, bananas, and apple pies.";
const state = {
  workspaceId: null,
  workspacePath: null,
  originSessionId: null,
  originHash: null,
  createdSessions: [],
};

async function createWorkspace(ctx) {
  const evalWorkspaceRoot = process.env.OPENWORK_DATA_DIR || tmpdir();
  state.workspacePath = await mkdtemp(join(evalWorkspaceRoot, "openwork-create-sessions-"));
  const result = await ctx.eval(`(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const hostToken = localStorage.getItem("openwork.server.hostToken");
    if (!port || !token || !hostToken) throw new Error("OpenWork server auth is unavailable");
    const baseUrl = "http://127.0.0.1:" + port;
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      "X-OpenWork-Host-Token": hostToken,
    };
    const existingResponse = await fetch(baseUrl + "/workspaces", { headers });
    const existing = existingResponse.ok ? await existingResponse.json() : {};
    const previousEvalWorkspaces = (existing.workspaces || existing.items || [])
      .filter((workspace) => workspace.name === "CREATE-SESSIONS eval");
    const previousEvalPaths = previousEvalWorkspaces.map((workspace) => workspace.path);
    for (const workspace of previousEvalWorkspaces) {
      await fetch(baseUrl + "/workspaces/" + encodeURIComponent(workspace.id), {
        method: "DELETE",
        headers,
      }).catch(() => null);
      await window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceForget", workspace.id).catch(() => null);
    }
    const createdResponse = await fetch(baseUrl + "/workspaces/local", {
      method: "POST",
      headers,
      body: JSON.stringify({
        folderPath: ${JSON.stringify(state.workspacePath)},
        name: "CREATE-SESSIONS eval",
        preset: "starter",
      }),
    });
    const created = await createdResponse.json();
    if (!createdResponse.ok || !created.activeId) {
      throw new Error("Workspace creation failed: " + JSON.stringify(created));
    }
    const activatedResponse = await fetch(
      baseUrl + "/workspaces/" + encodeURIComponent(created.activeId) + "/activate?persist=true",
      { method: "POST", headers },
    );
    if (!activatedResponse.ok) {
      throw new Error("Workspace activation failed: " + await activatedResponse.text());
    }
    await window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceSetSelected", created.activeId);
    await window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceSetRuntimeActive", created.activeId);
    await window.__OPENWORK_ELECTRON__.invokeDesktop(
      "engineStart",
      ${JSON.stringify(state.workspacePath)},
      {
        runtime: "direct",
        workspacePaths: [${JSON.stringify(state.workspacePath)}],
      },
    );
    const serverInfo = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!serverInfo?.baseUrl) throw new Error("OpenWork server did not restart for the eval workspace");
    localStorage.setItem("openwork.server.urlOverride", serverInfo.baseUrl);
    if (serverInfo.port) localStorage.setItem("openwork.server.port", String(serverInfo.port));
    const nextToken = String(serverInfo.ownerToken || serverInfo.clientToken || "").trim();
    const nextHostToken = String(serverInfo.hostToken || "").trim();
    if (nextToken) localStorage.setItem("openwork.server.token", nextToken);
    if (nextHostToken) localStorage.setItem("openwork.server.hostToken", nextHostToken);
    window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
    const originResponse = await fetch(
      serverInfo.baseUrl.replace(/\\\/+$/, "")
        + "/workspace/" + encodeURIComponent(created.activeId) + "/opencode/session",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + nextToken,
        },
        body: JSON.stringify({ title: "CREATE-SESSIONS origin" }),
      },
    );
    const originBody = await originResponse.json();
    const origin = originBody?.data || originBody;
    if (!originResponse.ok || !origin?.id) {
      throw new Error("Origin session creation failed: " + JSON.stringify(originBody));
    }
    let preferences = {};
    try { preferences = JSON.parse(localStorage.getItem("openwork.preferences") || "{}"); } catch {}
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      hasCompletedOnboarding: true,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.react.activeWorkspace", created.activeId);
    location.hash = "#/workspace/" + encodeURIComponent(created.activeId)
      + "/session/" + encodeURIComponent(origin.id);
    return { workspaceId: created.activeId, originSessionId: origin.id, previousEvalPaths };
  })()`, { awaitPromise: true });
  state.workspaceId = result.workspaceId;
  state.originSessionId = result.originSessionId;
  const safeEvalPrefix = join(evalWorkspaceRoot, "openwork-create-sessions-");
  for (const previousPath of result.previousEvalPaths) {
    if (typeof previousPath === "string" && previousPath.startsWith(safeEvalPrefix)) {
      await rm(previousPath, { recursive: true, force: true });
    }
  }
}

async function readCreatedSessions(ctx) {
  return ctx.eval(`(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) throw new Error("OpenWork server connection is unavailable");
    const baseUrl = "http://127.0.0.1:" + port;
    const headers = { Authorization: "Bearer " + token };
    const listResponse = await fetch(
      baseUrl + "/workspace/${state.workspaceId}/sessions?limit=20",
      { headers },
    );
    if (!listResponse.ok) throw new Error("Session list failed: " + await listResponse.text());
    const list = await listResponse.json();
    const sessions = (list.items || []).filter((session) => session.id !== ${JSON.stringify(state.originSessionId)});
    return Promise.all(sessions.map(async (session) => {
      const snapshotResponse = await fetch(
        baseUrl + "/workspace/${state.workspaceId}/sessions/" + encodeURIComponent(session.id) + "/snapshot",
        { headers },
      );
      const snapshot = snapshotResponse.ok ? await snapshotResponse.json() : {};
      const messages = snapshot.item?.messages;
      return {
        id: session.id,
        title: session.title,
        started: Array.isArray(messages) && messages.some((message) => message?.info?.role === "user"),
      };
    }));
  })()`, { awaitPromise: true });
}

async function waitForCreatedSessions(ctx, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    latest = await readCreatedSessions(ctx);
    if (latest.length >= 3 && latest.every((session) => session.started)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for three started sessions: ${JSON.stringify(latest)}`);
}

async function cleanupWorkspace(ctx) {
  if (state.workspaceId) {
    await ctx.eval(`(async () => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      const baseUrl = info?.baseUrl || info?.connectUrl;
      const token = info?.ownerToken || info?.clientToken || "";
      const hostToken = info?.hostToken || "";
      if (baseUrl) {
        const headers = {};
        if (token) headers.Authorization = "Bearer " + token;
        if (hostToken) headers["X-OpenWork-Host-Token"] = hostToken;
        await fetch(
          baseUrl.replace(/\\/+$/, "") + "/workspaces/" + encodeURIComponent(${JSON.stringify(state.workspaceId)}),
          { method: "DELETE", headers },
        ).catch(() => null);
      }
      await window.__OPENWORK_ELECTRON__.invokeDesktop(
        "workspaceForget",
        ${JSON.stringify(state.workspaceId)},
      ).catch(() => null);
      return true;
    })()`, { awaitPromise: true });
  }
  if (state.workspacePath) {
    await rm(state.workspacePath, { recursive: true, force: true });
  }
}

export default {
  id: "create-sessions",
  title: "A plain-language request creates and starts multiple sessions without UI automation",
  spec: "CREATE-SESSIONS",
  steps: [
    {
      name: "Isolated workspace and origin session are ready",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl && window.__OPENWORK_ELECTRON__)", {
          timeoutMs: 60_000,
          label: "OpenWork desktop control surfaces",
        });
        await createWorkspace(ctx);
        await ctx.waitFor(
          `window.location.hash.includes(${JSON.stringify(`/workspace/${state.workspaceId}/session`)})`,
          { timeoutMs: 60_000, label: "CREATE-SESSIONS workspace route" },
        );
        await ctx.waitFor(`window.location.hash.includes(${JSON.stringify(`/session/${state.originSessionId}`)})`, {
          timeoutMs: 60_000,
          label: "origin session route",
        });
        state.originHash = await ctx.eval("window.location.hash");
      },
    },
    {
      name: "Plain English creates three backend sessions and keeps the origin open",
      run: async (ctx) => {
        await ctx.prove("CREATE-SESSIONS creates and starts every requested chat without navigating the origin", {
          action: async () => {
            const promoOpen = await ctx.eval(
              `document.body.innerText.includes("Continue without OpenWork Models")`,
            );
            if (promoOpen) {
              await ctx.clickText("Continue without OpenWork Models");
              await ctx.waitFor(
                `!document.body.innerText.includes("Continue without OpenWork Models")`,
                { timeoutMs: 10_000, label: "OpenWork Models promo dismissed" },
              );
            }
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((entry) => entry.id === 'composer.set_text' && entry.disabled === false)",
              { timeoutMs: 30_000, label: "composer set-text action" },
            );
            await ctx.control("composer.set_text", { text: REQUEST });
            await ctx.waitFor(
              "window.__openworkControl.listActions().some((entry) => entry.id === 'composer.send' && entry.disabled === false)",
              { timeoutMs: 30_000, label: "enabled send action" },
            );
            await ctx.control("composer.send");
            state.createdSessions = await waitForCreatedSessions(ctx);
            const sidebarSessionsExpression = state.createdSessions
              .map((session) => `Array.from(document.querySelectorAll("[data-sidebar-session-id]")).some((element) => element.getAttribute("data-sidebar-session-id") === ${JSON.stringify(session.id)})`)
              .join(" && ");
            await ctx.waitFor(sidebarSessionsExpression, {
              timeoutMs: 60_000,
              label: "created sessions in the sidebar",
            });
            const resultCardsExpression = state.createdSessions
              .map((session) => `document.querySelector(${JSON.stringify(`[data-open-created-session="${session.id}"]`)})`)
              .join(" && ");
            await ctx.waitFor(
              `document.querySelector('[data-openwork-session-create-card][data-created-session-count="3"]') && ${resultCardsExpression}`,
              { timeoutMs: 60_000, label: "created chat card and Open chat actions" },
            );
            await ctx.eval(`(() => {
              document.querySelectorAll("[data-sonner-toast] [data-close-button]")
                .forEach((button) => button.click());
              return true;
            })()`);
          },
          assert: async () => {
            ctx.assert(state.createdSessions.length === 3, `Expected 3 created sessions, got ${state.createdSessions.length}`);
            ctx.assert(state.createdSessions.every((session) => session.started), "Every created session must be started.");
            const titles = state.createdSessions.map((session) => session.title.toLowerCase()).join(" ");
            ctx.assert(titles.includes("dolphin"), `No dolphin session was created: ${titles}`);
            ctx.assert(titles.includes("banana"), `No banana session was created: ${titles}`);
            ctx.assert(titles.includes("apple") && titles.includes("pie"), `No apple pie session was created: ${titles}`);
            const currentHash = await ctx.eval("window.location.hash");
            ctx.assert(currentHash === state.originHash, `Origin session changed from ${state.originHash} to ${currentHash}`);
          },
          screenshot: {
            name: "three-sessions-created",
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Open chat action navigates to the selected created session",
      run: async (ctx) => {
        const target = state.createdSessions[0];
        ctx.assert(Boolean(target), "Expected a created session to open.");
        await ctx.eval(`(() => {
          const button = document.querySelector(${JSON.stringify(`[data-open-created-session="${target?.id}"]`)});
          if (!(button instanceof HTMLElement)) throw new Error("Open chat action is unavailable");
          button.click();
          return true;
        })()`);
        await ctx.waitFor(
          `window.location.hash.includes(${JSON.stringify(`/session/${target?.id}`)})`,
          { timeoutMs: 30_000, label: "created session route" },
        );
        const currentHash = await ctx.eval("window.location.hash");
        ctx.assert(currentHash.includes(`/session/${target?.id}`), `Open chat navigated to ${currentHash}`);
      },
    },
    {
      name: "Temporary eval workspace is removed",
      run: async (ctx) => {
        await cleanupWorkspace(ctx);
      },
    },
  ],
};
