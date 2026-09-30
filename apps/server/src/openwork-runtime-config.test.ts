import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { managedPolicyPluginPath } from "./managed-policy-plugin.js";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { OPENWORK_AGENT_PROMPT } from "./openwork-agent-prompt.js";
import { catalogFastVariants, fastVariantId } from "@openwork/types/cloud-model-fast";

import {
  buildOpenworkRuntimeConfig,
  buildOpenworkRuntimeConfigObjectFromSnapshot,
  keepOpenworkRuntimeConfigFileFresh,
  openworkRuntimeConfigFilePath,
  writeOpenworkRuntimeConfigFile,
} from "./openwork-runtime-config.js";
import { readGlobalRuntimeOpencodeConfig, writeManagedDesktopPolicy, writeGlobalRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];
let previousDb: string | undefined;

afterEach(async () => {
  while (cleanups.length) cleanups.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
  else process.env.OPENWORK_RUNTIME_DB = previousDb;
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "openwork-runtime-config-file-"));
  roots.push(root);
  previousDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  return { root, config };
}

async function readConfigFile(config: ServerConfig): Promise<Record<string, unknown>> {
  const raw = await readFile(openworkRuntimeConfigFilePath(config), "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

describe("openwork runtime config file", () => {
  test("v1 receives the shared host-gated native connection question prompt", () => {
    expect(buildOpenworkRuntimeConfigObjectFromSnapshot({})).toMatchObject({
      agent: { openwork: { prompt: OPENWORK_AGENT_PROMPT } },
    });
    expect(OPENWORK_AGENT_PROMPT).toContain("context.features.connectionQuestions === true");
  });

  test("a verified \"Only models you provide\" setting limits the engine while signed in; signing out lifts it; execution stays suspended", async () => {
    const { config } = await setup();
    const provider = { ollama: { models: { "local-model": { name: "Local model" } } }, lpr_team: { models: { team: { name: "Team" } } } };
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({ ...current, provider }));
    const policyDocument = {
      allowCustomProviders: false, allowZenModel: false,
      execution: { commands: "deny" as const, blockedCommands: [], blockBrowserUploads: false },
    };
    const den = Bun.serve({ port: 0, fetch: () => Response.json(policyDocument) });
    cleanups.push(() => den.stop(true));
    const policy = managedDesktopPolicy(config);
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, token: "test-token", orgId: "test-org" });
    await policy.current();
    await writeOpenworkRuntimeConfigFile(config);
    const restricted = await readConfigFile(config);
    // OpenCode Zen is not part of model access, so allowZenModel changes nothing here.
    expect(restricted.enabled_providers).toEqual(["lpr_team", "opencode"]);
    expect(restricted.provider).toEqual(provider);
    // Execution rules and every other desktop policy stay suspended.
    expect(restricted.permission).toEqual({});
    await expect(policy.assert("provider", { providerID: "ollama" })).rejects.toMatchObject({ status: 403, code: "organization_policy_denied" });
    await expect(policy.assert("model", { providerID: "ollama", modelID: "local-model" })).rejects.toMatchObject({ status: 403, code: "organization_model_denied" });
    await expect(policy.assert("model", { providerID: "lpr_team", modelID: "team" })).resolves.toBeUndefined();
    await expect(policy.assert("shell", { command: "curl https://example.com" })).resolves.toBeUndefined();
    await expect(policy.assert("file_write", { filePath: "/tmp/opencode.json" })).resolves.toBeUndefined();

    // A cached policy is not device enrollment: signing out ends enforcement (#5131).
    await policy.clearSession();
    expect((await readGlobalRuntimeOpencodeConfig(config)).managedPolicy).toBeUndefined();
    await expect(policy.assert("provider", { providerID: "ollama" })).resolves.toBeUndefined();
    await expect(policy.assert("model", { providerID: "ollama", modelID: "local-model" })).resolves.toBeUndefined();
    await writeOpenworkRuntimeConfigFile(config);
    const signedOut = await readConfigFile(config);
    expect(signedOut.enabled_providers).toBeUndefined();
    expect(signedOut.provider).toEqual(provider);
  });

  test("model access is enforced on engine sign-in and sends, keeps the last verified policy when Den drops, and never parses non-JSON bodies", async () => {
    const { config } = await setup();
    let down = false;
    const den = Bun.serve({ port: 0, fetch: () => down ? new Response(null, { status: 503 }) : Response.json({ allowCustomProviders: false, allowZenModel: true }) });
    cleanups.push(() => den.stop(true));
    const policy = managedDesktopPolicy(config);
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, token: "test-token", orgId: "test-org" });
    await policy.current();
    const post = (path: string, body?: unknown) => policy.assertRequest(new Request(`http://localhost${path}`, {
      method: "POST", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) }), path, true);
    await expect(post("/opencode/auth/ollama")).rejects.toMatchObject({ code: "organization_policy_denied" });
    await expect(post("/opencode/provider/anthropic/oauth/authorize")).rejects.toMatchObject({ code: "organization_policy_denied" });
    await expect(post("/opencode/session/s1/prompt_async", { model: { providerID: "ollama", modelID: "local" } })).rejects.toMatchObject({ code: "organization_model_denied" });
    await expect(post("/opencode2/api/session/s1/message", { model: { providerID: "lpr_team", id: "team" } })).resolves.toBeUndefined();
    await expect(post("/opencode/session/s1/prompt_async", { model: { providerID: "opencode", modelID: "big-pickle" } })).resolves.toBeUndefined();
    await expect(post("/opencode/session/s1/prompt_async", "not json")).resolves.toBeUndefined();
    await expect(policy.assertRequest(new Request("http://localhost/opencode/auth/ollama"), "/opencode/auth/ollama", true)).resolves.toBeUndefined();
    // Adding managed providers (cloud imports) and removing any provider stay allowed; adding a personal one does not.
    await expect(policy.assert("provider", { providerIDs: ["lpr_team", "ipr_gateway", "openwork"] })).resolves.toBeUndefined();
    await expect(policy.assert("provider", { providerIDs: [] })).resolves.toBeUndefined();
    await expect(policy.assert("provider", { providerIDs: ["lpr_team", "personal"] })).rejects.toMatchObject({ code: "organization_policy_denied" });
    // Den going down never unlocks personal providers for this sign-in, and never blocks managed ones.
    down = true;
    await policy.current();
    await expect(policy.assert("model", { providerID: "ollama" })).rejects.toMatchObject({ code: "organization_model_denied" });
    await expect(policy.assert("model", { providerID: "ipr_gateway" })).resolves.toBeUndefined();
  });

  test("without a restrictive policy, sends are never read or held", async () => {
    const { config } = await setup();
    const den = Bun.serve({ port: 0, fetch: () => Response.json({ allowCustomProviders: true }) });
    cleanups.push(() => den.stop(true));
    const policy = managedDesktopPolicy(config);
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, token: "test-token", orgId: "test-org" });
    await policy.current();
    let read = false;
    const body = new ReadableStream({ pull(controller) { read = true; controller.close(); } }, { highWaterMark: 0 });
    const send = new Request("http://localhost/opencode/session/s1/prompt_async", { method: "POST", body, duplex: "half" } as RequestInit);
    await expect(policy.assertRequest(send, "/opencode/session/s1/prompt_async", true)).resolves.toBeUndefined();
    expect(read).toBe(false);
  });

  for (const onlyProvidedModels of [true, false]) test(`Zen is not part of model access ${onlyProvidedModels ? "with" : "without"} \"Only models you provide\"`, async () => {
    const { config } = await setup();
    const den = Bun.serve({ port: 0, fetch: () => Response.json({ allowCustomProviders: !onlyProvidedModels, allowZenModel: false }) });
    cleanups.push(() => den.stop(true));
    const policy = managedDesktopPolicy(config);
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, token: "test-token", orgId: "test-org" });
    await policy.current();
    await expect(policy.assert("model", { providerID: "opencode" })).resolves.toBeUndefined();
    await expect(policy.assert("model", { providerID: "ipr_gateway" })).resolves.toBeUndefined();
    if (onlyProvidedModels) await expect(policy.assert("model", { providerID: "anthropic" })).rejects.toMatchObject({ code: "organization_model_denied" });
    else {
      await expect(policy.assert("model", { providerID: "anthropic" })).resolves.toBeUndefined();
      // Nothing to enforce, so nothing is cached for the engine.
      expect((await readGlobalRuntimeOpencodeConfig(config)).managedPolicy).toBeUndefined();
    }
    await policy.clearSession();
  });

  test("a first policy read that fails leaves the desktop fully usable", async () => {
    const { config } = await setup();
    const den = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 503 }) });
    cleanups.push(() => den.stop(true));
    const policy = managedDesktopPolicy(config);
    await policy.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, token: "test-token", orgId: "test-org" });
    await policy.current();
    expect(await policy.current()).toBeNull();
    await expect(policy.assert("provider", { providerID: "ollama" })).resolves.toBeUndefined();
    await expect(policy.assert("model", { providerID: "ollama" })).resolves.toBeUndefined();
  });

  test("\"Only models you provide\" lists the organization's providers for the engine, and keeps Zen as it is", () => {
    const provider = { lpr_legacy: {}, ipr_gateway: {}, openwork: {}, personal: {}, opencode: {} };
    expect(buildOpenworkRuntimeConfigObjectFromSnapshot({
      managedPolicy: { allowCustomProviders: false, allowZenModel: false }, provider,
    }).enabled_providers).toEqual(["lpr_legacy", "ipr_gateway", "openwork", "opencode"]);
    expect(buildOpenworkRuntimeConfigObjectFromSnapshot({
      managedPolicy: { allowCustomProviders: false }, provider,
    }).enabled_providers).toEqual(["lpr_legacy", "ipr_gateway", "openwork", "opencode"]);
    const zenOff = buildOpenworkRuntimeConfigObjectFromSnapshot({ managedPolicy: { allowZenModel: false }, provider, disabled_providers: ["anthropic"] });
    expect(zenOff.enabled_providers).toBeUndefined();
    expect(zenOff.disabled_providers).toEqual(["anthropic"]);
    expect(buildOpenworkRuntimeConfigObjectFromSnapshot({ managedPolicy: { allowCustomProviders: true }, provider }).enabled_providers).toBeUndefined();
    expect(buildOpenworkRuntimeConfigObjectFromSnapshot({ provider }).enabled_providers).toBeUndefined();
  });

  test("expands Fast for the pinned v1 engine only in the emitted config", () => {
    const variants = catalogFastVariants({
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      experimental: { modes: { fast: { provider: { body: { service_tier: "priority" } } } } },
    }, "@ai-sdk/openai");
    const snapshot = { provider: { lpr_synthetic: { npm: "@ai-sdk/openai", models: { "gpt-6-astra": { variants } } } } };
    const before = JSON.stringify(snapshot);
    const rendered = buildOpenworkRuntimeConfigObjectFromSnapshot(snapshot);
    expect(rendered).toMatchObject({ provider: { lpr_synthetic: { models: { "gpt-6-astra": { variants: {
      high: { reasoningEffort: "high" },
      [fastVariantId("high")]: { reasoningEffort: "high", serviceTier: "priority" },
      [fastVariantId("low")]: { reasoningEffort: "low", serviceTier: "priority" },
      [fastVariantId(null)]: { serviceTier: "priority" },
    } } } } } });
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(JSON.stringify(rendered.provider)).not.toContain("openworkNativeFast");
  });
  test("managed execution restrictions are omitted while user permissions and plugins survive", () => {
    const parsed = buildOpenworkRuntimeConfigObjectFromSnapshot({
      permission: { external_directory: { "*": "ask" } },
      plugin: [managedPolicyPluginPath(), pathToFileURL(managedPolicyPluginPath(true)).href,
        "ordinary-plugin", "/user/plugins/managed-policy.ts"],
      managedPolicy: {
        execution: {
          commands: "deny", blockedCommands: ["curl *"],
          browserOrigins: ["https://approved.example"], blockBrowserUploads: true,
        },
      },
    });
    expect(parsed.permission).toEqual({ external_directory: { "*": "ask" } });
    expect(parsed.agent).toMatchObject({ openwork: { permission: { skill: { "customize-opencode": "deny" } } } });
    expect(parsed.managedPolicy).toBeUndefined();
    expect(parsed.plugin).not.toContain(managedPolicyPluginPath());
    expect(parsed.plugin).not.toContain(pathToFileURL(managedPolicyPluginPath(true)).href);
    expect(parsed.plugin).toContain("ordinary-plugin");
    expect(parsed.plugin).toContain("/user/plugins/managed-policy.ts");
    expect(buildOpenworkRuntimeConfigObjectFromSnapshot({}).permission).toEqual({});
  });

  test("writes global-row MCPs and openwork defaults into the file", async () => {
    const { config } = await setup();
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      mcp: {
        posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true },
        "openwork-connect-stale": { type: "remote", url: "https://cloud.example/stale", enabled: true },
      },
    }));

    const { path } = await writeOpenworkRuntimeConfigFile(config);
    expect(path).toBe(openworkRuntimeConfigFilePath(config));

    const parsed = await readConfigFile(config);
    const mcp = parsed.mcp as Record<string, Record<string, unknown>>;
    expect(mcp.posthog?.enabled).toBe(true);
    expect(mcp["openwork-connect-stale"]).toBeUndefined();
    expect(parsed.default_agent).toBe("openwork");
    expect(Array.isArray(parsed.plugin)).toBe(true);
    if (!Array.isArray(parsed.plugin)) throw new Error("Expected runtime plugins");
    expect(parsed.plugin).not.toContain("opencode-chrome-devtools");
    expect(parsed.plugin.some(
      (plugin) => typeof plugin === "string" && /openwork-chrome-devtools\.(?:ts|js)$/.test(plugin),
    )).toBe(true);
    expect(parsed.agent).toMatchObject({
      openwork: {
        permission: {
          skill: {
            "customize-opencode": "deny",
            "get-started": "deny",
            "command-creator": "deny",
            "agent-creator": "deny",
            "plugin-creator": "deny",
          },
        },
      },
    });
  });

  test("workspace runtime rows never reach the injected file", async () => {
    const { config } = await setup();
    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp", enabled: true } },
    }));

    await writeOpenworkRuntimeConfigFile(config);

    const parsed = await readConfigFile(config);
    const mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
    expect(mcp.posthog).toBeUndefined();
  });

  test("openwork prompt states identity, repo memory, artifacts, and Connect routing once, without the removed Memory Bank", async () => {
    const { config } = await setup();
    await writeOpenworkRuntimeConfigFile(config);

    const parsed = await readConfigFile(config);
    const agent = parsed.agent as Record<string, { prompt?: string }>;
    const prompt = agent.openwork?.prompt ?? "";

    expect(prompt.startsWith("You are OpenWork.")).toBe(true);
    expect(prompt).toContain("## Memory\n");
    expect(prompt).toContain("## OpenWork Artifacts");
    expect(prompt).toContain("## Connected work");
    // Den removed the Memory Bank; the prompt must not teach capabilities that
    // the live catalog can no longer return.
    expect(prompt).not.toContain("Memory Bank");
    expect(prompt).not.toContain("postMemory");
    expect(prompt).not.toContain("getMemorySearch");
    // Connect tool names appear exactly once each, in the base prompt's own
    // routing paragraph; the diagnostics prompt markers key on them.
    expect(prompt.match(/openwork-cloud_search_capabilities/g)).toHaveLength(1);
    expect(prompt.match(/openwork-cloud_execute_capability/g)).toHaveLength(1);
    expect(prompt).not.toContain("2-4 keyword variants");
    // Skill capture defers to the runtime skill-authoring mode instead of
    // contradicting it with a workspace-only default.
    expect(prompt).toContain("`Skill creation:` instruction");
    expect(prompt).not.toContain("factor them into a skill");
  });

  test("keepOpenworkRuntimeConfigFileFresh rewrites the file on ENGINE_GLOBAL writes", async () => {
    const { config } = await setup();
    await writeOpenworkRuntimeConfigFile(config);
    cleanups.push(keepOpenworkRuntimeConfigFileFresh(config));

    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      mcp: { stripe: { type: "remote", url: "https://mcp.stripe.com", enabled: false } },
    }));

    // The refresh is fire-and-forget; poll briefly for the rewrite.
    let mcp: Record<string, Record<string, unknown>> = {};
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const parsed = await readConfigFile(config);
      mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
      if (mcp.stripe) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(mcp.stripe?.enabled).toBe(false);
  });

  test("workspace runtime writes do not rewrite the file", async () => {
    const { config } = await setup();
    await writeOpenworkRuntimeConfigFile(config);
    cleanups.push(keepOpenworkRuntimeConfigFileFresh(config));

    await writeRuntimeOpencodeConfig(config, "ws_1", (current) => ({
      ...current,
      mcp: { other: { type: "remote", url: "https://example.com/mcp", enabled: true } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const parsed = await readConfigFile(config);
    const mcp = (parsed.mcp ?? {}) as Record<string, Record<string, unknown>>;
    expect(mcp.other).toBeUndefined();
  });

  test("builds byte-stable config for repeated snapshots", async () => {
    const { config } = await setup();
    await writeGlobalRuntimeOpencodeConfig(config, (current) => ({
      ...current,
      mcp: { posthog: { type: "remote", url: "https://mcp.posthog.com/mcp" } },
    }));

    const first = await buildOpenworkRuntimeConfig(config);
    const second = await buildOpenworkRuntimeConfig(config);

    expect(second).toBe(first);
  });

  test("builds byte-stable config for equivalent snapshots with different key order", async () => {
    const { config } = await setup();
    await writeGlobalRuntimeOpencodeConfig(config, () => ({
      mcp: {
        zeta: { url: "https://z.example/mcp", type: "remote" },
        alpha: { type: "remote", url: "https://a.example/mcp" },
      },
      provider: {
        zeta: { npm: "@ai-sdk/openai-compatible", name: "Zeta" },
        alpha: { name: "Alpha", npm: "@ai-sdk/openai-compatible" },
      },
    }));
    const first = await buildOpenworkRuntimeConfig(config);

    await writeGlobalRuntimeOpencodeConfig(config, () => ({
      provider: {
        alpha: { npm: "@ai-sdk/openai-compatible", name: "Alpha" },
        zeta: { name: "Zeta", npm: "@ai-sdk/openai-compatible" },
      },
      mcp: {
        alpha: { url: "https://a.example/mcp", type: "remote" },
        zeta: { type: "remote", url: "https://z.example/mcp" },
      },
    }));
    const second = await buildOpenworkRuntimeConfig(config);

    expect(second).toBe(first);
  });
});
