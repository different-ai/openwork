import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Seed } from "@openwork/env";
import { close, isRecord, listen, sendJson } from "./openwork-server-cli.ts";
import { writeClaudeAgentExecutable } from "./claude-agent-executable.ts";

type Scenario = "disabled" | "logged-out" | "saved" | "missing";

/** Real app + upstream v2 integration, isolated HOME, synthetic Claude executable.
 * The signed-out deployment changes only the rollout response, never engine APIs. */
async function claudeAgentProvider(seed: Seed, scenario: Scenario) {
  const enabled = scenario !== "disabled";
  const deployment = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("access-control-allow-origin", request.headers.origin ?? "*");
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("access-control-allow-headers", "authorization,content-type");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (path === "/v1/features") return sendJson(response, 200, { features: { claudeAgentProvider: enabled } });
    if (path === "/api/auth/get-session") return sendJson(response, 200, null);
    sendJson(response, 404, { error: { message: "Unexpected deployment route" } });
  });
  const origin = await listen(deployment);
  try {
    const folder = seed.tmpPath(`claude-agent-${scenario}`);
    await mkdir(folder, { recursive: true });
    const workspacePath = await realpath(folder);
    const auditPath = join(workspacePath, "claude-audit.jsonl");
    const executable = join(workspacePath, "synthetic-claude.mjs");
    if (scenario !== "missing") await writeClaudeAgentExecutable(executable, auditPath, scenario === "saved" ? "oauth" : "none");
    // In the missing-installation world, discovery must not find a developer's
    // real Claude on PATH. Expose only the launcher's non-Claude executables.
    const toolBin = join(workspacePath, "bin");
    await mkdir(toolBin);
    for (const name of ["node", "bun", "pnpm"]) {
      const source = execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();
      await symlink(source, join(toolBin, name));
    }
    const token = randomUUID();
    const app = await seed.appWeb({
      den: { apiUrl: origin, webUrl: origin }, name: `claude-agent-${scenario}`, workspacePath, engine: "v2", headless: true,
      env: {
        OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: randomUUID(), OPENWORK_DISABLE_FREE_INFERENCE: "1",
        OPENCODE_CLAUDE_PATH: scenario === "missing" ? "" : executable,
        PATH: `${toolBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        ...(process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {}),
      },
    });
    const workspace = await seed.workspace(app, workspacePath);
    const nativeUrl = `${app.openworkUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode2/api`;
    return {
      app, workspace,
      settingsUrl: `${app.webUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/settings/ai`,
      async integration() {
        // Upstream initializes built-in provider integrations lazily on the
        // catalog read; a cold single-item read can otherwise answer 404.
        const catalog = await fetch(`${nativeUrl}/integration`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
        });
        if (!catalog.ok) throw new Error(`Native integration catalog: HTTP ${catalog.status}`);
        await catalog.body?.cancel();
        const response = await fetch(`${nativeUrl}/integration/claude-agent`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`Native integration read: HTTP ${response.status}`);
        const body: unknown = await response.json();
        if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.connections)) throw new Error("Invalid native integration response");
        return body.data.connections.filter(isRecord);
      },
      async audit() {
        const text = await readFile(auditPath, "utf8").catch(error => { if (isRecord(error) && error.code === "ENOENT") return ""; throw error; });
        return text.trim().split("\n").filter(Boolean).map(line => {
          const event: unknown = JSON.parse(line);
          if (!isRecord(event)) throw new Error("Invalid executable audit");
          return event;
        });
      },
      async [Symbol.asyncDispose]() { await close(deployment); },
    };
  } catch (error) {
    await close(deployment);
    throw error;
  }
}

export const claudeAgentDisabled = (seed: Seed) => claudeAgentProvider(seed, "disabled");
export const claudeAgentLoggedOut = (seed: Seed) => claudeAgentProvider(seed, "logged-out");
export const claudeAgentSaved = (seed: Seed) => claudeAgentProvider(seed, "saved");
export const claudeAgentMissing = (seed: Seed) => claudeAgentProvider(seed, "missing");
