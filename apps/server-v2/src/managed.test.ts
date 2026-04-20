import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "./app.js";
import { createAppDependencies } from "./context/app-dependencies.js";

const tempRoots: string[] = [];
const envBackup = {
  home: process.env.HOME,
  publisherBaseUrl: process.env.OPENWORK_PUBLISHER_BASE_URL,
  publisherOrigin: process.env.OPENWORK_PUBLISHER_REQUEST_ORIGIN,
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  while (tempRoots.length) {
    const next = tempRoots.pop();
    if (!next) continue;
    fs.rmSync(next, { force: true, recursive: true });
  }
  process.env.OPENWORK_PUBLISHER_BASE_URL = envBackup.publisherBaseUrl;
  process.env.OPENWORK_PUBLISHER_REQUEST_ORIGIN = envBackup.publisherOrigin;
  process.env.HOME = envBackup.home;
  globalThis.fetch = originalFetch;
});

function createTempRoot(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  tempRoots.push(root);
  return root;
}

function createTestApp(label: string) {
  const root = createTempRoot(label);
  const dependencies = createAppDependencies({
    environment: "test",
    inMemory: true,
    runtime: {
      bootstrapPolicy: "disabled",
    },
    startedAt: new Date("2026-04-15T00:00:00.000Z"),
    version: "0.0.0-test",
    workingDirectory: path.join(root, "server-v2"),
  });
  return {
    app: createApp({ dependencies }),
    dependencies,
    root,
  };
}

test("managed resource routes cover MCPs, plugins, skills, shares, export/import, cloud signin, bundles, and router state", async () => {
  const { app, dependencies, root } = createTestApp("openwork-server-v2-phase8-managed");
  const workspaceRoot = path.join(root, "workspace-managed");
  fs.mkdirSync(path.join(workspaceRoot, ".opencode", "tools"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, ".opencode", "tools", "demo.txt"), "tool-secret", "utf8");

  const createResponse = await app.request("http://openwork.local/workspaces/local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderPath: workspaceRoot, name: "Managed", preset: "starter" }),
  });
  const created = await createResponse.json();
  const workspaceId = created.data.id as string;

  const mcpAdded = await app.request(`http://openwork.local/workspace/${workspaceId}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "demo", config: { command: ["demo"], type: "local" } }),
  });
  const pluginsAdded = await app.request(`http://openwork.local/workspace/${workspaceId}/plugins`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec: "demo-plugin" }),
  });
  const skillAdded = await app.request(`http://openwork.local/workspace/${workspaceId}/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "## When To Use\n- Demo\n", description: "Demo skill", name: "demo-skill" }),
  });
  const systemManagedMcps = await app.request("http://openwork.local/system/managed/mcps");
  const shareExposed = await app.request(`http://openwork.local/workspaces/${workspaceId}/share`, { method: "POST" });
  const shareBody = await shareExposed.json();
  const exportConflict = await app.request(`http://openwork.local/workspaces/${workspaceId}/export?sensitive=auto`);
  const exportSafe = await app.request(`http://openwork.local/workspaces/${workspaceId}/export?sensitive=exclude`);
  const exportSafeBody = await exportSafe.json();

  expect(mcpAdded.status).toBe(200);
  expect((await mcpAdded.json()).items[0].name).toBe("demo");
  expect(pluginsAdded.status).toBe(200);
  expect((await pluginsAdded.json()).items[0].spec).toBe("demo-plugin");
  expect(skillAdded.status).toBe(200);
  expect((await skillAdded.json()).name).toBe("demo-skill");
  expect(systemManagedMcps.status).toBe(200);
  expect((await systemManagedMcps.json()).data.items[0].workspaceIds).toContain(workspaceId);
  expect(shareExposed.status).toBe(200);
  expect(shareBody.data.status).toBe("active");
  expect(typeof shareBody.data.accessKey).toBe("string");
  expect(exportConflict.status).toBe(409);
  expect((await exportConflict.json()).code).toBe("workspace_export_requires_decision");
  expect(exportSafe.status).toBe(200);
  expect(exportSafeBody.data.skills[0].name).toBe("demo-skill");

  const importRoot = path.join(root, "workspace-imported");
  const createImportWorkspace = await app.request("http://openwork.local/workspaces/local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderPath: importRoot, name: "Imported", preset: "starter" }),
  });
  const importedWorkspaceId = (await createImportWorkspace.json()).data.id as string;
  const importResult = await app.request(`http://openwork.local/workspaces/${importedWorkspaceId}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(exportSafeBody.data),
  });
  const importedSkills = await app.request(`http://openwork.local/workspace/${importedWorkspaceId}/skills`);
  expect(importResult.status).toBe(200);
  expect((await importedSkills.json()).items[0].name).toBe("demo-skill");
  const importedSkillRecord = dependencies.persistence.repositories.skills.list().find((item) => item.key === "demo-skill" && item.source === "imported");
  expect(importedSkillRecord?.source).toBe("imported");
  expect((importedSkillRecord?.metadata as any)?.importedVia).toBe("portable_bundle");

  globalThis.fetch = Object.assign(
    async (input: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/skills/hub-skill/SKILL.md")) {
        return new Response("---\nname: hub-skill\ndescription: Hub skill\ntrigger: Help with hub flows\n---\n\nUse for hub tasks\n", {
          headers: { "Content-Type": "text/plain" },
          status: 200,
        });
      }
      return originalFetch(input, init);
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  const hubInstall = await app.request(`http://openwork.local/workspace/${workspaceId}/skills/hub/hub-skill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overwrite: true }),
  });
  expect(hubInstall.status).toBe(200);
  const hubSkillRecord = dependencies.persistence.repositories.skills.list().find((item) => item.key === "hub-skill");
  expect(hubSkillRecord?.source).toBe("imported");
  expect((hubSkillRecord?.metadata as any)?.install?.kind).toBe("hub");
  globalThis.fetch = originalFetch;

  const cloudServer = Bun.serve({
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/me") {
        return Response.json({ user: { id: "usr_123" } });
      }
      return new Response("not found", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  tempRoots.push(path.join(root, `cloud-server-${cloudServer.port}`));
  try {
    const cloudPersist = await app.request("http://openwork.local/system/cloud-signin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { authToken: "token-demo" }, cloudBaseUrl: `http://127.0.0.1:${cloudServer.port}` }),
    });
    const cloudValidated = await app.request("http://openwork.local/system/cloud-signin/validate", { method: "POST" });
    const cloudCleared = await app.request("http://openwork.local/system/cloud-signin", { method: "DELETE" });
    expect(cloudPersist.status).toBe(200);
    expect(cloudValidated.status).toBe(200);
    expect((await cloudValidated.json()).data.ok).toBe(true);
    expect(cloudCleared.status).toBe(200);
    expect((await cloudCleared.json()).data).toBeNull();
  } finally {
    cloudServer.stop(true);
  }

  const publisherServer = Bun.serve({
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/bundles" && request.method === "POST") {
        return Response.json({ url: `${url.origin}/b/demo-bundle` });
      }
      if (url.pathname === "/b/demo-bundle/data" && request.method === "GET") {
        return Response.json({ schemaVersion: 1, type: "skills-set", name: "Demo", skills: [] });
      }
      return new Response("not found", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  process.env.OPENWORK_PUBLISHER_BASE_URL = `http://127.0.0.1:${publisherServer.port}`;
  process.env.OPENWORK_PUBLISHER_REQUEST_ORIGIN = "http://127.0.0.1:3000";
  try {
    const publish = await app.request("http://openwork.local/share/bundles/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleType: "skills-set", payload: { ok: true } }),
    });
    const publishBody = await publish.json();
    const fetchBundle = await app.request("http://openwork.local/share/bundles/fetch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bundleUrl: publishBody.data.url }),
    });
    expect(publish.status).toBe(200);
    expect(fetchBundle.status).toBe(200);
    expect((await fetchBundle.json()).data.type).toBe("skills-set");
  } finally {
    publisherServer.stop(true);
  }

  const routerSendServer = Bun.serve({
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/send" && request.method === "POST") {
        return Response.json({ attempted: 1, channel: "telegram", directory: workspaceRoot, ok: true, sent: 1 });
      }
      return new Response("not found", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    dependencies.services.runtime.getRouterHealth = () => ({
      baseUrl: `http://127.0.0.1:${routerSendServer.port}`,
      binaryPath: null,
      diagnostics: { combined: [], stderr: [], stdout: [], totalLines: 0, truncated: false },
      enablement: { enabled: true, enabledBindingCount: 0, enabledIdentityCount: 0, forced: false, reason: "test" },
      healthUrl: `http://127.0.0.1:${routerSendServer.port}`,
      lastError: null,
      lastExit: null,
      lastReadyAt: null,
      lastStartedAt: null,
      manifest: null,
      materialization: null,
      pid: null,
      running: true,
      source: "development",
      status: "running",
      version: "test",
    });
    dependencies.services.runtime.applyRouterConfig = async () => dependencies.services.runtime.getRouterHealth();
    const telegramIdentity = await app.request(`http://openwork.local/workspace/${workspaceId}/opencode-router/identities/telegram`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access: "private", token: "123456:demo" }),
    });
    const bindings = await app.request(`http://openwork.local/workspace/${workspaceId}/opencode-router/bindings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "telegram", directory: workspaceRoot, peerId: "peer-1" }),
    });
    const send = await app.request(`http://openwork.local/workspace/${workspaceId}/opencode-router/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel: "telegram", directory: workspaceRoot, text: "hello" }),
    });
    expect(telegramIdentity.status).toBe(200);
    expect((await telegramIdentity.json()).telegram.pairingCode).toBeTruthy();
    expect(bindings.status).toBe(200);
    expect(send.status).toBe(200);
    expect((await send.json()).sent).toBe(1);
  } finally {
    routerSendServer.stop(true);
  }
});

test("scheduler routes list and delete jobs for a local workspace", async () => {
  const root = createTempRoot("openwork-server-v2-scheduler");
  process.env.HOME = root;
  const { app } = createTestApp("openwork-server-v2-phase8-scheduler");
  const workspaceRoot = path.join(root, "workspace-scheduler");
  const jobsDir = path.join(root, ".config", "opencode", "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.writeFileSync(
    path.join(jobsDir, "nightly-review.json"),
    JSON.stringify({
      createdAt: new Date("2026-04-16T00:00:00.000Z").toISOString(),
      name: "Nightly Review",
      schedule: "0 9 * * *",
      slug: "nightly-review",
      workdir: workspaceRoot,
    }, null, 2),
    "utf8",
  );

  const createResponse = await app.request("http://openwork.local/workspaces/local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderPath: workspaceRoot, name: "Scheduler", preset: "starter" }),
  });
  const workspaceId = (await createResponse.json()).data.id as string;

  const listResponse = await app.request(`http://openwork.local/workspaces/${workspaceId}/scheduler/jobs`);
  expect(listResponse.status).toBe(200);
  expect((await listResponse.json()).data.items[0].slug).toBe("nightly-review");

  const deleteResponse = await app.request(`http://openwork.local/workspaces/${workspaceId}/scheduler/jobs/nightly-review`, {
    method: "DELETE",
  });
  expect(deleteResponse.status).toBe(200);
  expect((await deleteResponse.json()).data.job.slug).toBe("nightly-review");
  expect(fs.existsSync(path.join(jobsDir, "nightly-review.json"))).toBe(false);
});
