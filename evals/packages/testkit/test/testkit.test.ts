import assert from "node:assert/strict";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  checkNeeds,
  deriveMockEnv,
  ephemeralDatabaseName,
  needs,
  resolvePlace,
  SkipError,
  trustedOrigins,
  validateWorldResources,
  validateWorldSurfaceSelection,
} from "@openwork/env";
import type { Den, WorldResources } from "@openwork/env";
import type { DenRef, DenSession } from "@openwork/behaviors";
import type { MockMcpHandle } from "@openwork/labs";
import { BufferedEvidenceSink, SeedChannel, SpecRuntime, channels, copyWorldResources, registerWorldDisposable, replayEvidence } from "../src/spec/runtime.ts";
import { createTestEvidence, withTestEvidence } from "@openwork/test-evidence";
import type { CdpClient, Surface } from "@openwork/cdp";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("active step captions follow nesting and clear after success or failure", async () => {
  await using stack = new AsyncDisposableStack();
  const runtime = new SpecRuntime(resolvePlace({}), stack, new BufferedEvidenceSink());
  runtime.stage = "body";
  assert.equal(runtime.currentStepName(), undefined);
  await runtime.step("parent", async () => {
    assert.equal(runtime.currentStepName(), "parent");
    await runtime.step("child", () => {
      assert.equal(runtime.currentStepName(), "child");
    });
    assert.equal(runtime.currentStepName(), "parent");
  });
  assert.equal(runtime.currentStepName(), undefined);
  await assert.rejects(runtime.step("failing parent", async () => {
    try {
      await runtime.step("failing child", () => {
        assert.equal(runtime.currentStepName(), "failing child");
        throw new Error("expected step failure");
      });
    } finally {
      assert.equal(runtime.currentStepName(), "failing parent");
    }
  }), /expected step failure/);
  assert.equal(runtime.currentStepName(), undefined);
});

test("world engine selection survives buffered evidence replay", (context) => {
  const buffer = new BufferedEvidenceSink();
  const evidence = createTestEvidence({ name: "world engine replay" });
  const setEngine = context.mock.method(evidence, "setEngine");
  buffer.setEngine("v2");
  replayEvidence(buffer, evidence);
  assert.deepEqual(setEngine.mock.calls.map((call) => call.arguments), [["v2"]]);
});

test("world resource validation rejects malformed and conflicting contracts", () => {
  for (const value of [null, [], {}, { surfaces: [], services: ["unknown"] },
    { surfaces: ["unknown"], services: [] }, { surfaces: ["appWeb", "appWeb"], services: [] },
    { surfaces: [], services: ["den", "den"] }, { surfaces: ["desktop"], services: [] },
    { surfaces: [], services: [], nativeReason: " " }, { surfaces: [], services: [], nativeReason: 1 },
    { surfaces: ["web"], services: [] }]) {
    assert.throws(() => validateWorldResources(value));
  }
  const resources: WorldResources = { surfaces: ["appWeb"], services: [] };
  assert.doesNotThrow(() => validateWorldSurfaceSelection(resources, "web"));
  assert.throws(() => validateWorldSurfaceSelection(resources, "electron"), /conflicts/);
  assert.throws(() => validateWorldSurfaceSelection(resources, "unknown"), /Unknown/);
});

test("arrangement and body enforce immutable resource snapshots before spawning", async (context) => {
  const spawn = context.mock.method(childProcess, "spawn", () => { throw new Error("Unexpected spawn"); });
  const exec = context.mock.method(childProcess, "execFile", () => { throw new Error("Unexpected execFile"); });
  syncBuiltinESMExports();
  try {
    const declaration: { surfaces: WorldResources["surfaces"][number][]; services: WorldResources["services"][number][] } = { surfaces: [], services: [] };
    const registered = copyWorldResources(declaration);
    declaration.surfaces.push("appWeb", "desktop", "web");
    declaration.services.push("den", "mock");
    const stack = new AsyncDisposableStack();
    const arrangement = new SpecRuntime(resolvePlace({}), stack, new BufferedEvidenceSink(), {}, registered);
    const body = new SpecRuntime(resolvePlace({}), stack, new BufferedEvidenceSink(), {}, arrangement.resources);
    body.stage = "body";
    body.acted = true;
    for (const runtime of [arrangement, body]) {
      assert.deepEqual(runtime.resources, { surfaces: [], services: [] });
      assert(Object.isFrozen(runtime.resources));
      assert(Object.isFrozen(runtime.resources?.surfaces));
      assert(Object.isFrozen(runtime.resources?.services));
      assert(runtime.resources);
      assert.equal(Reflect.set(runtime.resources.surfaces, "0", "appWeb"), false);
      assert.equal(Reflect.set(runtime.resources.services, "0", "den"), false);
      assert.equal(Reflect.set(runtime, "resources", undefined), false);
      const seed = new SeedChannel(runtime);
      for (const [resource, launch] of [
        ["den", () => seed.den()], ["desktop", () => seed.desktop()],
        ["appWeb", () => seed.appWeb({ workspacePath: "/unused" })],
        ["web", () => seed.web({ den: guardedDen })], ["mock", () => seed.mock()],
        ["den", () => seed.faultProxy(guardedDen)], ["den", () => seed.denLink(guardedDen)],
      ] satisfies [string, () => unknown][]) {
        await assert.rejects(async () => launch(), new RegExp(`Undeclared world resource ${resource}`));
      }
    }
    await stack.disposeAsync();
    assert.equal(spawn.mock.callCount(), 0);
    assert.equal(exec.mock.callCount(), 0);
  } finally {
    spawn.mock.restore();
    exec.mock.restore();
    syncBuiltinESMExports();
  }
});

// Access beyond the declaration gate would fail without touching infrastructure.
const guardedDen: Den = {
  get ref(): DenRef { throw new Error("Den ref accessed before guard"); },
  get admin(): DenSession { throw new Error("Den admin accessed before guard"); },
  members: {},
  mocks: { get fixture(): MockMcpHandle { throw new Error("Mock accessed before guard"); } },
  async apiLog() { return ""; },
  async [Symbol.asyncDispose]() {},
};

test("both stages guard direct and nested Den mocks", async () => {
  for (const stage of ["world", "body"] satisfies SpecRuntime["stage"][]) {
    const stack = new AsyncDisposableStack();
    const runtime = new SpecRuntime(resolvePlace({}), stack, new BufferedEvidenceSink(), {}, {
      surfaces: ["appWeb", "desktop", "web"], services: ["den"], nativeReason: "Native diagnostic",
    });
    runtime.stage = stage;
    runtime.acted = true;
    const seed = new SeedChannel(runtime);
    const mocks = { fixture: { async boot(): Promise<never> { throw new Error("Mock booted before guard"); } } };
    for (const launch of [
      () => seed.den({ mocks }), () => seed.appWeb({ workspacePath: "/unused", mocks }),
      () => seed.desktop({ den: guardedDen }), () => seed.web({ den: guardedDen }),
      () => seed.faultProxy(guardedDen), () => seed.denLink(guardedDen),
    ]) await assert.rejects(async () => launch(), /Undeclared world resource mock/);
    await stack.disposeAsync();
  }
});

test("returned handle kinds and late resources are disposed on rejection", async () => {
  const stack = new AsyncDisposableStack();
  const runtime = new SpecRuntime(resolvePlace({}), stack, new BufferedEvidenceSink());
  let disposed = 0;
  const resource = (kind: string) => ({ handle: { kind }, client: {}, async [Symbol.asyncDispose]() { disposed++; } });
  await assert.rejects(runtime.own(resource("electron"), "chrome"), /expected chrome/);
  await assert.rejects(runtime.own(resource("chrome"), "electron"), /expected electron/);
  assert.equal(disposed, 2);
  await runtime.own(resource("chrome"), "chrome");
  await runtime.own(resource("electron"), "electron");
  await stack.disposeAsync();
  assert.equal(disposed, 4);
  await assert.rejects(runtime.own(resource("chrome"), "chrome"), ReferenceError);
  assert.equal(disposed, 5);
  await registerWorldDisposable(stack, { async [Symbol.asyncDispose]() { disposed++; } });
  assert.equal(disposed, 6);
  await assert.rejects(runtime.own({ handle: null, client: {}, async [Symbol.asyncDispose]() { disposed++; } }, "chrome"), /expected chrome/);
  assert.equal(disposed, 7);
  await assert.rejects(runtime.own({
    handle: { kind: "electron" }, client: {},
    async [Symbol.asyncDispose]() { throw new Error("cleanup failed"); },
  }, "chrome"), (error) => {
    assert(error instanceof AggregateError);
    assert.match(error.errors[0].message, /expected chrome/);
    assert.match(error.errors[1].message, /cleanup failed/);
    return true;
  });
});

test("resolvePlace selects local unless OPENWORK_EVAL_DAYTONA is exactly 1", () => {
  const local = resolvePlace({});
  const falseyDaytona = resolvePlace({ OPENWORK_EVAL_DAYTONA: "0" });
  const daytona = resolvePlace({ OPENWORK_EVAL_DAYTONA: "1", OPENWORK_EVAL_REF: "feature-ref" });
  assert.equal(local.kind, "local");
  assert.equal(falseyDaytona.kind, "local");
  assert.equal(daytona.kind, "daytona");
  assert.deepEqual(daytona.denBase(), { kind: "daytona", ref: "feature-ref" });
});

test("needs accepts a tool-capable model and provider key", () => {
  assert.doesNotThrow(() => checkNeeds(
    { model: "tool-capable", env: ["EXTRA_REQUIRED"] },
    {
      OPENWORK_EVAL_MODEL: "openai/gpt-5",
      OPENAI_API_KEY: "test-key",
      EXTRA_REQUIRED: "1",
    },
  ));
});

test("needs throws a named SkipError for every unsatisfied resource", () => {
  assert.throws(
    () => checkNeeds({ model: "tool-capable", env: ["EXTRA_REQUIRED"], optIn: ["EXACT_OPT_IN"], daytona: true }, {}),
    (error) => {
      assert(error instanceof SkipError);
      assert.match(error.message, /^needs: /);
      assert.match(error.message, /set EXTRA_REQUIRED/);
      assert.match(error.message, /set EXACT_OPT_IN=1/);
      assert.match(error.message, /set OPENWORK_EVAL_MODEL/);
      assert.match(error.message, /set OPENAI_API_KEY or ANTHROPIC_API_KEY/);
      assert.match(error.message, /set OPENWORK_EVAL_DAYTONA=1/);
      return true;
    },
  );
});

test("needs only accepts opt-in gates set exactly to 1", () => {
  assert.throws(() => checkNeeds({ optIn: ["EXACT_OPT_IN"] }, { EXACT_OPT_IN: "true" }), SkipError);
  assert.doesNotThrow(() => checkNeeds({ optIn: ["EXACT_OPT_IN"] }, { EXACT_OPT_IN: "1" }));
});

test("needs reports an unavailable command", () => {
  const command = "openwork-impossible-command-for-testkit-test";
  assert.throws(
    () => checkNeeds({ commands: [command] }, {}),
    (error) => error instanceof SkipError && error.message.includes(`install ${command}`),
  );
});

test("needs rejects a local-only test on Daytona or an attached Den", () => {
  assert.doesNotThrow(() => checkNeeds({ placement: "local" }, {}));
  assert.throws(() => checkNeeds({ placement: "local" }, { OPENWORK_EVAL_DAYTONA: "1" }), SkipError);
  assert.throws(
    () => checkNeeds({ placement: "local" }, { OPENWORK_EVAL_DEN_API_URL: "https://den.example.test" }),
    SkipError,
  );
});

test("needs reads process.env at the call site", () => {
  const name = "OPENWORK_TESTKIT_UNIT_RESOURCE";
  const previous = process.env[name];
  try {
    delete process.env[name];
    assert.throws(() => needs({ env: [name] }), SkipError);
    process.env[name] = "available";
    assert.deepEqual(needs({ env: [name] }), {});
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
});

test("mcp mock environment is derived from the resource name and public URLs", () => {
  assert.deepEqual(
    deriveMockEnv("acme tickets", "https://mock.example.test", "https://mock.example.test/mcp"),
    {
      OPENWORK_EVAL_MOCK_ACME_TICKETS_URL: "https://mock.example.test",
      OPENWORK_EVAL_MOCK_ACME_TICKETS_MCP_URL: "https://mock.example.test/mcp",
    },
  );
});

test("trusted origins contain both Den ports in localhost and loopback forms", () => {
  assert.deepEqual(trustedOrigins(8788, 3005), [
    "http://localhost:8788",
    "http://127.0.0.1:8788",
    "http://localhost:3005",
    "http://127.0.0.1:3005",
  ]);
});

test("ephemeral database names are valid and unique", () => {
  const names = new Set(Array.from({ length: 100 }, () => ephemeralDatabaseName()));
  assert.equal(names.size, 100);
  for (const name of names) assert.match(name, /^[a-z][a-z0-9_]{0,62}$/);
});


test("needs recognizes OpenSSL implementations that reject --version", (context) => {
  const spawn = context.mock.method(childProcess, "spawnSync", (command: string, args: readonly string[]) => ({
    pid: 0, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), signal: null,
    status: command === "openssl" && args[0] === "version" ? 0 : 1,
  }));
  syncBuiltinESMExports();
  try {
    assert.doesNotThrow(() => checkNeeds({ commands: ["openssl"] }, {}));
    assert.equal(spawn.mock.callCount(), 1);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
});

/** A page that settles at once, renders `frame`, and reports one element at a fixed place for every lookup. */
function fakePage(frame: Buffer) {
  const methods: string[] = [];
  const client: CdpClient = {
    close() {},
    async send(method, params) {
      methods.push(method);
      if (method === "Page.bringToFront") return {};
      if (method === "Page.captureScreenshot") return { data: frame.toString("base64") };
      if (method === "Runtime.evaluate" && params?.expression === "globalThis") return { result: { objectId: "page-global" } };
      if (method === "Runtime.evaluate") return { result: { value: { route: "#/panel", visibleText: "Panel\nSaved", width: 1280, height: 800 } } };
      if (method === "Runtime.callFunctionOn") {
        const declaration = String(params?.functionDeclaration);
        if (declaration.includes("MutationObserver")) return { result: { value: { ms: 200, settled: true } } };
        if (declaration.includes("implicitRole")) {
          return { result: { value: { center: { x: 256, y: 100 }, rect: { x: 128, y: 80, width: 256, height: 40 }, tag: "button", name: "Saved", visible: true, hitTestOk: true, editable: false, disabled: null, value: "", text: "Saved", covering: null } } };
        }
        return { result: { type: "undefined" } };
      }
      throw new Error(`Unexpected CDP method: ${method}`);
    },
  };
  const surface: Surface = { handle: { name: "page", kind: "chrome", hostKind: "test", cdpUrl: "http://127.0.0.1" }, client };
  return { surface, methods };
}

test("a screenshot outlines what its step verified, and a failed step keeps the screen it failed on", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-spec-evidence-"));
  try {
    await using stack = new AsyncDisposableStack();
    const evidence = createTestEvidence({ name: "panel opens", outDir: dir });
    const runtime = new SpecRuntime(resolvePlace({}), stack, evidence);
    runtime.stage = "body";
    const { surface } = fakePage(Buffer.from("not decoded"));
    runtime.setPrimary({ web: surface });
    const user = channels(runtime).user;
    await withTestEvidence(evidence, async () => {
      await runtime.step("after: the panel opens", async () => {
        await user.see({ role: "button", label: "Saved" });
        await user.screenshot();
      });
      await assert.rejects(runtime.step("the panel survives reload", async () => {
        await runtime.step("after reload", async () => { throw new Error("Timed out seeing Saved"); });
      }), /Timed out seeing Saved/);
    });
    await evidence.close();
    const record: unknown = JSON.parse(await readFile(join(dir, "test-run.json"), "utf8"));
    assert.ok(typeof record === "object" && record !== null && "artifacts" in record && Array.isArray(record.artifacts));
    const [shown, failed, ...rest] = record.artifacts;
    assert.equal(rest.length, 0, "one failure frame, not one per enclosing step");
    assert.equal(shown.step, "after: the panel opens");
    assert.deepEqual(shown.focus, [{ label: "Saved", box: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 } }]);
    assert.deepEqual(shown.settle, { ms: 200, settled: true });
    assert.equal(failed.caption, "failed: after reload");
    assert.equal(failed.step, "after reload");
    assert.equal(failed.failure, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
