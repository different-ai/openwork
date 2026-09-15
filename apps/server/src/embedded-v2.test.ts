import { expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeV2Catalog } from "@openwork/headless-threads/v2";

// Import server modules only inside a process whose entire profile is owned by
// this test. Path providers may cache HOME/XDG values at module initialization.
if (!process.env.OPENWORK_EMBEDDED_V2_TEST_ROOT) {
  const nativeBinary = process.env.OPENWORK_TEST_NATIVE_V2_BIN;
  test("embedded v2 isolated process", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-embedded-v2-"));
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(OPENWORK_|OPENCODE_|COWORKER_|SENTRY_|XDG_|HOME$)/.test(key)));
      const child = Bun.spawn([process.execPath, "--conditions=development", "test", fileURLToPath(import.meta.url),
        fileURLToPath(new URL("./engine-v2-preview.test.ts", import.meta.url)),
        ...(nativeBinary ? [fileURLToPath(new URL("./embedded-v2-native.test.ts", import.meta.url))] : [])], {
        env: { ...env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
          XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENWORK_DEV_MODE: "1",
          OPENWORK_EMBEDDED_V2_TEST_ROOT: root, ...(nativeBinary ? { OPENWORK_TEST_NATIVE_V2_BIN: nativeBinary } : {}) },
        stdout: "pipe", stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), nativeBinary ? 110_000 : 40_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
        console.info(stderr.trim());
        expect(code).toBe(0);
      } finally { clearTimeout(timeout); child.kill(); await child.exited; }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, nativeBinary ? 115_000 : 45_000);
} else {
  const { startEmbeddedServer } = await import("./embedded.js");
  const managedModule = await import("./managed-opencode-v2.js");
  const v1Module = await import("./managed-opencode.js");
  const { writeRuntimeOpencodeConfig, writeGlobalRuntimeOpencodeConfig } = await import("./runtime-opencode-config-store.js");
  const { engineV2ByConfig } = await import("./engine-v2-preview.js");
  const { default: constants } = await import("../../../constants.json", { with: { type: "json" } });
  const { default: nativeRuntime } = await import("../../coworker/native-runtime.json", { with: { type: "json" } });
  const { createNativeV2Client, createHeadlessThreadClientV2, nativeCatalogProviders } = await import("@openwork/headless-threads/v2");
  const { createCoworkerThreads } = await import(new URL("../../coworker/src/lib/threads.ts", import.meta.url).href);
  const { resolveWorkerModel } = await import(new URL("../../coworker/electron/workers.mjs", import.meta.url).href);

  async function fixture(version?: string) {
    const root = await mkdtemp(join(process.env.OPENWORK_EMBEDDED_V2_TEST_ROOT!, "case-"));
    const bin = join(root, "opencode2");
    const log = join(root, "requests.jsonl");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(bin, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const log = (value) => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(value) + "\\n");
const config = () => JSON.parse(readFileSync(join(process.env.OPENCODE_CONFIG_DIR, "opencode.json"), "utf8"));
log({ spawn: true, args: process.argv.slice(2), serverUrl: process.env.OPENWORK_SERVER_URL,
  bridge: process.env.NATIVE_BRIDGE, secret: process.env.OPENWORK_ENCRYPTION_KEY ?? null });
const mcps = new Map();
const cleanup = process.env.FIXTURE_CLEANUP_STATE ? JSON.parse(readFileSync(process.env.FIXTURE_CLEANUP_STATE, "utf8")) : {};
const sessions = new Map(Object.entries(cleanup.sessions ?? {}));
const inboxes = new Map(Object.entries(cleanup.inboxes ?? {}));
const active = new Set(cleanup.active ?? []);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  log({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
  if (request.headers.get("authorization") !== "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_PASSWORD).toString("base64")) return new Response(null, { status: 401 });
  if (url.pathname === "/api/health") return Response.json({ healthy: true, pid: process.pid, version: process.env.FIXTURE_VERSION });
  if (url.pathname === "/api/plugin/await-activation") return new Response(null, { status: 204 });
  if (url.pathname === "/api/plugin") return Response.json({ data: [] });
  if (url.pathname === "/api/provider" || url.pathname.startsWith("/api/provider/")) {
    const providers = Object.entries(config().providers).map(([id, value]) => ({ id, activation: "enabled", ...value }));
    return Response.json({ data: url.pathname === "/api/provider" ? providers : providers.find((value) => value.id === decodeURIComponent(url.pathname.slice("/api/provider/".length))) });
  }
  if (url.pathname === "/api/model" || url.pathname === "/api/model/default") {
    const models = Object.entries(config().providers).flatMap(([providerID, value]) => Object.entries(value.models ?? {}).map(([id, model]) => ({
      id, modelID: model.modelID ?? id, providerID, name: model.name ?? id,
      capabilities: model.capabilities ?? { tools: true, input: ["text"], output: ["text"] },
      variants: model.variants ?? [], time: { released: 0 }, cost: model.cost ?? [], status: "active", enabled: model.disabled !== true,
      limit: model.limit ?? { context: 128000, output: 8192 }, settings: model.settings, headers: model.headers,
    })));
    const preferred = config().model;
    return Response.json({ data: url.pathname === "/api/model" ? models : models.find((model) => model.providerID === preferred?.providerID && model.id === preferred?.model) ?? null });
  }
  if (url.pathname === "/api/integration") return Response.json({ data: [{ id: "fixture-integration", connections: [{ type: "env", name: "FIXTURE_CONNECTED" }] }] });
  if (url.pathname === "/api/mcp") return Response.json({ data: [...mcps.keys()].map((name) => ({ name, status: { status: "connected" } })) });
  if (url.pathname.startsWith("/api/mcp/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/mcp/".length));
    if (request.method === "PUT") mcps.set(name, await request.json());
    else if (request.method === "DELETE") mcps.delete(name);
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/api/skill") return Response.json(process.env.FIXTURE_SKILLS ? JSON.parse(readFileSync(process.env.FIXTURE_SKILLS, "utf8")) : { data: [] });
  if (url.pathname === "/api/session" && request.method === "POST") {
    const data = await request.json(); sessions.set(data.id, data); return Response.json({ data });
  }
  if (url.pathname === "/api/session/active") return Response.json({ data: Object.fromEntries([...active].map((id) => [id, { type: "running" }])) });
  const session = url.pathname.match(/^\\/api\\/session\\/([^/]+)$/);
  if (session) return sessions.has(session[1]) ? Response.json({ data: sessions.get(session[1]) }, { headers: { "set-cookie": "native-fixture=private", "x-native-private": "fixture" } }) : new Response(null, { status: 404 });
  const operation = url.pathname.match(/^\\/api\\/session\\/([^/]+)\\/(inbox|message|interrupt|wait)(?:\\/([^/]+))?$/);
  if (operation && sessions.has(operation[1])) {
    const [, id, action, messageId] = operation;
    const inbox = inboxes.get(id) ?? [];
    if (action === "inbox" && request.method === "GET") return Response.json({ data: inbox });
    if (action === "inbox" && request.method === "DELETE") {
      inboxes.set(id, inbox.filter((item) => item.id !== messageId));
      return new Response(null, { status: 204 });
    }
    if (action === "message") {
      if (id === cleanup.redirectSessionId) return Response.redirect(url.origin + "/api/provider", 302);
      return Response.json({ data: cleanup.history ?? [], cursor: { previous: null, next: null } });
    }
    if (action === "interrupt" && request.method === "POST" && url.searchParams.get("continue") === "false") {
      const interrupted = active.delete(id);
      const current = sessions.get(id);
      sessions.set(id, { ...current, outcome: "interrupted", time: { ...current.time, idle: Date.now() } });
      return Response.json({ interrupted });
    }
    if (action === "wait" && request.method === "POST") return new Response(null, { status: active.has(id) ? 409 : 204 });
  }
  if (url.pathname.includes("/instructions/entries/") && request.method === "PUT") { log({ instruction: await request.json() }); return new Response(null, { status: 204 }); }
  if (url.pathname.endsWith("/prompt") && request.method === "POST") { const data = await request.json(); log({ prompt: data }); return Response.json({ data }); }
  return Response.json({ error: "unexpected route" }, { status: 404 });
} });
console.log("server listening on http://127.0.0.1:" + server.port);
process.on("SIGTERM", () => { log({ stopped: true }); server.stop(true); process.exit(0); });
`);
    await chmod(bin, 0o755);
    return { root, log, options: {
      engine: "v2" as const, opencodeV2Bin: bin, manageOpencode: true,
      configPath: join(root, "server.json"), workspaces: [workspace], host: "127.0.0.1", port: 0,
      token: "fixture-client", hostToken: "fixture-host", logRequests: false,
      opencodeV2: { version, rootDir: join(root, "engine"), bootTimeoutMs: 2_000,
        config: { agents: { coworker: { sources: ["tools", "skills"] } }, plugins: ["file:///fixture/native-plugin.mjs"] },
        env: { FIXTURE_LOG: log, FIXTURE_VERSION: version ?? constants.opencodeV2Version,
          OPENCODE_MODELS_URL: "http://127.0.0.1:1/unused", NATIVE_BRIDGE: "owned-bridge" } },
    } };
  }

  async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 5_000;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error("Fixture observation timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  test("explicit host pin controls native health and metadata without changing Desktop's default", async () => {
    expect(constants.opencodeV2Version).toBe("0.0.0-beta-19086");
    expect(nativeRuntime.opencodeV2Version).toBe("0.0.0-beta-19271");
    for (const version of [undefined, nativeRuntime.opencodeV2Version]) {
      const item = await fixture(version);
      const handle = await startEmbeddedServer(item.options);
      try {
        expect(handle.config.opencodeV2?.version).toBe(version);
        const headers = { authorization: `Bearer ${handle.config.token}` };
        for (const route of ["/health", "/capabilities"]) {
          const response = await fetch(handle.url + route, { headers });
          expect(response.status).toBe(200);
          expect((await response.json()).opencodeVersion).toBe(version ?? constants.opencodeV2Version);
        }
        const id = handle.config.workspaces[0]!.id;
        const response = await fetch(`${handle.url}/workspace/${id}/mcp/openwork-cloud/health?probe=false`, { headers });
        expect(response.status).toBe(200);
        expect((await response.json()).compatibility.opencode.expectedVersion).toBe(version ?? constants.opencodeV2Version);
      } finally { await handle.stop(); }
    }
    const item = await fixture(nativeRuntime.opencodeV2Version);
    await expect(startEmbeddedServer({ ...item.options, opencodeV2: { ...item.options.opencodeV2,
      env: { ...item.options.opencodeV2.env, FIXTURE_VERSION: constants.opencodeV2Version } } })).rejects.toThrow("version mismatch");
    await expect(startEmbeddedServer({ ...item.options, opencodeV2: { ...item.options.opencodeV2,
      version: "latest" } })).rejects.toThrow("No verified OpenCode v2 artifacts");
  }, 15_000);

  test("workspace proxy preserves native catalog eligibility and exposes only public provider metadata", async () => {
    const item = await fixture(nativeRuntime.opencodeV2Version);
    const packageName = "@opencode-ai/ai/providers/openai-compatible";
    const provider = {
      name: "Fixture", activation: "enabled", package: packageName,
      settings: { baseURL: "http://fixture-user:fixture-password@127.0.0.1:12345/private-path?key=fixture-query#fixture-fragment",
        apiKey: "fixture-api-key", headers: { Authorization: "Bearer fixture-settings-header" }, nested: { secret: "fixture-nested-secret" } },
      headers: { Authorization: "Bearer fixture-provider-header" }, credentialScopes: ["fixture-private-scope"],
      models: { text: { name: "Fixture text", settings: { apiKey: "fixture-model-key" },
        variants: [{ id: "low", settings: { apiKey: "fixture-variant-key" } }] } },
    };
    const handle = await startEmbeddedServer({ ...item.options, opencodeV2: { ...item.options.opencodeV2,
      config: { ...item.options.opencodeV2.config, model: { providerID: "ipr_catalog", model: "opaque-luna" }, providers: {
        fixture: provider,
        integrated: { ...provider, activation: "auto", integrationID: "fixture-integration", settings: { baseURL: "https://fixture-user:fixture-password@example.test/private?key=fixture-query#fixture-fragment" } },
        disabled: { ...provider, activation: "disabled", integrationID: "fixture-integration", settings: { baseURL: "file:///fixture-private-file" } },
        disconnected: { ...provider, activation: "auto", settings: { baseURL: "not a URL fixture-private-value" }, models: { "opaque-astra": provider.models.text } },
      } } } });
    try {
      const id = handle.config.workspaces[0]!.id;
      const mount = `${handle.url}/workspace/${id}/opencode2/api`;
      const headers = { authorization: `Bearer ${handle.config.token}` };
      const response = await fetch(mount + "/provider", { headers });
      expect(response.status).toBe(200);
      const publicProviders: NativeV2Catalog["providers"] = [
        { id: "fixture", name: "Fixture", activation: "enabled", package: packageName, settings: { baseURL: "http://127.0.0.1:12345" } },
        { id: "integrated", name: "Fixture", activation: "auto", package: packageName, integrationID: "fixture-integration", settings: { baseURL: "https://example.test" } },
        { id: "disabled", name: "Fixture", activation: "disabled", package: packageName, integrationID: "fixture-integration" },
        { id: "disconnected", name: "Fixture", activation: "auto", package: packageName },
      ];
      // Exact wire assertions catch leakage even if the client's Zod parser strips it.
      expect(await response.json()).toEqual({ data: publicProviders });
      expect(await (await fetch(mount + "/provider/fixture", { headers })).json()).toEqual({ data: publicProviders[0] });
      const client = createNativeV2Client({ baseUrl: handle.url, workspaceId: id, token: handle.config.token });
      const catalog = await client.readCatalog();
      expect(catalog.providers).toEqual(publicProviders);
      expect(catalog.connectedProviderIds).toEqual(["fixture", "integrated"]);
      expect(catalog.models).toHaveLength(4);
      const projected = nativeCatalogProviders(catalog);
      expect(projected.map((entry) => entry.id)).toEqual(["fixture", "integrated"]);
      expect(projected[0]?.options).toEqual({ baseURL: "http://127.0.0.1:12345" });
      expect(projected[0]?.models.text).toMatchObject({ name: "Fixture text", api: { npm: packageName, id: "text" }, variants: { low: {} } });
      const models = await (await fetch(mount + "/model", { headers })).text();
      expect(models).not.toContain("fixture-model-key");
      expect(models).not.toContain("fixture-variant-key");
      const identity = { upstreamModelId: "gpt-6-astra", modelGroupId: "gmg_fixture", credentialSetId: "gcs_fixture" };
      const sourceModel = {
        id: "opaque-astra", name: "Team thinking", ...identity,
        reasoning: true, release_date: "2026-06-01", cost: { input: 2, output: 8, cache_read: 0.5, tiers: [{ input: 4, output: 12, tier: { type: "context", size: 272000 } }], context_over_200k: { input: 4, output: 12 }, private: "fixture-price-secret" },
        variants: { medium: { reasoningEffort: "medium", customOption: "retained", apiKey: "fixture-variant-key" }, high: { disabled: true } },
        options: { apiKey: "fixture-model-key" }, headers: { Authorization: "fixture-model-header" },
      };
      await writeGlobalRuntimeOpencodeConfig(handle.config, (current) => ({ ...current, provider: {
        ipr_catalog: { name: "Connected catalog", npm: "@ai-sdk/openai", options: { apiKey: "fixture-catalog-key" }, models: {
          "opaque-astra": sourceModel,
          "opaque-luna": { ...sourceModel, id: "opaque-luna", name: "Team chat", upstreamModelId: "gpt-5.6-luna", variants: {} },
          unknown: { name: "Unknown cost", cost: { input: -1, output: 0 }, release_date: "2026-02-30", reasoning_options: [{ type: "effort", values: ["medium"] }], upstreamModelId: "invalid\nidentity", credentialSetId: { secret: "fixture-identity-secret" } },
          zero: { name: "Known zero", cost: { input: 0, output: 0 } },
          retired: { ...sourceModel, id: "retired", status: "deprecated" },
        } },
        ipr_missing: { npm: "@ai-sdk/openai", env: ["MISSING_CATALOG_KEY"], models: { "opaque-astra": sourceModel } },
      } }));
      await engineV2ByConfig.get(handle.config)!.refresh();
      const nativeConfig = JSON.parse(await readFile(join(item.options.opencodeV2.rootDir, "config/opencode.json"), "utf8"));
      const nativeModels = nativeConfig.providers.ipr_catalog.models;
      expect(nativeModels["opaque-astra"]).toMatchObject({ modelID: "opaque-astra", cost: [{ input: 2, output: 8, cache: { read: 0.5 } }, { input: 4, output: 12, tier: { type: "context", size: 272000 } }],
        variants: [{ id: "medium", settings: { providerOptions: { reasoningEffort: "medium", customOption: "retained", apiKey: "fixture-variant-key" } } }] });
      for (const key of ["upstreamModelId", "modelGroupId", "credentialSetId", "release_date", "time"]) expect(nativeModels["opaque-astra"]).not.toHaveProperty(key);
      expect(nativeModels.unknown.cost).toEqual([]);
      expect(nativeModels.unknown.variants).toBeUndefined();
      expect(nativeConfig.providers).not.toHaveProperty("ipr_missing");
      const rawModels = await (await fetch(mount + "/model", { headers })).json();
      expect(rawModels.data.find((model: { id: string; providerID: string }) => model.providerID === "ipr_catalog" && model.id === "opaque-astra"))
        .toMatchObject({ ...identity, id: "opaque-astra", modelID: "opaque-astra", variants: [{ id: "medium" }], time: { released: Date.parse("2026-06-01") } });
      const preferred = await client.defaultModel();
      expect(preferred).toMatchObject({ id: "opaque-luna", modelID: "opaque-luna", providerID: "ipr_catalog", upstreamModelId: "gpt-5.6-luna" });
      const bridged = await client.readCatalog();
      expect(bridged.connectedProviderIds).toEqual(["fixture", "integrated", "ipr_catalog"]);
      expect(bridged.models.find((model) => model.id === "retired")?.enabled).toBe(false);
      const workerProviders = nativeCatalogProviders(bridged);
      const rendererHost = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/cloud-provider-sync/status") return Response.json({ hasSession: true, providers: [], skippedProviders: [], lastRun: null, reloadPending: false });
        return fetch(handle.url + path, { headers: request.headers });
      } });
      let renderer: { models: Array<{ modelId: string; providerId: string; knownPrice: boolean }> };
      try {
        const threads = createCoworkerThreads({ serverUrl: `http://127.0.0.1:${rendererHost.port}`, workspaceId: id, token: handle.config.token });
        renderer = await threads.listModelCatalog();
      } finally { rendererHost.stop(true); }
      expect(renderer.models.find((model) => model.modelId === "opaque-astra")).toMatchObject({ ...identity, providerId: "ipr_catalog", variants: ["medium"], knownPrice: true, cost: { input: 2, output: 8 } });
      expect(renderer.models.find((model) => model.modelId === "unknown")?.knownPrice).toBe(false);
      expect(renderer.models.find((model) => model.modelId === "zero")).toMatchObject({ knownPrice: true, cost: { input: 0, output: 0 } });
      expect(bridged.models.find((model) => model.id === "unknown")?.time.released).toBe(0);
      expect(renderer.models.some((model) => model.modelId === "retired" || model.providerId === "ipr_missing")).toBe(false);
      expect(resolveWorkerModel({ thinkingModel: "ipr_catalog/opaque-astra", thinkingModelVariant: "medium" }, "thinking", workerProviders))
        .toEqual({ providerId: "ipr_catalog", modelId: "opaque-astra", variant: "medium" });
      expect(workerProviders.find((provider) => provider.id === "ipr_catalog")?.models["opaque-astra"]).toMatchObject(identity);
      expect(resolveWorkerModel({}, "thinking", workerProviders)).toEqual({ providerId: "ipr_catalog", modelId: "opaque-astra", variant: "medium" });
      expect(resolveWorkerModel({}, "delivery", workerProviders)).toEqual({ providerId: "ipr_catalog", modelId: "opaque-luna", variant: "" });
      for (const secret of ["fixture-catalog-key", "fixture-model-key", "fixture-model-header", "fixture-variant-key", "fixture-price-secret", "fixture-identity-secret"]) {
        expect(JSON.stringify([rawModels, preferred, workerProviders, renderer])).not.toContain(secret);
      }
      expect(rawModels.data.filter((model: { providerID: string }) => model.providerID !== "ipr_catalog").every((model: Record<string, unknown>) => model.upstreamModelId === undefined)).toBe(true);
      // An independently configured same-ID provider is restored when its
      // managed override disappears; mandatory readiness must accept it.
      const providerPatch = (value: unknown) => fetch(handle.url + "/runtime-config/providers", { method: "PATCH",
        headers: { ...headers, "content-type": "application/json", "x-openwork-host-token": item.options.hostToken },
        body: JSON.stringify({ provider: { fixture: value } }) });
      expect((await providerPatch({ npm: "@ai-sdk/openai", options: { apiKey: "managed-override" }, models: {} })).status).toBe(200);
      expect((await providerPatch(null)).status).toBe(200);
      expect((await fetch(mount + "/provider", { headers })).status).toBe(200);
      expect(JSON.parse(await readFile(join(item.options.opencodeV2.rootDir, "config/opencode.json"), "utf8")).providers.fixture.settings.apiKey).toBe("fixture-api-key");
    } finally { await handle.stop(); }
  }, 10_000);

  test("Desktop optional preview preserves native skill sync, shared catalog projection and host configuration", async () => {
    const item = await fixture();
    const marker = join(item.options.opencodeV2.rootDir, "cloud-skills", "marker");
    await mkdir(join(marker, ".."), { recursive: true });
    await writeFile(marker, "preview-owned-marker");
    const skillCatalog = { data: [{ id: "preview-skill", name: "Preview skill", description: "Preview", content: "Preview instructions",
      location: join(item.root, "plugin", "SKILL.md") }], previewField: "preserved" };
    const catalogFile = join(item.root, "skills.json");
    await writeFile(catalogFile, JSON.stringify(skillCatalog));
    let cloudReads = 0;
    const cloud = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { cloudReads++; return new Response(null, { status: 401 }); } });
    process.env.OPENWORK_ENGINE_V2_PREVIEW = "chat";
    let handle: Awaited<ReturnType<typeof startEmbeddedServer>> | undefined;
    try {
      handle = await startEmbeddedServer({ ...item.options, engine: "v1", manageOpencode: false, opencodeV2: { ...item.options.opencodeV2,
        config: { providers: { preview: { name: "Preview" } }, skills: [join(item.root, "not-preview-managed")] },
        env: { ...item.options.opencodeV2.env, FIXTURE_SKILLS: catalogFile } } });
      const engine = engineV2ByConfig.get(handle.config)!;
      await waitFor(async () => engine.status().running);
      await expect(handle.nativeCleanupRequest({ workspaceId: handle.config.workspaces[0]!.id, directory: item.options.workspaces[0]!,
        method: "GET", path: "/api/session/active" })).rejects.toThrow("existing v2 engine");
      await writeGlobalRuntimeOpencodeConfig(handle.config, (current) => ({ ...current, mcp: { "openwork-cloud": {
        type: "remote", url: `http://127.0.0.1:${cloud.port}/mcp`, headers: { Authorization: "Bearer preview-fixture" },
      } } }));
      const mount = `${handle.url}/workspace/${handle.config.workspaces[0]!.id}/opencode2/api`;
      const headers = { authorization: `Bearer ${handle.config.token}`, "content-type": "application/json" };
      expect(await engine.request(handle.config.workspaces[0]!.path, "/api/skill")).toEqual({ status: 200, json: skillCatalog });
      expect(await (await fetch(mount + "/skill", { headers })).json()).toEqual({ data: skillCatalog.data });
      expect(await (await fetch(mount + "/provider", { headers })).json()).toEqual({ data: [{ id: "preview", name: "Preview" }] });
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await mkdir(join(marker, ".."), { recursive: true });
      await writeFile(marker, "preview-owned-marker");
      const sid = "ses_preview";
      await fetch(mount + "/session", { method: "POST", headers, body: JSON.stringify({ id: sid }) });
      const prompt = { id: "msg_preview", text: "Preview", skills: [{ id: "openwork-cloud-old", text: "Preview contract retained" }] };
      const response = await fetch(mount + `/session/${sid}/prompt`, { method: "POST", headers: { ...headers, "x-openwork-native-skills-scope": "preview-ignored" }, body: JSON.stringify(prompt) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: prompt });
      const previewLog = await readFile(item.log, "utf8");
      expect(previewLog.trim().split("\n").map((line) => JSON.parse(line)).some((entry) => entry.path?.endsWith("/permission"))).toBe(false);
      expect(previewLog).toContain("Authorized organization skills are in the native skill catalog, not in Connect.");
      expect(previewLog).toContain("OpenWork Connect tools are connected.");
      expect(JSON.parse(await readFile(join(item.options.opencodeV2.rootDir, "config/opencode.json"), "utf8")).skills).toEqual([join(item.root, "not-preview-managed")]);
      expect(cloudReads).toBe(1);
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await handle.stop();
      await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
      await handle?.stop();
      cloud.stop(true);
    }
  }, 15_000);

  test("v2 is exclusive, ready on return, hot-updated and stopped once", async () => {
    const item = await fixture();
    const v1 = spyOn(v1Module, "createManagedOpencodeServer");
    process.env.OPENWORK_OPENCODE_BASE_URL = "http://127.0.0.1:1/v1-must-not-be-probed";
    process.env.OPENWORK_OPENCODE_BIN = "/missing/v1-must-not-be-spawned";
    process.env.OPENWORK_OPENCODE2_BIN = "/missing/ambient-v2-must-not-win";
    process.env.OPENWORK_ENGINE_V2_PREVIEW = "sidecar";
    process.env.OPENWORK_ENCRYPTION_KEY = "server-only-fixture-key";
    let stop: (() => Promise<void>) | undefined;
    try {
      const handle = await startEmbeddedServer(item.options);
      stop = handle.stop;
      const headers = { authorization: `Bearer ${handle.config.token}`, "content-type": "application/json" };
      const nativePath = join(item.options.opencodeV2.rootDir, "config/opencode.json");
      const native = async () => JSON.parse(await readFile(nativePath, "utf8"));
      expect(v1).not.toHaveBeenCalled();
      expect(handle.managedOpencode).toBeNull();
      expect(handle.managedOpencodeExecution).toBeNull();
      expect(handle.managedOpencodePool()).toBeNull();
      expect(handle.managedOpencodeV2?.isAlive()).toBe(true);
      expect(handle.managedOpencodeV2?.pid).toBeGreaterThan(0);
      expect(handle.policyToken.length).toBeGreaterThan(10);
      expect(handle.config.opencodeBaseUrl).toBeUndefined();
      const id = handle.config.workspaces[0]!.id;
      for (const path of ["/opencode/provider", `/workspace/${id}/opencode/provider`, `/w/${id}/opencode/provider`]) {
        const response = await fetch(handle.url + path, { headers });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "engine_v1_disabled" });
      }
      for (const body of [{ enabled: false }, { chatRouting: false }]) {
        expect((await fetch(handle.url + "/experimental/engine-v2-preview", { method: "PUT", headers, body: JSON.stringify(body) })).status).toBe(409);
      }
      const mount = `${handle.url}/workspace/${id}/opencode2`;
      expect((await fetch(mount + "/api/model", { headers })).status).toBe(200);
      const session = await fetch(mount + "/api/session", { method: "POST", headers,
        body: JSON.stringify({ location: { directory: "/wrong" }, title: "Isolated" }) });
      expect(await session.json()).toMatchObject({ data: { location: { directory: item.options.workspaces[0] } } });

      const patch = await fetch(handle.url + "/runtime-config/providers", { method: "PATCH",
        headers: { ...headers, "x-openwork-host-token": item.options.hostToken },
        body: JSON.stringify({ provider: { fixture: { npm: "@ai-sdk/openai", options: { apiKey: "synthetic-key" }, models: { fixture: { name: "Fixture" } } } } }) });
      expect(patch.status).toBe(200);
      expect((await native()).providers.fixture.settings.apiKey).toBe("synthetic-key");
      expect((await native()).agents.coworker.sources).toContain("tools");
      expect((await native()).plugins).toEqual(item.options.opencodeV2.config.plugins);
      const hostHeaders = { ...headers, "x-openwork-host-token": item.options.hostToken };
      const setCredential = (value: string) => fetch(handle.url + "/env", { method: "PUT", headers: hostHeaders,
        body: JSON.stringify({ key: "FIXTURE_API_KEY", value }) });
      expect((await setCredential("first-key")).status).toBe(200);
      expect((await fetch(handle.url + "/runtime-config/providers", { method: "PATCH", headers: hostHeaders,
        body: JSON.stringify({ provider: { fixture: { npm: "@ai-sdk/openai", env: ["FIXTURE_API_KEY"], models: {} } } }) })).status).toBe(200);
      expect((await native()).providers.fixture.settings.apiKey).toBe("first-key");
      expect((await setCredential("rotated-key")).status).toBe(200);
      await waitFor(async () => (await native()).providers.fixture.settings.apiKey === "rotated-key");
      expect((await fetch(handle.url + "/env/FIXTURE_API_KEY", { method: "DELETE", headers: hostHeaders })).status).toBe(200);
      await waitFor(async () => !(await native()).providers.fixture);
      expect((await fetch(mount + "/api/provider", { headers })).status).toBe(200);
      await writeRuntimeOpencodeConfig(handle.config, id, (current) => ({ ...current,
        mcp: { fixture: { type: "local", command: ["unused-fixture-command"] } } }));
      await waitFor(async () => (await readFile(item.log, "utf8")).includes('"method":"PUT","path":"/api/mcp/fixture"'));
      await writeRuntimeOpencodeConfig(handle.config, id, (current) => ({ ...current, mcp: {} }));
      await waitFor(async () => (await readFile(item.log, "utf8")).includes('"method":"DELETE","path":"/api/mcp/fixture"'));

      const firstStop = handle.stop();
      expect(handle.stop()).toBe(firstStop);
      await firstStop;
      expect(handle.managedOpencodeV2?.isAlive()).toBe(false);
      await expect(fetch(handle.url + "/health")).rejects.toThrow();
      const log = await readFile(item.log, "utf8");
      expect(log.match(/"spawn":true/g)).toHaveLength(1);
      expect(log.match(/"stopped":true/g)).toHaveLength(1);
      expect(log).toContain(`"serverUrl":"${handle.url}"`);
      expect(log).toContain('"bridge":"owned-bridge","secret":null');
      expect(log).not.toContain("/instance/dispose");
      expect(log).not.toContain("/auth/");
      expect(v1).not.toHaveBeenCalled();
    } finally {
      v1.mockRestore();
      try { await stop?.(); } finally {
        // Setup and shutdown failures must not contaminate later test cases.
        for (const key of ["OPENWORK_OPENCODE_BASE_URL", "OPENWORK_OPENCODE_BIN", "OPENWORK_OPENCODE2_BIN", "OPENWORK_ENGINE_V2_PREVIEW", "OPENWORK_ENCRYPTION_KEY"]) delete process.env[key];
      }
    }
  }, 15_000);

  test("host-only cleanup survives readiness failure without admitting work or crossing native ownership", async () => {
    const item = await fixture();
    const directory = item.options.workspaces[0]!;
    const foreignDirectory = join(item.root, "foreign");
    await mkdir(foreignDirectory);
    const sessionId = "ses_cleanup";
    const messageId = "msg_cleanup_context";
    const session = (id: string, location: string) => ({ id, location: { directory: location }, projectID: "fixture",
      cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } });
    const pending = (id: string, sessionID: string) => ({ id, sessionID, type: "synthetic", delivery: "steer", timeCreated: 2, payload: { text: "Queued cleanup" } });
    const state = join(item.root, "cleanup.json");
    await writeFile(state, JSON.stringify({
      sessions: { [sessionId]: session(sessionId, directory), ses_foreign: session("ses_foreign", foreignDirectory), ses_redirect: session("ses_redirect", directory) },
      inboxes: { [sessionId]: [pending(messageId, sessionId)], ses_foreign: [pending("msg_foreign", "ses_foreign")] },
      active: [sessionId, "ses_foreign"], redirectSessionId: "ses_redirect",
      history: [{ id: "msg_history", type: "system", text: "Retained history", time: { created: 1 } }],
    }));
    const handle = await startEmbeddedServer({ ...item.options, workspaces: [directory, foreignDirectory],
      opencodeV2: { ...item.options.opencodeV2, env: { ...item.options.opencodeV2.env, FIXTURE_CLEANUP_STATE: state } } });
    const engine = engineV2ByConfig.get(handle.config)!;
    const failPreparation = () => { throw new Error("fixture readiness unavailable"); };
    const preparations = [
      spyOn(engine, "ensureWorkspaceReady").mockImplementation(failPreparation),
      spyOn(engine, "syncWorkspaceMcp").mockImplementation(failPreparation),
      spyOn(engine, "withNativeSkills").mockImplementation(failPreparation),
      spyOn(engine, "refresh").mockImplementation(failPreparation),
      spyOn(engine, "start").mockImplementation(failPreparation),
    ];
    const workspaceId = handle.config.workspaces[0]!.id;
    const mount = `/workspace/${workspaceId}/opencode2`;
    const cleanup = (path: string, method = "GET", signal?: AbortSignal) => handle.nativeCleanupRequest({ workspaceId, directory, method, path, signal });
    const requests = async () => (await readFile(item.log, "utf8")).trim().split("\n")
      .map((line): { method?: string; path?: string; query?: Record<string, string>; spawn?: boolean } => JSON.parse(line));
    try {
      expect((await fetch(handle.url + mount + `/api/session/${sessionId}`, { headers: { authorization: `Bearer ${handle.config.token}` } })).status).toBe(200);
      expect(preparations[0]).not.toHaveBeenCalled();
      expect((await fetch(handle.url + mount + `/api/session/${sessionId}/prompt`, { method: "POST", headers: { authorization: `Bearer ${handle.config.token}` } })).status).toBe(500);
      expect(preparations[0]).toHaveBeenCalledTimes(1);
      expect((await fetch(handle.url + mount + `/api/session/${sessionId}/interrupt?continue=false`, { method: "POST" })).status).toBe(401);
      for (const preparation of preparations) preparation.mockClear();
      const baseline = (await requests()).length;
      const clientOptions: Parameters<typeof createNativeV2Client>[0] = { baseUrl: handle.url, workspaceId, token: handle.config.token,
        fetch: (url, init) => { const target = new URL(url); return cleanup(target.pathname.slice(mount.length) + target.search, init?.method ?? "GET", init?.signal ?? undefined); } };
      const native = createNativeV2Client(clientOptions);
      const threads = createHeadlessThreadClientV2(clientOptions);
      const response = await cleanup(`/api/session/${sessionId}`);
      expect(response.status).toBe(200);
      expect([...response.headers.keys()]).toEqual(["content-type"]);
      expect(await native.readActive()).toEqual({ [sessionId]: { type: "running" } });
      expect(await threads.getThreadSnapshot(sessionId)).toMatchObject({ threadId: sessionId, directory,
        status: { type: "busy" }, native: { pendingInputIds: [messageId] } });
      expect(await threads.abortThread(sessionId)).toEqual({ threadId: sessionId, accepted: true });
      expect(await threads.getThreadSnapshot(sessionId)).toMatchObject({ status: { type: "idle" },
        messages: [{ id: "msg_history" }], native: { pendingInputIds: [] } });
      expect(await native.reconcileInput(sessionId, { id: messageId, type: "synthetic", text: "Queued cleanup" })).toEqual({ state: "unobserved", id: messageId });
      const cursor = "opaque&location[directory]=foreign";
      expect((await cleanup(`/api/session/${sessionId}/message?limit=20&cursor=${encodeURIComponent(cursor)}`)).status).toBe(200);
      const beforeRefusals = (await requests()).length;
      for (const [method, path] of [
        ["POST", `/api/session/${sessionId}/prompt`], ["POST", `/api/session/${sessionId}/model`],
        ["PATCH", "/api/config"], ["GET", "/api/provider"], ["DELETE", `/api/session/${sessionId}`],
        ["POST", `/api/session/${sessionId}/interrupt?continue=true`],
        ["GET", `/api/session/${sessionId}/message?limit=201`], ["GET", `/api/session/${sessionId}/message?limit=200&limit=1`],
        ["GET", `/api/session/${sessionId}/message?location%5Bdirectory%5D=foreign`],
        ["GET", "/api/session/active?scope=global"], ["GET", `/api/session/${sessionId}/../active`],
        ["GET", handle.url + `/api/session/${sessionId}`],
      ]) await expect(cleanup(path!, method!)).rejects.toThrow("Only native session cleanup");
      await expect(handle.nativeCleanupRequest({ workspaceId: "unknown", directory, method: "GET", path: `/api/session/${sessionId}` })).rejects.toThrow("workspace");
      await expect(handle.nativeCleanupRequest({ workspaceId, directory: foreignDirectory, method: "POST", path: `/api/session/${sessionId}/wait` })).rejects.toThrow("workspace");
      handle.config.readOnly = true;
      try { await expect(cleanup(`/api/session/${sessionId}/interrupt?continue=false`, "POST")).rejects.toThrow("read-only"); }
      finally { handle.config.readOnly = false; }
      handle.config.engine = "v1";
      try { await expect(cleanup(`/api/session/${sessionId}`)).rejects.toThrow("generation"); }
      finally { handle.config.engine = "v2"; }
      const roots = handle.config.authorizedRoots;
      handle.config.authorizedRoots = [];
      try { await expect(cleanup(`/api/session/${sessionId}`)).rejects.toThrow("workspace"); }
      finally { handle.config.authorizedRoots = roots; }
      await expect(cleanup(`/api/session/${sessionId}`, "GET", AbortSignal.abort(new Error("fixture cancelled")))).rejects.toThrow("cancelled");
      expect((await requests()).length).toBe(beforeRefusals);
      for (const [method, suffix] of [["GET", ""], ["GET", "/message"], ["POST", "/interrupt?continue=false"]]) {
        await expect(cleanup(`/api/session/ses_foreign${suffix}`, method)).rejects.toThrow("not owned");
      }
      await expect(cleanup(`/api/session/${sessionId}/inbox/msg_foreign`, "DELETE")).rejects.toThrow("owned session inbox");
      await expect(cleanup("/api/session/ses_missing")).rejects.toThrow("not accepted");
      await expect(cleanup("/api/session/ses_redirect/message?limit=200&order=asc")).rejects.toThrow();
      const transportModule = await import("./server-fetch.js");
      for (const failure of ["abort", "generation"]) {
        const send = transportModule.loopbackFetch;
        let entered = () => {};
        let release = () => {};
        const reached = new Promise<void>((resolve) => { entered = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const held = spyOn(transportModule, "loopbackFetch").mockImplementation(async (input, init) => {
          const response = await send(input, init);
          entered();
          await gate;
          return response;
        });
        const controller = new AbortController();
        const interrupted = cleanup(`/api/session/${sessionId}/interrupt?continue=false`, "POST", controller.signal);
        try {
          await reached;
          if (failure === "abort") {
            controller.abort(new Error("fixture cancelled"));
            await expect(interrupted).rejects.toThrow("cancelled");
          } else {
            engineV2ByConfig.set(handle.config, { ...engine });
            release();
            await expect(interrupted).rejects.toThrow("generation");
          }
        } finally {
          release();
          engineV2ByConfig.set(handle.config, engine);
          held.mockRestore();
          await interrupted.catch(() => undefined);
        }
      }
      for (const preparation of preparations) expect(preparation).not.toHaveBeenCalled();
      const calls = (await requests()).slice(baseline);
      const canonicalDirectory = await realpath(directory);
      expect(calls.every((call) => call.path?.startsWith("/api/session/") && call.query?.["location[directory]"] === canonicalDirectory)).toBe(true);
      expect(calls.find((call) => call.query?.cursor === cursor)?.query).toEqual({ limit: "20", cursor, "location[directory]": canonicalDirectory });
      expect(calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`)).toEqual([
        `POST /api/session/${sessionId}/interrupt`, `POST /api/session/${sessionId}/wait`, `DELETE /api/session/${sessionId}/inbox/${messageId}`,
      ]);
      const foreign = { workspaceId: handle.config.workspaces[1]!.id, directory: foreignDirectory, method: "GET" };
      expect(await (await handle.nativeCleanupRequest({ ...foreign, path: "/api/session/active" })).json()).toEqual({ data: { ses_foreign: { type: "running" } } });
      expect(await (await handle.nativeCleanupRequest({ ...foreign, path: "/api/session/ses_foreign/inbox" })).json()).toEqual({ data: [pending("msg_foreign", "ses_foreign")] });
      expect((await requests()).filter((entry) => entry.spawn)).toHaveLength(1);
      await handle.stop();
      await expect(cleanup(`/api/session/${sessionId}`)).rejects.toThrow("stopped");
      await expect(engine.createNativeCleanupRequest(() => true, new AbortController().signal)({ workspaceId, directory, method: "GET", path: `/api/session/${sessionId}` })).rejects.toThrow("existing v2 engine");
    } finally {
      for (const preparation of preparations) preparation.mockRestore();
      await handle.stop();
    }
  }, 15_000);

  test("startup failure has no fallback and closes the listener and child", async () => {
    const item = await fixture();
    const serverModule = await import("./serve-node.js");
    const serve = serverModule.serve;
    let port = 0;
    const serverSpy = spyOn(serverModule, "serve").mockImplementation(async (options) => {
      const server = await serve(options); port = server.port; return server;
    });
    try {
      await expect(startEmbeddedServer({ ...item.options, opencodeV2: { ...item.options.opencodeV2,
        env: { ...item.options.opencodeV2.env, FIXTURE_VERSION: "1.18.18" } } })).rejects.toThrow("version mismatch");
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
      expect(await readFile(item.log, "utf8")).toContain('"stopped":true');
      await expect(startEmbeddedServer({ ...item.options, opencodeV2Bin: join(item.root, "missing") })).rejects.toThrow("Failed to start OpenCode v2");
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
      await expect(startEmbeddedServer({ ...item.options, opencodeBin: "/v1" })).rejects.toThrow("cannot attach");
    } finally { serverSpy.mockRestore(); }
  }, 10_000);

  test("child death changes liveness and mandatory cleanup errors reach the host", async () => {
    const item = await fixture();
    const create = managedModule.createManagedOpencodeV2Server;
    const spy = spyOn(managedModule, "createManagedOpencodeV2Server").mockImplementation(async (options) => {
      const managed = await create(options);
      return { ...managed, close: async () => { await managed.close(); throw new Error("fixture cleanup failure"); } };
    });
    const handle = await startEmbeddedServer(item.options);
    try {
      process.kill(handle.managedOpencodeV2!.pid!, "SIGTERM");
      await waitFor(async () => handle.managedOpencodeV2?.isAlive() === false);
      await expect(handle.nativeCleanupRequest({ workspaceId: handle.config.workspaces[0]!.id, directory: item.options.workspaces[0]!,
        method: "GET", path: "/api/session/active" })).rejects.toThrow("generation");
      const status = await fetch(handle.url + "/experimental/engine-v2-preview/status", { headers: { authorization: `Bearer ${handle.config.token}` } });
      expect(await status.json()).toMatchObject({ running: false, enabled: true, chatRouting: true });
      await expect(handle.stop()).rejects.toThrow("fixture cleanup failure");
      await expect(fetch(handle.url + "/health")).rejects.toThrow();
    } finally { spy.mockRestore(); await handle.stop().catch(() => undefined); }
  }, 10_000);
}
