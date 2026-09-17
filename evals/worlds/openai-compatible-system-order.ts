import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { SkipError, type Seed } from "@openwork/env";
import { writeGlobalRuntimeOpencodeConfig } from "../../apps/server/src/runtime-opencode-config-store.ts";
import type { ServerConfig } from "../../apps/server/src/types.ts";
import {
  bootManagedOpenworkServer,
  close,
  engineBinary,
  isRecord,
  listen,
  readBody,
  sendJson,
  sendStream,
} from "./openwork-server-cli.ts";

export const REPLY = "The ordered request was accepted.";
export const MARKERS = {
  agent: "ORDER_PROJECT_AGENTS",
  skill: "ORDER_SKILL_CATALOG",
  perTurn: "ORDER_PER_TURN_SYSTEM",
  pluginOne: "ORDER_RUNTIME_PLUGIN_ONE",
  pluginTwo: "ORDER_RUNTIME_PLUGIN_TWO",
  user: "ORDER_USER_MESSAGE",
};

export type ObservedRequest = {
  roles: string[];
  systemIndexes: number[];
  systemText: string;
  userText: string;
  rejected: boolean;
};

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("\n");
}

function serverConfig(scratch: string, workspace: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    configPath: join(scratch, "server.json"),
    token: "system-order-config-token",
    hostToken: "system-order-host-token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_system_order", name: "System order", path: workspace, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspace],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

export async function openAICompatibleSystemOrder(seed: Seed) {
  const binary = engineBinary();
  if (!binary) throw new SkipError("set OPENWORK_OPENCODE_BIN or install opencode");
  const root = seed.tmpPath("openai-compatible-system-order");
  await mkdir(root, { recursive: true });
  const scratch = await realpath(root);
  const workspace = join(scratch, "workspace");
  const skillDir = join(workspace, ".opencode", "skills", "system-order-witness");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(workspace, "AGENTS.md"), `${MARKERS.agent}\nProject instructions stay at system priority.\n`);
  await writeFile(join(skillDir, "SKILL.md"), [
    "---",
    "name: system-order-witness",
    `description: ${MARKERS.skill}`,
    "---",
    "# System order witness",
  ].join("\n"));

  const runtimePlugin = join(scratch, "runtime-prefix-plugin.ts");
  await writeFile(runtimePlugin, [
    "export const RuntimePrefixPlugin = async () => ({",
    "  \"experimental.chat.system.transform\": async (_input, output) => {",
    `    output.system.push(${JSON.stringify(MARKERS.pluginOne)}, ${JSON.stringify(MARKERS.pluginTwo)});`,
    "  },",
    "});",
  ].join("\n"));

  const runtimeDb = join(scratch, "runtime.sqlite");
  const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
  delete process.env.OPENWORK_RUNTIME_DB;
  try {
    await writeGlobalRuntimeOpencodeConfig(serverConfig(scratch, workspace), (current) => ({
      ...current,
      plugin: [runtimePlugin],
    }));
  } finally {
    if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
  }

  const requests: ObservedRequest[] = [];
  const witness = createServer((request, response) => {
    void (async () => {
      if (request.method !== "POST") return sendJson(response, 200, { data: [] });
      const body: unknown = JSON.parse(await readBody(request));
      if (!isRecord(body) || !Array.isArray(body.messages)) return sendJson(response, 400, {});
      const messages = body.messages.filter(isRecord);
      const roles = messages.map((message) => typeof message.role === "string" ? message.role : "");
      const systemIndexes = roles.flatMap((role, index) => role === "system" ? [index] : []);
      const rejected = systemIndexes.some((index) => index > 0);
      requests.push({
        roles,
        systemIndexes,
        systemText: messages.filter((message) => message.role === "system").map((message) => textContent(message.content)).join("\n"),
        userText: messages.filter((message) => message.role === "user").map((message) => textContent(message.content)).join("\n"),
        rejected,
      });
      if (rejected) {
        return sendJson(response, 400, { error: { message: "System message must be at the beginning." } });
      }
      return sendStream(response, [
        { id: "resp_system_order", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: REPLY }, finish_reason: null }] },
        { id: "resp_system_order", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]);
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, {});
      else response.end();
    });
  });
  const witnessUrl = await listen(witness);
  await writeFile(join(workspace, "opencode.json"), JSON.stringify({
    provider: {
      strict: {
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${witnessUrl}/v1`, apiKey: "system-order-witness-key" },
        models: {
          "strict-system-order": {
            name: "Strict system order",
            reasoning: false,
            temperature: true,
            tool_call: true,
            limit: { context: 32_768, output: 4_096 },
          },
        },
      },
    },
  }));

  const token = "system-order-test-client";
  let managed: Awaited<ReturnType<typeof bootManagedOpenworkServer>> | undefined;
  const dispose = async () => {
    await managed?.stop();
    await close(witness);
    await rm(scratch, { recursive: true, force: true });
  };
  try {
    managed = await bootManagedOpenworkServer({
      scratch,
      workspace,
      token,
      binary,
      env: { OPENWORK_RUNTIME_DB: runtimeDb },
      sink: () => undefined,
    });
    return {
      engine: managed.engine,
      requests,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
