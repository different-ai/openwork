import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createApp } from "./app.js";
import { createAppDependencies } from "./context/app-dependencies.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length) {
    const next = tempRoots.pop();
    if (!next) continue;
    fs.rmSync(next, { force: true, recursive: true });
  }
});

function createTempRoot(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  tempRoots.push(root);
  return root;
}

function createTestApp() {
  const root = createTempRoot("openwork-server-v2-phase7");
  const dependencies = createAppDependencies({
    environment: "test",
    inMemory: true,
    runtime: {
      bootstrapPolicy: "disabled",
    },
    startedAt: new Date("2026-04-14T00:00:00.000Z"),
    version: "0.0.0-test",
    workingDirectory: path.join(root, "server-v2"),
  });

  return {
    app: createApp({ dependencies }),
    dependencies,
    root,
  };
}

test("local workspace creation and config routes use server-owned config directories", async () => {
  const { app, dependencies, root } = createTestApp();
  const workspaceRoot = path.join(root, "workspace-alpha");

  const createResponse = await app.request("http://openwork.local/workspaces/local", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ folderPath: workspaceRoot, name: "Alpha", preset: "starter" }),
  });
  const created = await createResponse.json();
  const workspaceId = created.data.id as string;

  expect(createResponse.status).toBe(200);
  expect(created.data.backend.local.dataDir).toBe(workspaceRoot);
  expect(created.data.backend.local.configDir).toContain(`/workspaces/${workspaceId}/config`);

  const configResponse = await app.request(`http://openwork.local/workspaces/${workspaceId}/config`);
  const configBody = await configResponse.json();
  expect(configResponse.status).toBe(200);
  expect(configBody.data.stored.openwork.authorizedRoots).toContain(workspaceRoot);
  expect(configBody.data.effective.opencode.permission.external_directory).toContain(workspaceRoot);

  const patchResponse = await app.request(`http://openwork.local/workspaces/${workspaceId}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      openwork: { reload: { auto: true } },
      opencode: { permission: { external_directory: [path.join(root, "shared-data")] } },
    }),
  });
  const patched = await patchResponse.json();
  expect(patchResponse.status).toBe(200);
  expect(patched.data.stored.openwork.reload.auto).toBe(true);
  expect(patched.data.effective.opencode.permission.external_directory).toContain(workspaceRoot);
  expect(patched.data.effective.opencode.permission.external_directory).toContain(path.join(root, "shared-data"));

  const rawResponse = await app.request(`http://openwork.local/workspaces/${workspaceId}/config/opencode-raw?scope=project`);
  const rawBody = await rawResponse.json();
  expect(rawResponse.status).toBe(200);
  expect(rawBody.data.content).toContain("external_directory");
  expect(rawBody.data.path).toContain(`/workspaces/${workspaceId}/config/opencode.jsonc`);

  const persistedWorkspace = dependencies.persistence.repositories.workspaces.getById(workspaceId);
  expect(persistedWorkspace?.configDir).toBeTruthy();
  expect(fs.existsSync(path.join(persistedWorkspace!.configDir!, "opencode.jsonc"))).toBe(true);
  expect(fs.existsSync(path.join(workspaceRoot, "opencode.jsonc"))).toBe(true);
});

test("file routes cover simple content, file sessions, inbox, artifacts, and reload events", async () => {
  const { app, root } = createTestApp();
  const workspaceRoot = path.join(root, "workspace-beta");

  const createResponse = await app.request("http://openwork.local/workspaces/local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ folderPath: workspaceRoot, name: "Beta", preset: "starter" }),
  });
  const created = await createResponse.json();
  const workspaceId = created.data.id as string;

  const contentWrite = await app.request(`http://openwork.local/workspaces/${workspaceId}/files/content`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "notes/today.md", content: "hello phase 7" }),
  });
  const contentWriteBody = await contentWrite.json();
  expect(contentWrite.status).toBe(200);
  expect(contentWriteBody.data.path).toBe("notes/today.md");

  const contentRead = await app.request(`http://openwork.local/workspaces/${workspaceId}/files/content?path=notes/today.md`);
  const contentReadBody = await contentRead.json();
  expect(contentRead.status).toBe(200);
  expect(contentReadBody.data.content).toBe("hello phase 7");

  const sessionCreate = await app.request(`http://openwork.local/workspaces/${workspaceId}/file-sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ write: true }),
  });
  const sessionBody = await sessionCreate.json();
  const fileSessionId = sessionBody.data.id as string;
  expect(sessionCreate.status).toBe(200);

  const writeBatch = await app.request(`http://openwork.local/workspaces/${workspaceId}/file-sessions/${fileSessionId}/write-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ writes: [{ path: "docs/readme.txt", contentBase64: Buffer.from("file-session").toString("base64") }] }),
  });
  const writeBatchBody = await writeBatch.json();
  expect(writeBatch.status).toBe(200);

  const staleBatch = await app.request(`http://openwork.local/workspaces/${workspaceId}/file-sessions/${fileSessionId}/write-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      writes: [{
        path: "docs/readme.txt",
        contentBase64: Buffer.from("stale").toString("base64"),
        ifMatchRevision: "1:1",
      }],
    }),
  });
  const staleBatchBody = await staleBatch.json();
  expect(staleBatch.status).toBe(200);
  expect(staleBatchBody.data.items[0].code).toBe("conflict");
  expect(staleBatchBody.data.items[0].currentRevision).toBe(writeBatchBody.data.items[0].revision);

  const readBatch = await app.request(`http://openwork.local/workspaces/${workspaceId}/file-sessions/${fileSessionId}/read-batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: ["docs/readme.txt"] }),
  });
  const readBatchBody = await readBatch.json();
  expect(readBatch.status).toBe(200);
  expect(Buffer.from(readBatchBody.data.items[0].contentBase64, "base64").toString("utf8")).toBe("file-session");

  const ops = await app.request(`http://openwork.local/workspaces/${workspaceId}/file-sessions/${fileSessionId}/operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operations: [{ type: "rename", from: "docs/readme.txt", to: "docs/renamed.txt" }] }),
  });
  expect(ops.status).toBe(200);

  const catalog = await app.request(`http://openwork.local/workspaces/${workspaceId}/file-sessions/${fileSessionId}/catalog/snapshot?prefix=docs`);
  const catalogBody = await catalog.json();
  expect(catalog.status).toBe(200);
  expect(catalogBody.data.items.some((item: any) => item.path === "docs/renamed.txt")).toBe(true);

  const upload = await app.request(`http://openwork.local/workspaces/${workspaceId}/inbox`, {
    method: "POST",
    body: (() => {
      const form = new FormData();
      form.append("file", new File(["hello inbox"], "hello.txt", { type: "text/plain" }));
      return form;
    })(),
  });
  const uploadBody = await upload.json();
  expect(upload.status).toBe(200);
  expect(uploadBody.data.path).toBe("hello.txt");

  const inboxList = await app.request(`http://openwork.local/workspaces/${workspaceId}/inbox`);
  const inboxListBody = await inboxList.json();
  expect(inboxList.status).toBe(200);
  expect(inboxListBody.data.items[0].name).toBe("hello.txt");

  const outboxDir = path.join(workspaceRoot, ".opencode", "openwork", "outbox");
  fs.mkdirSync(outboxDir, { recursive: true });
  fs.writeFileSync(path.join(outboxDir, "artifact.bin"), "artifact", "utf8");

  const artifacts = await app.request(`http://openwork.local/workspaces/${workspaceId}/artifacts`);
  const artifactsBody = await artifacts.json();
  expect(artifacts.status).toBe(200);
  expect(artifactsBody.data.items[0].path).toBe("artifact.bin");

  const reloads = await app.request(`http://openwork.local/workspaces/${workspaceId}/reload-events`);
  const reloadBody = await reloads.json();
  expect(reloads.status).toBe(200);
  expect(reloadBody.data.items.length).toBeGreaterThan(0);
  expect(reloadBody.data.items.some((item: any) => item.reason === "config")).toBe(true);
});

test("reconciliation absorbs recognized managed items from local workspace files", async () => {
  const { dependencies, root } = createTestApp();
  const workspaceRoot = path.join(root, "workspace-gamma");
  fs.mkdirSync(path.join(workspaceRoot, ".opencode", "skills", "manual-skill"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "opencode.jsonc"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    mcp: {
      demo: { type: "local", command: ["demo"] },
    },
    plugin: ["demo-plugin"],
    provider: {
      openai: { options: { apiKey: "redacted" } },
    },
  }, null, 2), "utf8");
  fs.writeFileSync(path.join(workspaceRoot, ".opencode", "skills", "manual-skill", "SKILL.md"), "---\nname: manual-skill\ndescription: Manual skill\n---\n\nhello\n", "utf8");

  const workspace = dependencies.persistence.registry.importLocalWorkspace({
    dataDir: workspaceRoot,
    displayName: "Gamma",
    status: "ready",
  });

  dependencies.services.config.reconcileAllWorkspaces();

  const mcps = dependencies.persistence.repositories.workspaceMcps.listForWorkspace(workspace.id);
  const plugins = dependencies.persistence.repositories.workspacePlugins.listForWorkspace(workspace.id);
  const providers = dependencies.persistence.repositories.workspaceProviderConfigs.listForWorkspace(workspace.id);
  const skills = dependencies.persistence.repositories.workspaceSkills.listForWorkspace(workspace.id);
  const snapshot = dependencies.services.config.getWorkspaceConfigSnapshot(workspace.id);

  expect(mcps).toHaveLength(1);
  expect(plugins).toHaveLength(1);
  expect(providers).toHaveLength(1);
  expect(skills).toHaveLength(1);
  expect(snapshot.stored.opencode.mcp).toBeUndefined();
  expect((snapshot.effective.opencode.mcp as any).demo.type).toBe("local");
  expect(snapshot.effective.opencode.plugin).toContain("demo-plugin");
  expect((snapshot.effective.opencode.provider as any).openai.options.apiKey).toBe("redacted");
});
