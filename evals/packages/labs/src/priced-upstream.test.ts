import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";

const script = fileURLToPath(new URL("./priced-upstream.mjs", import.meta.url));
const key = "priced-upstream-test-key";
let base = "";
let child: ReturnType<typeof spawn> | undefined;

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function completion(authorization: string, body: Record<string, unknown> = {}) {
  return fetch(`${base}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization },
    body: JSON.stringify({ model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), PRICED_UPSTREAM_KEY: key, PRICED_UPSTREAM_COST_USD: "1.5" },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (!await fetch(`${base}/health`).then((response) => response.ok).catch(() => false)) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error("priced upstream did not start");
    await delay(50);
  }
});

afterAll(() => { child?.kill("SIGTERM"); });

it("answers a completion with the fixed reported cost", async () => {
  const response = await completion(`Bearer ${key}`);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({
    model: "openai/gpt-4o-mini",
    choices: [{ message: { role: "assistant", content: "Complete" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24, cost: 1.5 },
  });
});

it("refuses other keys and streaming, and records every call it receives", async () => {
  expect((await completion("Bearer someone-else")).status).toBe(401);
  expect((await completion(`Bearer ${key}`, { stream: true })).status).toBe(400);
  const log: unknown = await fetch(`${base}/requests`).then((response) => response.json());
  expect(log).toEqual([
    { path: "/api/v1/chat/completions", model: "openai/gpt-4o-mini", authenticated: true },
    { path: "/api/v1/chat/completions", model: "openai/gpt-4o-mini", authenticated: false },
    { path: "/api/v1/chat/completions", model: "openai/gpt-4o-mini", authenticated: true },
  ]);
});

it("refuses to start without a key", async () => {
  const failed = spawn(process.execPath, [script], { env: { PATH: process.env.PATH, PORT: "0" }, stdio: "ignore" });
  const code = await new Promise<number | null>((resolve) => failed.once("exit", resolve));
  expect(code).not.toBe(0);
});
