import { mkdir, realpath, writeFile } from "node:fs/promises";
import { addInitScript, allocateFreePorts, type Surface } from "@openwork/cdp";
import type { DesktopHandle } from "@openwork/hosts";
import { denFetch, readComposerState } from "@openwork/behaviors";
import { newRemoteTaskViewer } from "./infra/remote-task-live-sync-browser.ts";
import { restartRemoteTaskDesktop } from "./infra/remote-task-electron-restart.ts";
import { mcpMock, queryDenDatabase, type Place, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { CHAT_PROMPT, CHAT_REPLY, CHAT_TITLE, COMPUTER_LABEL, LIVE_TAIL, TASK_PROMPT, TASK_TITLE, startRunner } from "./remote-session-helper-view.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export function remoteTaskLiveSyncWorld(seed: Seed, ctx: { place: Place }) {
  return remoteTaskWorld(seed, ctx, false);
}

export function remoteTaskElectronWorld(seed: Seed, ctx: { place: Place }) {
  return remoteTaskWorld(seed, ctx, true);
}

async function remoteTaskWorld(seed: Seed, ctx: { place: Place }, native: boolean) {
  if (native && ctx.place.kind !== "local") throw new Error("The real Electron restart proof requires local ownership of both processes.");
  const [desktopPort] = native ? await allocateFreePorts(1) : [];
  const { den, webPort } = await denForAppWeb(seed, {
    web: false,
    trustedOrigins: desktopPort ? [`http://localhost:${desktopPort}`, `http://127.0.0.1:${desktopPort}`] : [],
    org: { name: "Launch team", admin: { name: "Launch Owner" } },
  });
  const desktopEnv: Record<string, string> = { VITE_DEN_BASE_URL: den.ref.apiUrl, VITE_DEN_API_BASE_URL: den.ref.apiUrl };
  if (native) {
    const bootstrapPath = seed.tmpPath("live-sync-electron-bootstrap.json");
    await writeFile(bootstrapPath, JSON.stringify({ baseUrl: den.ref.apiUrl, apiBaseUrl: den.ref.apiUrl, requireSignin: false }));
    desktopEnv.OPENWORK_DESKTOP_BOOTSTRAP_PATH = bootstrapPath;
  }
  const orgId = await seededOrganizationId(seed, den.admin);
  if (!orgId) throw new Error("Could not resolve the seeded organization.");
  const enabled = await seed.api(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, {
    method: "PUT", body: JSON.stringify({ capabilities: { remoteSessionLiveSync: true } }),
  });
  if (!enabled.response.ok) throw new Error(`Could not enable live sync: ${enabled.response.status}`);
  const runner = await startRunner(seed, { apiUrl: den.ref.apiUrl, member: den.admin, orgId, liveSync: true });
  const tmp = seed.tmpPath("live-sync-workspace");
  let mock: Awaited<ReturnType<ReturnType<typeof mcpMock>["boot"]>>["handle"] | undefined;
  try {
    await mkdir(tmp, { recursive: true });
    const workspacePath = await realpath(tmp);
    const profileDir = seed.tmpPath("live-sync-electron-profile");
    const opened = native ? await (async () => {
      const app = await seed.desktop({ den, workspacePath, profileDir, name: "remote-task-live-sync", env: { ...desktopEnv, PORT: String(desktopPort) } });
      return { app, workspace: await seed.workspace(app, workspacePath) };
    })() : await signedInAppWeb(seed, { den, webPort, engine: "v1", name: "remote-task-live-sync", workspacePath });
    const { app, workspace } = opened;
    await addInitScript(app.client, () => { localStorage.setItem("openwork.react.settings.theme-mode", "dark"); });
    const headers = { "x-openwork-org-id": orgId };
    const issued = await seed.api(den.admin, "/v1/mcp/token", { method: "POST", headers, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    const token = (issued.body as { token?: string })?.token;
    if (!issued.response.ok || !token) throw new Error(`Could not issue MCP token: ${issued.response.status}`);
    const mcpUrl = `${den.ref.apiUrl}/mcp/agent`;
    const response = await fetch(mcpUrl, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: { name: "remote-session:targets", body: {} } } }),
    });
    const raw = await response.text();
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const targets = JSON.parse(data ? data.slice(5) : raw);
    const computer = targets.result?.structuredContent?.computers?.find((entry: { label: string }) => entry.label === COMPUTER_LABEL);
    if (!computer?.computerId) throw new Error(`Studio computer is not a target (${response.status})`);
    const configure = (url: string) => configureProvider(seed, app, workspace.workspaceId, "remote-helper-proof", "remote-helper-agent", {
      permission: { "*": "allow" },
      mcp: { openwork: { type: "remote", url: mcpUrl, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } } },
      provider: { "remote-helper-proof": { npm: "@ai-sdk/openai-compatible", name: "Remote helper agent",
        options: { baseURL: `${url}/v1`, apiKey: "sk-remote-helper-proof" }, models: { "remote-helper-agent": { name: "Remote helper agent" } } } },
    }, "v1");
    // Chat creation requires a configured model. No turn runs until the
    // deterministic witness below has the new chat's IDs.
    await configure(den.ref.apiUrl);
    const session = await seed.session(app, { title: CHAT_TITLE });
    // The real tool call runs in the parent's turn. The fixture supplies the
    // parent IDs explicitly; neither an earlier tool receipt nor cache is seeded.
    mock = (await mcpMock({ agentWorkloads: [{ promptMarker: CHAT_PROMPT, latestUserTurn: true, finalReply: CHAT_REPLY, steps: [{
      tool: "execute_capability", arguments: { name: "remote-session:create", body: {
        target: "registered", computerId: computer.computerId, title: TASK_TITLE, prompt: TASK_PROMPT,
        originSessionId: session.sessionId, originWorkspaceId: workspace.workspaceId,
      } },
    }] }] }).boot(ctx.place)).handle;
    await configure(mock.url);
    return {
      app, den, profileDir, session, workspace, runnerReads: runner.reads, followUps: runner.followUps,
      publishLiveUpdate: runner.publishLiveUpdate,
      composer: () => readComposerState(app),
      secondViewer: () => newRemoteTaskViewer(app, den.admin, LIVE_TAIL),
      async boundTask() {
        const result = await denFetch(den.admin, `/v1/remote-sessions/bound?parentSessionId=${encodeURIComponent(session.sessionId)}`, { headers: { ...headers, authorization: `Bearer ${den.admin.token}` } });
        if (!result.response.ok) throw new Error(`Could not read parent tasks: ${result.response.status}`);
        return (result.body as { sessions: { commandId: string; parentWorkspaceId: string; tailUpdatedAt: string | null }[] }).sessions[0];
      },
      async storedTailCount(commandId: string) {
        const url = den.database?.url;
        if (!url || !new URL(url).pathname.startsWith("/openwork_eval_")) throw new Error("An isolated Den MySQL database is required.");
        const rows = await queryDenDatabase(url, "SELECT byte_size FROM remote_session_tail WHERE thread_key = ?", [`command:${commandId}`]);
        return rows.length;
      },
      restartDesktop: () => {
        if (!native || app.handle.kind !== "electron") throw new Error("A real Electron desktop is required.");
        return restartRemoteTaskDesktop(app as Surface & DesktopHandle, profileDir, desktopEnv);
      },
      async [Symbol.asyncDispose]() { await runner.stop(); await mock?.stop(); },
    };
  } catch (error) {
    await runner.stop();
    await mock?.stop();
    throw error;
  }
}
