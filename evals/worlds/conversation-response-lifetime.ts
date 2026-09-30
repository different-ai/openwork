import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import type { Seed } from "@openwork/env";
import { close, isRecord, listen, sendJson, stopChild } from "./openwork-server-cli.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const serverRoot = join(repoRoot, "apps", "server");
const sessionId = "ses_response_lifetime";
const messagePayload = [{ info: { id: "msg_proof", sessionID: sessionId, role: "assistant" }, parts: [{ type: "text", text: "The conversation is ready." }] }];

function nodeGcPreload(): string {
  const source = `
    import { appendFileSync } from "node:fs";
    process.on("SIGUSR2", () => {
      globalThis.gc?.();
      appendFileSync(process.env.OPENWORK_GC_ACK, "collected\\n");
    });
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}

async function waitForServer(child: ChildProcess, sink: (text: string) => void): Promise<string> {
  let output = "";
  return new Promise<string>((resolveBase, reject) => {
    const timer = setTimeout(() => reject(new Error(`openwork-server did not start:\n${output.slice(-2_000)}`)), 60_000);
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      sink(text);
      const match = output.match(/OpenWork server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolveBase(match[1]);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`openwork-server exited before listening (${code}):\n${output.slice(-2_000)}`));
    });
  });
}

async function workspaceId(base: string, token: string): Promise<string> {
  const response = await fetch(`${base}/workspaces`, { headers: { authorization: `Bearer ${token}` } });
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload.items)) throw new Error("OpenWork returned no workspace list");
  const item = payload.items[0];
  if (!isRecord(item) || typeof item.id !== "string") throw new Error("OpenWork returned no workspace id");
  return item.id;
}

export async function conversationResponseLifetime(seed: Seed) {
  const scratch = seed.tmpPath("conversation-response-lifetime");
  const workspace = join(scratch, "workspace");
  const home = join(scratch, "home");
  const gcAck = join(scratch, "gc-ack.txt");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(gcAck, "");

  const engineRequests: string[] = [];
  const engine: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://engine.test");
    engineRequests.push(url.pathname);
    if (url.pathname === `/session/${sessionId}`) {
      setTimeout(() => sendJson(response, 200, {
        id: sessionId,
        directory: workspace,
        title: "Response lifetime proof",
        time: { created: 1, updated: 1 },
      }), 250);
      return;
    }
    if (url.pathname === `/session/${sessionId}/message`) {
      sendJson(response, 200, messagePayload);
      return;
    }
    sendJson(response, 200, []);
  });

  let child: ChildProcess | null = null;
  let output = "";
  const dispose = async () => {
    if (child) await stopChild(child);
    await close(engine);
    await rm(scratch, { recursive: true, force: true });
  };

  try {
    const engineBase = await listen(engine);
    const build = spawnSync("pnpm", ["--filter", "openwork-server", "build"], {
      cwd: repoRoot,
      env: process.env,
      encoding: "utf8",
      timeout: 180_000,
    });
    if (build.status !== 0) throw new Error(`openwork-server build failed:\n${build.stdout}\n${build.stderr}`);

    const token = "response-lifetime-token";
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE") && !key.startsWith("OPENWORK_")));
    child = spawn(process.execPath, [
      "--expose-gc",
      "--import", nodeGcPreload(),
      "dist/cli.js",
      "--host", "127.0.0.1",
      "--port", "0",
      "--token", token,
      "--host-token", `${token}-host`,
      "--approval", "auto",
      "--cors", "*",
      "--workspace", workspace,
    ], {
      cwd: serverRoot,
      env: {
        ...inherited,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        OPENWORK_OPENCODE_BASE_URL: engineBase,
        OPENWORK_OPENCODE_DIRECTORY: workspace,
        OPENWORK_GC_ACK: gcAck,
        OPENWORK_LOG_REQUESTS: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const base = await waitForServer(child, (text) => { output += text; });
    const id = await workspaceId(base, token);
    const headers = { authorization: `Bearer ${token}` };

    return {
      ordering: { ownershipDelayMs: 250, message: "immediate" },
      engineRequests,
      async reopen(attempts = 24) {
        const url = `${base}/workspace/${encodeURIComponent(id)}/opencode/session/${sessionId}/message`;
        const reads = Array.from({ length: attempts }, () => fetch(url, {
          headers,
          signal: AbortSignal.timeout(10_000),
        }).then(async (response) => ({ status: response.status, body: await response.text() })));
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        for (let index = 0; index < 5; index += 1) {
          child?.kill("SIGUSR2");
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
        const results = await Promise.all(reads);
        const gcRuns = (await readFile(gcAck, "utf8")).trim().split("\n").filter(Boolean).length;
        return { results, gcRuns, output };
      },
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
