import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { providersBeforeFirstWorkspace } from "../worlds/providers-before-workspace.ts";

const test = spec.world(providersBeforeFirstWorkspace, {
  timeout: 600_000,
  resources: {
    surfaces: ["desktop"],
    services: ["den"],
    nativeReason: "The Electron runtime owns the local server and its managed engine; only the desktop starts that engine before a member's first workspace exists and must keep it running when that workspace is created.",
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listField(value: unknown, field: string): unknown[] {
  return isRecord(value) && Array.isArray(value[field]) ? value[field] : [];
}

function connectedProviderIds(body: unknown): string[] {
  return listField(body, "connected").filter((id): id is string => typeof id === "string");
}

function serverIdentity(body: unknown): { port: number; uptimeMs: number } {
  const server = isRecord(body) && isRecord(body.server) ? body.server : null;
  const port = typeof server?.port === "number" ? server.port : -1;
  const uptimeMs = isRecord(body) && typeof body.uptimeMs === "number" ? body.uptimeMs : -1;
  return { port, uptimeMs };
}

test("a member who signs in before creating a workspace can use their organization's AI providers right away", async ({ world, user, agent, probe, step, evidence }) => {
  await step("before: the member is signed in to the organization and has no workspace yet", async () => {
    await user.notSee({ text: /Something went wrong/ });
    const workspaces = await probe.desktopApi("/workspaces");
    const count = listField(workspaces.body, "items").length;
    evidence.recordAssertionEvidence(
      "The member has no workspace",
      `GET /workspaces → HTTP ${workspaces.status}, ${count} workspaces`,
      workspaces.status === 200 && count === 0,
    );
    expect(workspaces.status).toBe(200);
    expect(count).toBe(0);
    await user.screenshot();
  });

  await step("the local engine is already running with no workspace", async () => {
    await user.notSee({ text: "Not connected to a server" });
    const engine = await probe.eventually(async () => {
      const result = await probe.desktopApi("/opencode/provider");
      return { status: result.status, providers: listField(result.body, "all").length };
    }, {
      within: 120_000,
      label: "the engine answers without a workspace",
      until: (result) => result.status === 200,
    });
    evidence.recordAssertionEvidence(
      "The engine answers before any workspace exists",
      `GET /opencode/provider → HTTP ${engine.status}; ${engine.providers} providers in the catalog`,
      engine.status === 200,
    );
    expect(engine.status).toBe(200);
  });

  await step("after: AI provider settings list the organization's provider instead of a server error", async () => {
    await agent.run("route.settings.providers");
    await user.see({ text: world.providerName }, { timeoutMs: 180_000 });
    await user.notSee({ text: "Not connected to a server" });
    await user.notSee({ text: "Failed to load providers" });
    await user.notSee({ text: "Loading providers..." });
    const synced = await probe.eventually(async () => {
      const result = await probe.desktopApi("/opencode/provider");
      return { status: result.status, connected: connectedProviderIds(result.body) };
    }, {
      within: 60_000,
      label: "the engine holds the organization provider",
      until: (result) => result.status === 200 && result.connected.includes(world.providerId),
    });
    evidence.recordAssertionEvidence(
      "Settings › AI providers shows the organization provider, served by the running engine",
      `"${world.providerName}" is listed with no server error; GET /opencode/provider → HTTP ${synced.status}, organization provider connected: ${synced.connected.includes(world.providerId)}`,
      synced.connected.includes(world.providerId),
    );
    expect(synced.connected).toContain(world.providerId);
    await user.screenshot();
  });

  const joined = await step("creating the first workspace joins the running server and engine instead of restarting them", async () => {
    const before = serverIdentity((await probe.desktopApi("/status")).body);
    await user.click("Back to app");
    await user.see("composer", { editable: true, timeoutMs: 120_000 });
    await probe.eventually(async () => {
      const actions = await agent.actions();
      return Array.isArray(actions)
        && actions.some((action) => isRecord(action) && action.id === "workspace.create" && action.disabled !== true);
    }, { within: 60_000, label: "workspace creation is available", until: (available) => available });
    await agent.run("workspace.create", { path: world.firstWorkspacePath });
    const workspaceIds = await probe.eventually(async () => listField((await probe.desktopApi("/workspaces")).body, "items")
      .flatMap((item) => (isRecord(item) && typeof item.id === "string" ? [item.id] : [])), {
      within: 120_000,
      label: "the first workspace is registered",
      until: (ids) => ids.length === 1,
    });
    const workspaceId = workspaceIds[0] ?? "";
    const after = serverIdentity((await probe.desktopApi("/status")).body);
    const kept = after.port === before.port && after.uptimeMs >= before.uptimeMs;
    evidence.recordAssertionEvidence(
      "The server was not restarted",
      `server port ${before.port} → ${after.port}; uptime ${before.uptimeMs} ms → ${after.uptimeMs} ms; workspace ${workspaceId || "missing"}`,
      kept && Boolean(workspaceId),
    );
    expect(workspaceId).not.toBe("");
    expect(after.port).toBe(before.port);
    expect(after.uptimeMs).toBeGreaterThanOrEqual(before.uptimeMs);
    return { workspaceId };
  });

  await step("after: the new workspace uses the same organization provider without reconnecting", async () => {
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    const providers = await probe.desktopApi(`/workspace/${joined.workspaceId}/opencode/provider`);
    const connected = connectedProviderIds(providers.body);
    evidence.recordAssertionEvidence(
      "The organization provider carries over into the first workspace",
      `GET /workspace/${joined.workspaceId}/opencode/provider → HTTP ${providers.status}; connected: ${connected.join(", ") || "none"}`,
      providers.status === 200 && connected.includes(world.providerId),
    );
    expect(connected).toContain(world.providerId);
    await user.screenshot();
  });
});
