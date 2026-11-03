import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CloudProviderSync, type CloudProviderDenSession } from "../src/cloud-provider-sync.js";
import { EnvService } from "../src/env-file.js";
import { buildOpenWorkV2Instructions } from "../src/opencode-v2-instructions.js";
import { OPENWORK_AGENT_PROMPT } from "../src/openwork-agent-prompt.js";
import { buildOpenworkRuntimeConfigObject } from "../src/openwork-runtime-config.js";
import { readGlobalRuntimeOpencodeConfig, writeGlobalRuntimeOpencodeConfig } from "../src/runtime-opencode-config-store.js";
import type { ServerConfig } from "../src/types.js";

const session: CloudProviderDenSession = { baseUrl: "https://example.invalid/api/den", token: "den-test-secret", orgId: "org_test" };

function config(dir: string): ServerConfig {
  return { host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false };
}

type PromptsReply = { status: number; body?: unknown } | "network_error";

/** A Den with no providers whose /v1/me/prompts answers whatever `reply` currently holds. */
function denWithPrompts(reply: { current: PromptsReply }) {
  return Object.assign(async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
    if (path.endsWith("/llm-providers")) return Response.json({ llmProviders: [] });
    if (path.endsWith("/inference-providers")) return Response.json({ inferenceProviders: [] });
    if (path.endsWith("/auto-router/connect")) return Response.json({ error: "not_found" }, { status: 404 });
    if (path.endsWith("/me/prompts")) {
      if (reply.current === "network_error") throw new Error("connection refused");
      return Response.json(reply.current.body ?? { error: "feature_disabled" }, { status: reply.current.status });
    }
    throw new Error(`unexpected request ${path}`);
  }, { preconnect: fetch.preconnect });
}

async function withSync(run: (input: { sync: CloudProviderSync; dir: string; reply: { current: PromptsReply } }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "openwork-prompts-"));
  const reply: { current: PromptsReply } = { current: { status: 200, body: { prompts: [] } } };
  const sync = new CloudProviderSync({
    config: config(dir), env: new EnvService({ path: join(dir, "env.json") }),
    reloadEngine: async () => ({ action: "updated_live" }), fetchImpl: denWithPrompts(reply),
  });
  try {
    await run({ sync, dir, reply });
  } finally {
    sync.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

const orderedPrompts = { prompts: [
  { id: "osp_everyone", source: "organization", content: "Everyone prompt" },
  { id: "osp_design", source: "team", teamName: "Design", content: "Design prompt" },
] };

test("provider sync stores the organization's prompts and both engines append them to OpenWork's instructions", async () => {
  await withSync(async ({ sync, dir, reply }) => {
    reply.current = { status: 200, body: orderedPrompts };
    await sync.setSession(session);
    const result = await sync.run("test");
    assert.equal(result.status, "applied");
    assert.equal(sync.status().lastRun?.detail?.promptChanged, true);

    const runtime = await readGlobalRuntimeOpencodeConfig(config(dir));
    assert.equal(runtime.managedPrompt, "Everyone prompt\n\nDesign prompt");

    const engineConfig = await buildOpenworkRuntimeConfigObject(config(dir));
    const expected = `${OPENWORK_AGENT_PROMPT}\n\n## Organization instructions\n\nEveryone prompt\n\nDesign prompt`;
    assert.equal(Object(Object(engineConfig.agent).openwork).prompt, expected);
    assert.equal("managedPrompt" in engineConfig, false, "the prompt is never an engine config key");

    const v2 = buildOpenWorkV2Instructions(true, runtime.managedPrompt);
    assert.ok(v2.operatingInstructions.endsWith("## Organization instructions\n\nEveryone prompt\n\nDesign prompt"));
    assert.ok(v2.operatingInstructions.startsWith("You are OpenWork."));

    // The same prompts again are not a change.
    assert.equal((await sync.run("test")).status, "noop");
  });
});

test("ordinary runtime config writes keep the stored prompts", async () => {
  await withSync(async ({ sync, dir, reply }) => {
    reply.current = { status: 200, body: orderedPrompts };
    await sync.setSession(session);
    await sync.run("test");
    await writeGlobalRuntimeOpencodeConfig(config(dir), (current) => ({ ...current, plugin: ["example-plugin"] }));
    assert.equal((await readGlobalRuntimeOpencodeConfig(config(dir))).managedPrompt, "Everyone prompt\n\nDesign prompt");
  });
});

test("an unreachable Den keeps the last prompts; Prompts turned off or an older Den removes them", async () => {
  await withSync(async ({ sync, dir, reply }) => {
    reply.current = { status: 200, body: orderedPrompts };
    await sync.setSession(session);
    await sync.run("test");

    reply.current = "network_error";
    assert.notEqual((await sync.run("test")).status, "failed", "a prompts failure never fails provider sync");
    assert.equal((await readGlobalRuntimeOpencodeConfig(config(dir))).managedPrompt, "Everyone prompt\n\nDesign prompt");

    reply.current = { status: 500 };
    await sync.run("test");
    assert.equal((await readGlobalRuntimeOpencodeConfig(config(dir))).managedPrompt, "Everyone prompt\n\nDesign prompt");

    reply.current = { status: 404 };
    await sync.run("test");
    assert.equal((await readGlobalRuntimeOpencodeConfig(config(dir))).managedPrompt, undefined);
    const engineConfig = await buildOpenworkRuntimeConfigObject(config(dir));
    assert.equal(Object(Object(engineConfig.agent).openwork).prompt, OPENWORK_AGENT_PROMPT);
  });
});

test("signing out removes the organization's prompts", async () => {
  await withSync(async ({ sync, dir, reply }) => {
    reply.current = { status: 200, body: orderedPrompts };
    await sync.setSession(session);
    await sync.run("test");
    await sync.clearSession();
    assert.equal((await readGlobalRuntimeOpencodeConfig(config(dir))).managedPrompt, undefined);
  });
});
