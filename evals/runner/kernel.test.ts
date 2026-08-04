import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Server } from "node:http";

import { parseArgs, resolveHostPlacement } from "./cli.ts";
import { resolveActors } from "./actors.ts";
import { EvalContext } from "./context.ts";
import { applyManifestToEnv, manifestPath, readEnvManifest, writeEnvManifest } from "./env-manifest.ts";
import { allocateFreePorts } from "./ports.ts";
import { renderFrameIndex } from "./reporters/fraimz-html.ts";
import { renderMarkdown } from "./reporters/markdown.ts";
import { isFlowDefinition, runFlowRepeated, shouldKeepIterationFrames } from "./runner.ts";
import { defineScenario } from "./scenario.ts";
import { SurfaceRegistry } from "./surfaces.ts";
import { loadVoiceoverParagraphs } from "./voiceover.ts";
import type { CdpClient } from "./cdp.ts";
import type { EnvManifest } from "./env-manifest.ts";
import type { EvalReport, FlowDefinition } from "./flow.ts";
import type { Host, SurfaceHandle } from "./hosts/types.ts";
import type { Surface } from "./surfaces.ts";

const ONE_BY_ONE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portFromServer(server: Server): number {
  const address = server.address();
  if (typeof address === "object" && address !== null) return address.port;
  throw new Error("Test server did not expose a TCP port.");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(portFromServer(server)));
  });
}

async function startCdpStub(targetId: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/json/list")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([
        {
          id: targetId,
          type: "page",
          title: "OpenWork",
          url: "http://127.0.0.1/app",
          webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${targetId}`,
        },
      ]));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => closeServer(server),
  };
}

function stubClient(label: string, closed: string[] = []): CdpClient {
  return {
    targetId: label,
    close: () => {
      closed.push(label);
    },
    async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      if (method === "Page.captureScreenshot") return { data: ONE_BY_ONE_PNG };
      if (method === "Runtime.evaluate") {
        const expression = typeof params.expression === "string" ? params.expression : "";
        if (expression.includes("document.body.innerText")) return { result: { value: "" } };
        if (expression.includes("location.href")) return { result: { value: `http://surface.test/${label}` } };
        return { result: { value: null } };
      }
      return {};
    },
  };
}

test("allocateFreePorts returns distinct usable ports", async () => {
  const ports = await allocateFreePorts(3);
  assert.equal(new Set(ports).size, 3);
  const servers: Server[] = [];
  try {
    for (const port of ports) {
      const server = createServer();
      await listen(server, port);
      servers.push(server);
    }
  } finally {
    await Promise.all(servers.map((server) => closeServer(server).catch(() => undefined)));
  }
});

test("env manifests round-trip and apply without overwriting explicit env", async () => {
  const name = `kernel-test-${Date.now()}`;
  const manifest: EnvManifest = {
    name,
    createdAt: "2026-07-28T00:00:00.000Z",
    defaultHostKind: "local",
    den: {
      webUrl: "http://den-web.test",
      apiUrl: "http://den-api.test",
      orgMode: "multi_org",
      hostKind: "local",
      token: "manifest-token",
    },
    surfaces: {
      desktop: {
        name: "desktop",
        kind: "electron",
        hostKind: "local",
        cdpUrl: "http://127.0.0.1:1",
      },
    },
    env: { EXTRA_VALUE: "from-manifest" },
  };

  try {
    await writeEnvManifest(manifest);
    assert.deepEqual(await readEnvManifest(name), manifest);

    const env: NodeJS.ProcessEnv = { OPENWORK_EVAL_DEN_API_URL: "preset-api" };
    applyManifestToEnv(manifest, env);
    assert.equal(env.OPENWORK_EVAL_DEN_API_URL, "preset-api");
    assert.equal(env.OPENWORK_EVAL_DEN_WEB_URL, "http://den-web.test");
    assert.equal(env.OPENWORK_EVAL_DEN_TOKEN, "manifest-token");
    assert.equal(env.OPENWORK_EVAL_DEN_MULTI_ORG, "1");
    assert.equal(env.EXTRA_VALUE, "from-manifest");

    const singleOrgEnv: NodeJS.ProcessEnv = {};
    applyManifestToEnv({ ...manifest, den: { webUrl: "http://web", apiUrl: "http://api", orgMode: "single_org", hostKind: "local" } }, singleOrgEnv);
    assert.equal(singleOrgEnv.OPENWORK_EVAL_DEN_MULTI_ORG, undefined);
  } finally {
    await rm(manifestPath(name), { force: true });
  }
});

test("defineScenario returns a flow, preserves steps, gates Den env, and passes actors", async () => {
  const flow = defineScenario({
    id: "kernel-scenario",
    title: "Kernel scenario",
    requiresApp: false,
    stage: { den: { orgMode: "single_org" } },
    actors: { owner: "owner", freshUser: { persona: "fresh", prefix: "teammate" } },
    steps: [
      {
        name: "first",
        run: (ctx) => {
          ctx.state.ownerEmail = ctx.actors.owner.email;
          ctx.state.freshEmail = ctx.actors.freshUser.email;
        },
      },
      { name: "second", run: () => undefined },
    ],
  });

  assert(isFlowDefinition(flow));
  assert.deepEqual(flow.steps.map((step) => step.name), ["first", "second"]);
  const ctx = new EvalContext({ client: null, outDir: tmpdir(), flowId: flow.id, env: { OPENWORK_EVAL_RUNSTAMP: "abc123" } });
  assert.equal(await flow.precondition?.(ctx), "Scenario needs a Den stack: run `pnpm owt up` or `pnpm evals --stack den` first");
  await flow.steps[0].run(ctx);
  assert.equal(ctx.state.ownerEmail, "alex@acme.test");
  assert.equal(ctx.state.freshEmail, "teammate-abc123@eval.openwork.test");
});

test("org-invite-two-desktops scenario loads with Den env gates and one step per narrated frame", async () => {
  const flowModule: unknown = await import(new URL("../flows/org-invite-two-desktops.flow.mjs", import.meta.url).href);
  const flow = isRecord(flowModule) ? flowModule.default : undefined;
  assert(isFlowDefinition(flow));
  const paragraphs = await loadVoiceoverParagraphs("org-invite-two-desktops");
  assert(paragraphs);

  assert.equal(flow.steps.length, paragraphs.length);
  assert.deepEqual(flow.steps.map((step) => step.name), [
    "Alex signs in on Den Web",
    "Alex creates the org",
    "Alex desktop connects to the org",
    "Alex runs a hello-script task",
    "Alex invites Jamie",
    "Jamie accepts from her Chrome",
    "Jamie desktop spawns fresh",
    "Jamie connects and runs her task",
  ]);
  assert(flow.requiredEnv?.includes("OPENWORK_EVAL_DEN_API_URL"));
  assert(flow.requiredEnv?.includes("OPENWORK_EVAL_DEN_WEB_URL"));
});

test("host placement defaults to Daytona when the manifest adopts a Daytona surface", () => {
  const manifest: EnvManifest = {
    name: "daytona-placement",
    createdAt: "2026-07-28T00:00:00.000Z",
    defaultHostKind: "daytona",
    surfaces: {
      desktop: {
        name: "desktop",
        kind: "electron",
        hostKind: "daytona",
        cdpUrl: "https://9825-preview.example.test",
        sandboxId: "sandbox-123",
      },
    },
    env: {},
  };

  assert.deepEqual(resolveHostPlacement(manifest, {}), {
    daytonaSandboxId: "sandbox-123",
    defaultHostKind: "daytona",
  });
});

test("resolveActors honors seeded owner env defaults", () => {
  assert.deepEqual(resolveActors({ demo: "owner" }, { DEN_DEMO_OWNER_EMAIL: "owner@example.test", DEN_DEMO_OWNER_PASSWORD: "secret" }).demo, {
    name: "demo",
    email: "owner@example.test",
    password: "secret",
    role: "owner",
  });
});

test("eval CLI parses repeat and rejects non-positive values", () => {
  assert.equal(parseArgs(["--flow", "invite-reliability"]).repeat, 1);
  assert.equal(parseArgs(["--flow", "invite-reliability", "--repeat", "3"]).repeat, 3);
  assert.throws(() => parseArgs(["--repeat", "0"]), /--repeat must be an integer >= 1/);
  assert.throws(() => parseArgs(["--repeat", "twice"]), /--repeat must be an integer >= 1/);
});

test("runFlowRepeated threads iteration runstamps and keeps first plus failing iteration evidence", async () => {
  let attempt = 0;
  const runstamps: string[] = [];
  const flow: FlowDefinition = {
    id: "soak-flow",
    title: "Soak flow",
    requiresApp: false,
    steps: [
      {
        name: "record iteration",
        run: (ctx) => {
          attempt += 1;
          runstamps.push(ctx.env.OPENWORK_EVAL_RUNSTAMP ?? "");
          ctx.recordEvidence({
            type: "frame",
            status: "passed",
            file: `iteration-${attempt}.png`,
            name: `iteration ${attempt}`,
            claim: null,
            voiceover: null,
            url: "about:blank",
            validations: [],
          });
          if (attempt === 2) throw new Error("iteration boom");
        },
      },
    ],
  };

  const repeated = await runFlowRepeated(flow, {
    cdpBaseUrl: null,
    outDir: tmpdir(),
    env: {},
    mode: "automation",
    repeat: 3,
    runStamp: "soak-base",
  });

  assert.deepEqual(runstamps, ["soak-base-1", "soak-base-2", "soak-base-3"]);
  assert.equal(repeated.summary.status, "failed");
  assert.equal(repeated.summary.passed, 2);
  assert.equal(repeated.summary.failed, 1);
  assert.deepEqual(repeated.summary.capturedIterations, [1, 2]);
  assert.deepEqual(repeated.summary.failures, [{ iteration: 2, step: "record iteration", error: "iteration boom" }]);
  assert.deepEqual(repeated.results.map((result) => result.id), ["soak-flow#1", "soak-flow#2"]);
  assert(repeated.results[0]?.steps[0]?.evidence.some((entry) => entry.type === "frame"));
  assert(repeated.results[1]?.steps[0]?.evidence.some((entry) => entry.type === "frame"));
  assert.equal(shouldKeepIterationFrames(1, "passed"), true);
  assert.equal(shouldKeepIterationFrames(2, "passed"), false);
  assert.equal(shouldKeepIterationFrames(2, "failed"), true);
});

test("core reliability scenarios are web-only, Den-staged, and narrated frame-for-frame", async () => {
  for (const flowId of ["invite-reliability", "mcp-connect-reliability"]) {
    const flowModule: unknown = await import(new URL(`../flows/${flowId}.flow.mjs`, import.meta.url).href);
    const flow = isRecord(flowModule) ? flowModule.default : undefined;
    assert(isFlowDefinition(flow));
    const paragraphs = await loadVoiceoverParagraphs(flowId);
    assert(paragraphs);
    assert.equal(flow.requiresApp, false);
    assert.equal(flow.steps.length, paragraphs.length);
    assert(flow.requiredEnv?.includes("OPENWORK_EVAL_DEN_API_URL"));
    assert(flow.requiredEnv?.includes("OPENWORK_EVAL_DEN_WEB_URL"));
  }
});

test("reporters render soak tables only when repeat summaries are present", () => {
  const report: EvalReport = {
    runId: "report-test",
    startedAt: "2026-07-28T00:00:00.000Z",
    finishedAt: "2026-07-28T00:00:01.000Z",
    cdpUrl: "(app-less run)",
    mode: "automation",
    flows: [],
    summary: { passed: 1, failed: 0, skipped: 0 },
  };
  assert(!renderMarkdown(report).includes("Soak summary"));
  assert(!renderFrameIndex(report).includes("Soak summary"));

  const soakReport: EvalReport = {
    ...report,
    soak: [{
      flowId: "invite-reliability",
      title: "Invite reliability",
      repeat: 3,
      status: "passed",
      passed: 3,
      failed: 0,
      skipped: 0,
      durationMs: 123,
      capturedIterations: [1],
      failures: [],
    }],
  };
  assert(renderMarkdown(soakReport).includes("| invite-reliability | 3 | 3 | 0 | 0 | 1 | passed |"));
  assert(renderFrameIndex(soakReport).includes("Soak summary"));
});

test("SurfaceRegistry is idempotent, adopts manifest surfaces, and disposes only spawned handles", async () => {
  const spawnedCdp = await startCdpStub("spawned-target");
  const adoptedCdp = await startCdpStub("adopted-target");
  const disposed: string[] = [];
  const closed: string[] = [];
  let spawnCount = 0;
  const fakeHost: Host = {
    kind: "fake",
    workspaceRoot: "/workspace",
    async spawnElectron(name: string): Promise<SurfaceHandle> {
      spawnCount += 1;
      return { name, kind: "electron", hostKind: "fake", cdpUrl: spawnedCdp.url };
    },
    async spawnChrome(name: string): Promise<SurfaceHandle> {
      spawnCount += 1;
      return { name, kind: "chrome", hostKind: "fake", cdpUrl: spawnedCdp.url };
    },
    async disposeSurface(handle: SurfaceHandle): Promise<void> {
      disposed.push(handle.name);
    },
  };
  const hosts = new Map<string, Host>([["fake", fakeHost]]);
  const registry = new SurfaceRegistry({
    hosts,
    defaultHostKind: "fake",
    onLog: () => undefined,
    manifest: {
      name: "test-env",
      createdAt: "2026-07-28T00:00:00.000Z",
      defaultHostKind: "fake",
      surfaces: {
        adopted: { name: "adopted", kind: "electron", hostKind: "fake", cdpUrl: adoptedCdp.url },
      },
    },
    connectSurface: async (handle) => stubClient(handle.name, closed),
  });

  try {
    const first = await registry.electron("spawned");
    const second = await registry.electron("spawned");
    const adopted = await registry.electron("adopted");
    assert.equal(first, second);
    assert.equal(adopted.handle.cdpUrl, adoptedCdp.url);
    assert.equal(spawnCount, 1);
    assert.throws(() => registry.get("missing"), /Known surfaces: adopted, spawned/);
    await registry.disposeAll();
    assert.deepEqual(disposed, ["spawned"]);
    assert.deepEqual(closed.sort(), ["adopted", "spawned"]);
  } finally {
    await Promise.all([spawnedCdp.close(), adoptedCdp.close()]);
  }
});

test("EvalContext.on swaps clients, restores through nesting, and labels frames", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "openwork-kernel-context-"));
  const primary = stubClient("primary");
  const one: Surface = { handle: { name: "one", kind: "chrome", hostKind: "fake", cdpUrl: "http://one" }, client: stubClient("one") };
  const two: Surface = { handle: { name: "two", kind: "chrome", hostKind: "fake", cdpUrl: "http://two" }, client: stubClient("two") };
  const ctx = new EvalContext({ client: primary, outDir, flowId: "surface-label", env: {} });

  try {
    await ctx.on(one, async () => {
      assert.equal(ctx.client, one.client);
      await ctx.screenshot("one", { allowInvalid: true });
      await ctx.on(two, async () => {
        assert.equal(ctx.client, two.client);
        await ctx.screenshot("two", { allowInvalid: true });
      });
      assert.equal(ctx.client, one.client);
    });

    assert.equal(ctx.client, primary);
    assert.equal(ctx.evidenceFrames[0]?.surface, "one");
    assert.equal(ctx.evidenceFrames[1]?.surface, "two");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
