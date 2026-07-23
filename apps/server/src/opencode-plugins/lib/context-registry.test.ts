import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  createContextPlugin,
  describeContextRegistry,
  evaluateContextRegistryGates,
  type Base,
  type CachePolicy,
  type ChatMessagesOutput,
  type ChatParamsOutput,
  type ContextContributor,
  type ContributorEnv,
  type EngineToolDefinition,
  type FetchPatchContributor,
  type GateResult,
  type MessagesContributor,
  type ParamsContributor,
  type ResolveInput,
  type SystemBlockContributor,
  type ToolContributor,
} from "./context-registry.js";
import { type OpenWorkFetch } from "./server-client.js";

const originalPromptLog = process.env.OPENWORK_PROMPT_LOG;
const originalRegistryGate = process.env.OPENWORK_REGISTRY_TEST_GATE;
const originalServerUrl = process.env.OPENWORK_SERVER_URL;
const originalServerToken = process.env.OPENWORK_SERVER_TOKEN;

beforeEach(() => {
  delete process.env.OPENWORK_SERVER_URL;
  delete process.env.OPENWORK_SERVER_TOKEN;
});

afterEach(() => {
  restoreEnv("OPENWORK_PROMPT_LOG", originalPromptLog);
  restoreEnv("OPENWORK_REGISTRY_TEST_GATE", originalRegistryGate);
  restoreEnv("OPENWORK_SERVER_URL", originalServerUrl);
  restoreEnv("OPENWORK_SERVER_TOKEN", originalServerToken);
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

type ContributorDefaults = {
  id: string;
  order: number;
  description?: string;
  gate?: (env: ContributorEnv) => GateResult;
  gateEnv?: readonly string[];
  cache?: CachePolicy;
  onError?: Base["onError"];
};

function base(input: ContributorDefaults): Base {
  return {
    id: input.id,
    order: input.order,
    description: input.description ?? `${input.id} description`,
    cache: input.cache ?? { scope: "none" },
    onError: input.onError ?? { mode: "omit" },
    ...(input.gate ? { gate: input.gate } : {}),
    ...(input.gateEnv ? { gateEnv: input.gateEnv } : {}),
  };
}

function system(
  input: ContributorDefaults & {
    resolve: SystemBlockContributor["resolve"];
  },
): SystemBlockContributor {
  return { ...base(input), kind: "system-block", resolve: input.resolve };
}

function tool(
  input: ContributorDefaults & {
    toolNames?: readonly string[];
    tools: ToolContributor["tools"];
  },
): ToolContributor {
  return {
    ...base(input),
    kind: "tool",
    toolNames: input.toolNames ?? [],
    tools: input.tools,
  };
}

function params(
  input: ContributorDefaults & {
    chatParams: ParamsContributor["chatParams"];
  },
): ParamsContributor {
  return { ...base(input), kind: "params", chatParams: input.chatParams };
}

function messages(
  input: ContributorDefaults & {
    transformMessages: MessagesContributor["transformMessages"];
  },
): MessagesContributor {
  return { ...base(input), kind: "messages", transformMessages: input.transformMessages };
}

function fetchPatch(
  input: ContributorDefaults & {
    install: FetchPatchContributor["install"];
  },
): FetchPatchContributor {
  return { ...base(input), kind: "fetch-patch", install: input.install };
}

function requiredSystemTransform(
  plugin: Awaited<ReturnType<ReturnType<typeof createContextPlugin>>>,
): NonNullable<typeof plugin["experimental.chat.system.transform"]> {
  const transform = plugin["experimental.chat.system.transform"];
  if (!transform) throw new Error("Expected system transform hook");
  return transform;
}

function requiredParamsHook(
  plugin: Awaited<ReturnType<ReturnType<typeof createContextPlugin>>>,
): NonNullable<typeof plugin["chat.params"]> {
  const hook = plugin["chat.params"];
  if (!hook) throw new Error("Expected params hook");
  return hook;
}

function requiredMessagesHook(
  plugin: Awaited<ReturnType<ReturnType<typeof createContextPlugin>>>,
): NonNullable<typeof plugin["experimental.chat.messages.transform"]> {
  const hook = plugin["experimental.chat.messages.transform"];
  if (!hook) throw new Error("Expected messages transform hook");
  return hook;
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve: (value: Value | PromiseLike<Value>) => void;
} {
  let resolve = (_value: Value | PromiseLike<Value>) => {};
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("context contributor registry", () => {
  test("sorts stably and resolves system blocks sequentially with merged context", async () => {
    process.env.OPENWORK_PROMPT_LOG = "0";
    process.env.OPENWORK_SERVER_URL = "http://openwork.test/";
    process.env.OPENWORK_SERVER_TOKEN = "registry-token";
    const trace: string[] = [];
    const pending = deferred<void>();
    let captured: ResolveInput | undefined;
    const bundleRequests: Array<{
      url: string;
      authorization: string | null;
      promptTrace: string | null;
    }> = [];
    const fetcher: OpenWorkFetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      bundleRequests.push({
        url,
        authorization: headers.get("authorization"),
        promptTrace: headers.get("x-openwork-prompt-trace"),
      });
      return Response.json({
        ok: true,
        schemaVersion: 1,
        steering: {
          connectEnabled: true,
          connectCatalogEnabled: true,
          cloudMcpPresent: false,
          cloudHealth: null,
          workspace: { resolution: "resolved", id: "ws_registry", directory: "/turn" },
          googleWorkspace: { legacyConfigured: false },
        },
        skills: { instruction: "registry skill block", count: 1 },
        diagnostics: ["registry bundle loaded"],
        generatedAt: 1,
      });
    };
    const mcpStatus = async () => ({ data: {} });

    const registry: ContextContributor[] = [
      system({
        id: "third",
        order: 20,
        resolve() {
          trace.push("third");
          return "third block";
        },
      }),
      system({
        id: "first",
        order: 10,
        async resolve(input) {
          captured = input;
          trace.push("first:start");
          await pending.promise;
          trace.push("first:end");
          return "first block";
        },
      }),
      system({
        id: "second",
        order: 10,
        resolve() {
          trace.push("second");
          return "second block";
        },
      }),
    ];

    const plugin = await createContextPlugin(registry)({
      agent: "factory-agent",
      directory: "/factory",
      fetcher,
      client: { mcp: { status: mcpStatus } },
    });
    const output = { system: ["engine base"] };
    const running = requiredSystemTransform(plugin)(
      {
        sessionID: "session-1",
        messageID: "message-1",
        directory: "/turn",
        model: { providerID: "test-provider", modelID: "test-model" },
      },
      output,
    );

    await Bun.sleep(0);
    expect(trace).toEqual(["first:start"]);
    pending.resolve();
    await running;

    expect(trace).toEqual(["first:start", "first:end", "second", "third"]);
    expect(output.system).toEqual(["engine base", "first block", "second block", "third block"]);
    expect(captured?.traceId).toMatch(/^pt_[a-z0-9]{12}$/);
    expect(captured?.context).toEqual({
      agent: "factory-agent",
      directory: "/turn",
      sessionID: "session-1",
      messageID: "message-1",
    });
    expect(captured?.bundle?.skills).toEqual({ instruction: "registry skill block", count: 1 });
    expect(captured?.fetcher).toBe(fetcher);
    expect(captured?.sourceInput).toEqual({
      sessionID: "session-1",
      messageID: "message-1",
      directory: "/turn",
      model: { providerID: "test-provider", modelID: "test-model" },
      context: { agent: "factory-agent", directory: "/factory" },
    });
    expect(captured?.engine?.directory).toBe("/factory");
    expect(captured?.engine?.client?.mcp.status).toBeFunction();
    expect(bundleRequests).toHaveLength(1);
    expect(bundleRequests[0]).toMatchObject({
      url: "http://openwork.test/experimental/connect/context?directory=%2Fturn&steering=passive",
      authorization: "Bearer registry-token",
    });
    expect(captured).toBeDefined();
    expect(bundleRequests[0]?.promptTrace).toBe(captured!.traceId);
  });

  test("applies contributor gates without invoking disabled contributors", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    process.env.OPENWORK_REGISTRY_TEST_GATE = "off";
    let resolves = 0;
    let gateCalls = 0;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));
    try {
      const plugin = await createContextPlugin([
        system({
          id: "conditional",
          order: 10,
          gate(env) {
            gateCalls += 1;
            expect(env.factoryContext.directory).toBe("/workspace");
            return env.env.OPENWORK_REGISTRY_TEST_GATE === "on"
              ? { enabled: true }
              : { enabled: false, reason: "test flag is off" };
          },
          resolve() {
            resolves += 1;
            return "hidden";
          },
        }),
      ])({ directory: "/workspace" });

      process.env.OPENWORK_REGISTRY_TEST_GATE = "on";
      const output = { system: [] as string[] };
      await requiredSystemTransform(plugin)({}, output);
      expect(output.system).toEqual([]);
      expect(resolves).toBe(0);
      expect(gateCalls).toBe(1);
      expect(errors[0]).toBe(
        "[openwork][context] id=conditional enabled=false reason=test flag is off",
      );
      expect(errors[1]).toMatch(
        /^\[openwork\]\[context\] trace=pt_[a-z0-9]{12} context bundle unavailable classification=configuration$/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("isolates resolver and gate failures, always logs ids, and applies only declared fallbacks", async () => {
    process.env.OPENWORK_PROMPT_LOG = "0";
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));
    try {
      const plugin = await createContextPlugin([
        system({
          id: "omit-failure",
          order: 10,
          resolve() {
            throw new Error("omit exploded");
          },
        }),
        system({
          id: "fallback-failure",
          order: 20,
          onError: { mode: "fallback", text: "safe fallback" },
          resolve() {
            throw new Error("fallback exploded");
          },
        }),
        system({
          id: "gate-failure",
          order: 30,
          gate() {
            throw new Error("gate exploded");
          },
          onError: { mode: "fallback", text: "gate fallback" },
          resolve() {
            return "unreachable";
          },
        }),
        system({
          id: "non-error-failure",
          order: 35,
          resolve() {
            throw "literal exploded value";
          },
        }),
        system({ id: "null-result", order: 40, resolve: () => null }),
        system({ id: "empty-result", order: 50, resolve: () => "" }),
        system({ id: "healthy", order: 60, resolve: () => "healthy block" }),
      ])();

      const output = { system: [] as string[] };
      await requiredSystemTransform(plugin)({}, output);
      expect(output.system).toEqual(["safe fallback", "gate fallback", "healthy block"]);
      expect(errors).toHaveLength(4);
      expect(errors[0]).toContain("id=omit-failure");
      expect(errors[0]).toContain("onError=omit");
      expect(errors[0]).toContain("kind=system-block");
      expect(errors[0]).toContain("stage=system-block-resolution");
      expect(errors[0]).toContain("classification=error");
      expect(errors[1]).toContain("id=fallback-failure");
      expect(errors[2]).toContain("id=gate-failure");
      expect(errors[2]).toContain("stage=gate-evaluation");
      expect(errors[3]).toContain("id=non-error-failure");
      expect(errors[3]).toContain("classification=non-error-throw");
      expect(errors.join("\n")).not.toContain("exploded");
    } finally {
      spy.mockRestore();
    }
  });

  test("shares process system caches across calls and coalesces in-flight loads", async () => {
    process.env.OPENWORK_PROMPT_LOG = "0";
    let loads = 0;
    const pending = deferred<string>();
    const contributor = system({
      id: "cached",
      order: 10,
      cache: { scope: "process" },
      resolve() {
        loads += 1;
        return pending.promise;
      },
    });
    const factory = createContextPlugin([contributor]);
    const firstPlugin = await factory();
    const secondPlugin = await factory();
    const firstOutput = { system: [] as string[] };
    const secondOutput = { system: [] as string[] };

    const first = requiredSystemTransform(firstPlugin)({}, firstOutput);
    const second = requiredSystemTransform(secondPlugin)({}, secondOutput);
    await Bun.sleep(0);
    expect(loads).toBe(1);

    pending.resolve("cached block");
    await Promise.all([first, second]);
    expect(firstOutput.system).toEqual(["cached block"]);
    expect(secondOutput.system).toEqual(["cached block"]);
    expect(loads).toBe(1);
  });

  test("expires TTL system caches and evicts rejected loads", async () => {
    process.env.OPENWORK_PROMPT_LOG = "0";
    let ttlLoads = 0;
    const ttlContributor = system({
      id: "ttl",
      order: 10,
      cache: { scope: "process", ttlMs: 1 },
      resolve() {
        ttlLoads += 1;
        return `ttl-${ttlLoads}`;
      },
    });
    let retryLoads = 0;
    const retryContributor = system({
      id: "retry",
      order: 20,
      cache: { scope: "process" },
      onError: { mode: "fallback", text: "retry fallback" },
      resolve() {
        retryLoads += 1;
        if (retryLoads === 1) throw new Error("temporary");
        return "recovered";
      },
    });
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));
    try {
      const plugin = await createContextPlugin([ttlContributor, retryContributor])();
      const first = { system: [] as string[] };
      await requiredSystemTransform(plugin)({}, first);
      expect(first.system).toEqual(["ttl-1", "retry fallback"]);

      await Bun.sleep(5);
      const second = { system: [] as string[] };
      await requiredSystemTransform(plugin)({}, second);
      expect(second.system).toEqual(["ttl-2", "recovered"]);
      expect(ttlLoads).toBe(2);
      expect(retryLoads).toBe(2);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("id=retry");
    } finally {
      spy.mockRestore();
    }
  });

  test("merges tools and installs fetch patches at factory time in registry order", async () => {
    process.env.OPENWORK_PROMPT_LOG = "0";
    const trace: string[] = [];
    let cachedToolLoads = 0;
    let cachedInstalls = 0;
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));
    try {
      const registry: ContextContributor[] = [
        tool({
          id: "later-tools",
          order: 40,
          tools() {
            trace.push("later-tools");
            return { shared: { source: "later" }, later: { source: "later" } };
          },
        }),
        fetchPatch({
          id: "patch-once",
          order: 10,
          cache: { scope: "process" },
          install() {
            cachedInstalls += 1;
            trace.push("patch-once");
          },
        }),
        tool({
          id: "cached-tools",
          order: 20,
          cache: { scope: "process" },
          tools(env) {
            cachedToolLoads += 1;
            trace.push("cached-tools");
            return {
              shared: { source: "earlier" },
              workspace: { directory: env.factoryContext.directory ?? "missing" },
            };
          },
        }),
        tool({
          id: "disabled-tools",
          order: 25,
          gate: () => ({ enabled: false, reason: "disabled for test" }),
          tools() {
            trace.push("disabled-tools");
            return { hidden: {} };
          },
        }),
        fetchPatch({
          id: "broken-patch",
          order: 30,
          install() {
            throw new Error("patch exploded");
          },
        }),
        tool({
          id: "broken-tools",
          order: 35,
          tools() {
            throw new Error("tools exploded");
          },
        }),
      ];
      const factory = createContextPlugin(registry);

      const first = await factory({ directory: "/one" });
      expect(trace).toEqual(["patch-once", "cached-tools", "later-tools"]);
      expect(first.tool).toEqual({
        shared: { source: "later" },
        workspace: { directory: "/one" },
        later: { source: "later" },
      });

      trace.length = 0;
      const second = await factory({ directory: "/two" });
      expect(trace).toEqual(["later-tools"]);
      expect(second.tool).toEqual({
        shared: { source: "later" },
        workspace: { directory: "/one" },
        later: { source: "later" },
      });
      expect(cachedInstalls).toBe(1);
      expect(cachedToolLoads).toBe(1);
      expect(errors).toHaveLength(6);
      expect(errors.filter((message) => message.includes("id=broken-patch"))).toHaveLength(2);
      expect(errors.filter((message) => message.includes("id=broken-tools"))).toHaveLength(2);
      expect(errors.join("\n")).not.toContain("patch exploded");
      expect(errors.join("\n")).not.toContain("tools exploded");
      expect(errors.filter((message) => message.includes("duplicate tool id=shared"))).toEqual([
        "[openwork][context] duplicate tool id=shared contributors=cached-tools,later-tools; using=later-tools",
        "[openwork][context] duplicate tool id=shared contributors=cached-tools,later-tools; using=later-tools",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test("aggregates params and message hooks sequentially while isolating failures", async () => {
    process.env.OPENWORK_PROMPT_LOG = "0";
    const trace: string[] = [];
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));
    try {
      const registry: ContextContributor[] = [
        params({
          id: "params-last",
          order: 30,
          chatParams(_input, output) {
            output.options.last = true;
            trace.push("params-last");
          },
        }),
        params({
          id: "params-first",
          order: 10,
          chatParams(_input, output) {
            output.options.first = true;
            trace.push("params-first");
          },
        }),
        params({
          id: "params-broken",
          order: 20,
          chatParams() {
            throw new Error("params exploded");
          },
        }),
        messages({
          id: "messages-last",
          order: 60,
          async transformMessages(_input, output) {
            trace.push("messages-last");
            output.messages.push("last");
          },
        }),
        messages({
          id: "messages-first",
          order: 40,
          async transformMessages(_input, output, env) {
            expect(env.factoryContext).toEqual({ directory: "/factory-workspace", agent: "factory-agent" });
            trace.push("messages-first:start");
            await Promise.resolve();
            output.messages.push("first");
            trace.push("messages-first:end");
          },
        }),
        messages({
          id: "messages-broken",
          order: 50,
          async transformMessages() {
            throw new Error("messages exploded");
          },
        }),
        messages({
          id: "messages-disabled",
          order: 55,
          gate: () => ({ enabled: false, reason: "not applicable" }),
          async transformMessages(_input, output) {
            output.messages.push("hidden");
          },
        }),
      ];
      const plugin = await createContextPlugin(registry)({
        directory: "/factory-workspace",
        agent: "factory-agent",
      });
      const paramsOutput: ChatParamsOutput = { options: {} };
      await requiredParamsHook(plugin)({ model: "test" }, paramsOutput);
      const messagesOutput: ChatMessagesOutput = { messages: ["base"] };
      await requiredMessagesHook(plugin)({ sessionID: "session" }, messagesOutput);

      expect(paramsOutput.options).toEqual({ first: true, last: true });
      expect(messagesOutput.messages).toEqual(["base", "first", "last"]);
      expect(trace).toEqual([
        "params-first",
        "params-last",
        "messages-first:start",
        "messages-first:end",
        "messages-last",
      ]);
      expect(errors).toHaveLength(2);
      expect(errors[0]).toContain("id=params-broken");
      expect(errors[1]).toContain("id=messages-broken");
    } finally {
      spy.mockRestore();
    }
  });

  test("logs only sanitized context-bundle failure classifications in dev diagnostics and keeps contributors omitted", async () => {
    process.env.OPENWORK_PROMPT_LOG = "1";
    const errors: string[] = [];
    const observedBundles: Array<ResolveInput["bundle"]> = [];
    const spy = spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));
    const run = async (fetcher: OpenWorkFetch): Promise<void> => {
      const plugin = await createContextPlugin([
        system({
          id: "bundle-probe",
          order: 10,
          resolve(input) {
            observedBundles.push(input.bundle);
            return input.bundle ? "unexpected bundle" : null;
          },
        }),
      ])({ fetcher });
      const output = { system: [] as string[] };
      await requiredSystemTransform(plugin)({}, output);
      expect(output.system).toEqual([]);
    };

    try {
      delete process.env.OPENWORK_SERVER_URL;
      delete process.env.OPENWORK_SERVER_TOKEN;
      await run(async () => {
        throw new Error("configuration fetcher must not run");
      });

      process.env.OPENWORK_SERVER_URL = "http://openwork.test/private-server-path";
      process.env.OPENWORK_SERVER_TOKEN = "bundle-secret-token";
      await run(async () => Response.json(
        { message: "sensitive authentication payload" },
        { status: 401 },
      ));
      await run(async () => Response.json(
        { message: "sensitive service payload" },
        { status: 502 },
      ));
      await run(async () => Response.json({
        ok: true,
        schemaVersion: 2,
        detail: "sensitive schema payload",
      }));
      await run(async () => {
        throw new Error("sensitive transport error at http://private.example");
      });

      expect(observedBundles).toEqual([null, null, null, null, null]);
      expect(errors
        .filter((message) => message.includes("context bundle unavailable"))
        .map((message) => message.replace(/trace=pt_[a-z0-9]{12} /, "")))
        .toEqual([
          "[openwork][context] context bundle unavailable classification=configuration",
          "[openwork][context] context bundle unavailable classification=auth status=401",
          "[openwork][context] context bundle unavailable classification=http status=502",
          "[openwork][context] context bundle unavailable classification=schema",
          "[openwork][context] context bundle unavailable classification=transport",
        ]);
      const rendered = errors.join("\n");
      expect(rendered).not.toContain("bundle-secret-token");
      expect(rendered).not.toContain("private-server-path");
      expect(rendered).not.toContain("sensitive");
      expect(rendered).not.toContain("private.example");
    } finally {
      spy.mockRestore();
    }
  });

  test("logs system attribution with a safe trace id, contributor id, chars, and full sha256 when enabled", async () => {
    const errors: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((message) => errors.push(String(message)));
    try {
      const plugin = await createContextPlugin([
        system({ id: "alpha", order: 10, resolve: () => "hello" }),
      ])();

      process.env.OPENWORK_PROMPT_LOG = "0";
      await requiredSystemTransform(plugin)({}, { system: [] });
      expect(errors).toEqual([]);

      process.env.OPENWORK_PROMPT_LOG = "1";
      await requiredSystemTransform(plugin)({}, { system: [] });
      const attributionLogs = errors.filter((message) => message.includes("id=alpha"));
      expect(attributionLogs).toHaveLength(1);
      expect(attributionLogs[0]).toMatch(
        /^\[openwork\]\[context\] trace=pt_[a-z0-9]{12} id=alpha chars=5 sha256=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824$/,
      );
      expect(attributionLogs[0]).not.toContain("hello");
    } finally {
      spy.mockRestore();
    }
  });

  test("describes a sorted registry without running gates or sharing mutable cache metadata", () => {
    let gateCalls = 0;
    const gated = tool({
      id: "gated-tool",
      order: 20,
      description: "A gated tool set",
      toolNames: ["demo"],
      cache: { scope: "process", ttlMs: 500 },
      gateEnv: ["OPENWORK_REGISTRY_TEST_GATE"],
      gate() {
        gateCalls += 1;
        return { enabled: true };
      },
      tools: () => ({ demo: {} }),
    });
    const always = system({
      id: "always-block",
      order: 10,
      description: "An always-on block",
      resolve: () => "block",
    });
    const registry: ContextContributor[] = [gated, always];

    const description = describeContextRegistry(registry);
    expect(description).toEqual([
      {
        id: "always-block",
        kind: "system-block",
        order: 10,
        gate: "always",
        gateEnv: [],
        toolNames: [],
        cache: { scope: "none" },
        description: "An always-on block",
      },
      {
        id: "gated-tool",
        kind: "tool",
        order: 20,
        gate: "contributor-env",
        gateEnv: ["OPENWORK_REGISTRY_TEST_GATE"],
        toolNames: ["demo"],
        cache: { scope: "process", ttlMs: 500 },
        description: "A gated tool set",
      },
    ]);
    expect(description[1]?.cache).not.toBe(gated.cache);
    expect(gateCalls).toBe(0);
    expect(registry.map((contributor) => contributor.id)).toEqual(["gated-tool", "always-block"]);
  });

  test("evaluates gates with stable reasons and never returns gate text or environment values", () => {
    const secret = "owt_registry_secret_value";
    const registry: ContextContributor[] = [
      system({ id: "always", order: 10, resolve: () => null }),
      system({
        id: "disabled",
        order: 20,
        gate: ({ env }) => ({ enabled: false, reason: `disabled by ${env.OPENWORK_REGISTRY_TEST_GATE}` }),
        resolve: () => null,
      }),
      system({
        id: "broken",
        order: 30,
        gate() {
          throw new Error(secret);
        },
        resolve: () => null,
      }),
      system({
        id: "enabled",
        order: 40,
        gate: () => ({ enabled: true }),
        resolve: () => null,
      }),
    ];

    const evaluations = evaluateContextRegistryGates(registry, {
      env: { OPENWORK_REGISTRY_TEST_GATE: secret },
      factoryContext: {},
    });

    expect(evaluations).toEqual([
      { id: "always", enabled: true, reason: "always" },
      { id: "disabled", enabled: false, reason: "gate_disabled" },
      { id: "broken", enabled: false, reason: "gate_error" },
      { id: "enabled", enabled: true, reason: "gate_enabled" },
    ]);
    expect(JSON.stringify(evaluations)).not.toContain(secret);
  });

  test("returns no hooks for an empty registry", async () => {
    expect(await createContextPlugin([])()).toEqual({});
  });
});
