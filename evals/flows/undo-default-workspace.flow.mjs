import { mkdtemp } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("undo-default-workspace");
const WELCOME_FOLDER_INPUT = 'input[placeholder="/workspace/my-project"]';

async function desktopWorkspaceList(ctx) {
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", {
    timeoutMs: 60_000,
    label: "desktop bridge",
  });
  return ctx.eval("window.__OPENWORK_ELECTRON__.invokeDesktop('workspaceBootstrap')", {
    awaitPromise: true,
  });
}

async function resetToFreshWelcome(ctx) {
  const list = await desktopWorkspaceList(ctx);
  ctx.log(`desktop workspaces before reset: ${JSON.stringify(list?.workspaces ?? [])}`);
  for (const workspace of list?.workspaces ?? []) {
    await ctx.eval(`(async () => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo").catch(() => null);
      const baseUrl = info?.baseUrl || info?.connectUrl || localStorage.getItem("openwork.server.active");
      const token = info?.ownerToken || info?.clientToken || localStorage.getItem("openwork.server.token") || "";
      const hostToken = info?.hostToken || localStorage.getItem("openwork.server.hostToken") || "";
      if (baseUrl) {
        const headers = {};
        if (token) headers.authorization = "Bearer " + token;
        if (hostToken) headers["x-openwork-host-token"] = hostToken;
        await window.__OPENWORK_ELECTRON__.invokeDesktop(
          "__fetch",
          baseUrl.replace(/\\/+$/, "") + "/workspaces/" + encodeURIComponent(${JSON.stringify(workspace.id)}),
          { method: "DELETE", headers, timeoutMs: 8_000 },
        ).catch(() => null);
      }
      await window.__OPENWORK_ELECTRON__.invokeDesktop(
        "workspaceForget",
        ${JSON.stringify(workspace.id)},
      ).catch(() => null);
      return true;
    })()`, { awaitPromise: true });
  }

  const cleanup = await ctx.eval(`(async () => {
    const invoke = window.__OPENWORK_ELECTRON__.invokeDesktop;
    const info = await invoke("openworkServerInfo");
    const baseUrl = info?.baseUrl || info?.connectUrl;
    if (!baseUrl) throw new Error("OpenWork server URL is unavailable");
    const headers = {};
    const token = info?.ownerToken || info?.clientToken || "";
    if (token) headers.authorization = "Bearer " + token;
    if (info?.hostToken) headers["x-openwork-host-token"] = info.hostToken;
    const response = await invoke("__fetch", baseUrl.replace(/\\/+$/, "") + "/workspaces", {
      method: "GET",
      headers,
      timeoutMs: 8_000,
    });
    const payload = typeof response?.body === "string"
      ? JSON.parse(response.body)
      : response?.body ?? response;
    for (const workspace of payload?.workspaces ?? payload?.items ?? []) {
      await invoke(
        "__fetch",
        baseUrl.replace(/\\/+$/, "") + "/workspaces/" + encodeURIComponent(workspace.id),
        { method: "DELETE", headers, timeoutMs: 8_000 },
      );
      await invoke("workspaceForget", workspace.id).catch(() => null);
    }
    const afterResponse = await invoke("__fetch", baseUrl.replace(/\\/+$/, "") + "/workspaces", {
      method: "GET",
      headers,
      timeoutMs: 8_000,
    });
    const afterPayload = typeof afterResponse?.body === "string"
      ? JSON.parse(afterResponse.body)
      : afterResponse?.body ?? afterResponse;
    return { payload, afterPayload };
  })()`, { awaitPromise: true });
  ctx.log(`server workspace cleanup: ${JSON.stringify(cleanup)}`);
  await ctx.eval(`(() => {
    let prefs = {};
    try { prefs = JSON.parse(localStorage.getItem("openwork.preferences") || "{}"); } catch {}
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...prefs,
      hasCompletedOnboarding: false,
    }));
    localStorage.removeItem("openwork.react.activeWorkspace");
    localStorage.removeItem("openwork.react.sessionByWorkspace");
    location.hash = "#/session";
    location.reload();
    return true;
  })()`);
  await ctx.waitFor("Boolean(window.__openworkControl)", {
    timeoutMs: 60_000,
    label: "control API after reset",
  });
  await ctx.waitFor("location.hash.includes('/welcome')", {
    timeoutMs: 60_000,
    label: "welcome route",
  });
  await ctx.waitForText("Welcome to OpenWork", { timeoutMs: 30_000 });
}

export default {
  id: "undo-default-workspace",
  title: "Users control desktop workspace creation",
  kind: "user-facing",
  steps: [
    {
      name: "No workspaces opens welcome",
      run: async (ctx) => {
        await ctx.prove("Desktop shows welcome whenever no workspaces exist", {
          voiceover: vo[0],
          action: async () => resetToFreshWelcome(ctx),
          assert: async () => {
            const list = await desktopWorkspaceList(ctx);
            ctx.assert((list?.workspaces ?? []).length === 0, "Expected zero workspaces.");
            await ctx.expectHashIncludes("/welcome");
            await ctx.expectText("Pick a folder to get started");
          },
          screenshot: {
            name: "welcome-with-no-workspaces",
            requireText: ["Welcome to OpenWork", "Pick a folder to get started"],
            hashIncludes: ["/welcome"],
          },
        });
      },
    },
    {
      name: "User chooses workspace folder",
      run: async (ctx) => {
        const workspaceDir = await mkdtemp(join(homedir(), ".openwork-eval-user-workspace-"));
        ctx.workspaceDir = workspaceDir;
        await ctx.prove("OpenWork creates a workspace only in the chosen folder", {
          voiceover: vo[1],
          action: async () => {
            await ctx.waitFor(`Boolean(document.querySelector(${JSON.stringify(WELCOME_FOLDER_INPUT)}))`, {
              timeoutMs: 30_000,
              label: "manual welcome folder input",
            });
            await ctx.fill(WELCOME_FOLDER_INPUT, workspaceDir);
            await ctx.clickText("Use this folder", { selector: "button", timeoutMs: 15_000 });
          },
          assert: async () => {
            await ctx.waitForText("Power your first task", { timeoutMs: 60_000 });
            const created = await ctx.eval(`(async () => {
              const invoke = window.__OPENWORK_ELECTRON__.invokeDesktop;
              const info = await invoke("openworkServerInfo");
              const headers = {};
              const token = info?.ownerToken || info?.clientToken || "";
              if (token) headers.authorization = "Bearer " + token;
              if (info?.hostToken) headers["x-openwork-host-token"] = info.hostToken;
              const response = await invoke(
                "__fetch",
                (info.baseUrl || info.connectUrl).replace(/\\/+$/, "") + "/workspaces",
                { method: "GET", headers, timeoutMs: 8_000 },
              );
              const list = typeof response?.body === "string"
                ? JSON.parse(response.body)
                : response?.body ?? response;
              return (list?.workspaces ?? list?.items ?? []).find(
                (workspace) => workspace.path === ${JSON.stringify(workspaceDir)}
              ) ?? null;
            })()`, { awaitPromise: true });
            ctx.assert(created.path === workspaceDir, `Unexpected workspace path: ${created.path}`);
            ctx.workspaceId = created.id;
          },
          screenshot: {
            name: "chosen-folder-created",
            requireText: ["Power your first task"],
          },
        });
      },
    },
    {
      name: "Classic onboarding steps",
      run: async (ctx) => {
        await ctx.prove("Provider and attribution onboarding run before entering the workspace", {
          voiceover: vo[2],
          action: async () => {
            await ctx.waitForText("Power your first task", { timeoutMs: 60_000 });
            await ctx.clickText("Skip and use the free model", {
              selector: "button",
              timeoutMs: 30_000,
            });
            await ctx.waitForText("How did you hear about OpenWork?", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("How did you hear about OpenWork?");
            const onWelcome = await ctx.eval("location.hash.includes('/welcome')");
            ctx.assert(onWelcome, "Onboarding left welcome before completion.");
          },
          screenshot: {
            name: "attribution-before-workspace",
            requireText: ["How did you hear about OpenWork?", "Skip"],
            hashIncludes: ["/welcome"],
          },
        });
      },
    },
    {
      name: "Session ready after onboarding",
      run: async (ctx) => {
        await ctx.prove("Completing onboarding opens a ready session", {
          voiceover: vo[3],
          action: async () => {
            await ctx.clickText("Skip", { selector: "button", timeoutMs: 15_000 });
            await ctx.waitFor(`(() => {
              const route = window.__openworkControl.snapshot().route || "";
              return route.includes("/session/ses_");
            })()`, { timeoutMs: 90_000, label: "onboarding-created session route" });
            ctx.sessionId = await ctx.eval(`(() => {
              const route = window.__openworkControl.snapshot().route || "";
              const marker = "/session/";
              const index = route.indexOf(marker);
              return index >= 0
                ? route.slice(index + marker.length).split("?")[0].split("#")[0]
                : null;
            })()`);
          },
          assert: async () => {
            const sessions = await ctx.control("session.list_sessions");
            ctx.assert(
              Array.isArray(sessions) && sessions.some((session) => session.sessionId === ctx.sessionId),
              `Session ${ctx.sessionId} was not listed.`,
            );
            await ctx.waitFor(
              `Boolean(document.querySelector('[contenteditable="true"][aria-placeholder="Describe your task..."]'))`,
              { timeoutMs: 30_000, label: "ready composer" },
            );
          },
          screenshot: {
            name: "new-session-ready",
            requireText: ["Describe your task...", "Run task"],
            hashIncludes: ["/session/ses_"],
          },
        });
      },
    },
    {
      name: "Empty workspace stays empty",
      run: async (ctx) => {
        const emptyDir = await mkdtemp(join(homedir(), ".openwork-eval-empty-workspace-"));
        await ctx.prove("Opening an empty workspace does not create a session", {
          voiceover: vo[4],
          action: async () => {
            const created = await ctx.eval(`(async () => {
              const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
              const baseUrl = info?.baseUrl || info?.connectUrl || localStorage.getItem("openwork.server.active");
              if (!baseUrl) throw new Error("OpenWork server URL is unavailable");
              const token = info?.ownerToken || info?.clientToken || localStorage.getItem("openwork.server.token") || "";
              const hostToken = info?.hostToken || localStorage.getItem("openwork.server.hostToken") || "";
              const headers = { "content-type": "application/json" };
              if (token) headers.authorization = "Bearer " + token;
              if (hostToken) headers["x-openwork-host-token"] = hostToken;
              const response = await window.__OPENWORK_ELECTRON__.invokeDesktop(
                "__fetch",
                baseUrl.replace(/\\/+$/, "") + "/workspaces/local",
                {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    folderPath: ${JSON.stringify(emptyDir)},
                    name: "Empty workspace",
                    preset: "starter",
                  }),
                  timeoutMs: 30_000,
                },
              );
              const payload = typeof response?.body === "string"
                ? JSON.parse(response.body)
                : response?.body ?? response;
              const workspaceId = payload.activeId
                || payload.workspaces?.find((workspace) => workspace.path === ${JSON.stringify(emptyDir)})?.id;
              if (!workspaceId) throw new Error("Empty workspace was not created");
              await window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceSetSelected", workspaceId);
              await window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceSetRuntimeActive", workspaceId);
              localStorage.setItem("openwork.react.activeWorkspace", workspaceId);
              return { workspaceId };
            })()`, { awaitPromise: true });
            ctx.emptyWorkspaceId = created.workspaceId;
            await ctx.eval("(() => { location.reload(); return true; })()");
            await ctx.waitFor("Boolean(window.__openworkControl)", {
              timeoutMs: 60_000,
              label: "control API after workspace reload",
            });
            await ctx.navigateHash(`/workspace/${created.workspaceId}/session`);
            await ctx.waitFor(`location.hash.includes('/workspace/${created.workspaceId}/session')`, {
              timeoutMs: 30_000,
              label: "empty workspace route",
            });
            await ctx.waitForText("No tasks yet.", { timeoutMs: 90_000 });
          },
          assert: async () => {
            const after = await ctx.control("session.list_sessions");
            ctx.assert(
              Array.isArray(after) && after.length === 0,
              "Opening the empty workspace created a session.",
            );
            const sessionOpened = await ctx.eval("location.hash.includes('/session/ses_')");
            ctx.assert(!sessionOpened, "An empty session opened unexpectedly.");
            await ctx.expectText("No tasks yet.");
          },
          screenshot: {
            name: "empty-workspace-no-session",
            requireText: ["No tasks yet.", "Select or create a session to get started."],
            rejectText: ["Describe your task..."],
          },
        });
      },
    },
  ],
};
