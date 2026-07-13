import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "enterprise-mcp-wire-history";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const ADMIN_USERNAME = "diagnostics-proof-admin";
const ADMIN_PASSWORD = `proof-admin-${randomBytes(24).toString("hex")}`;
const BEARER_TOKEN = `proof-client-${randomBytes(24).toString("hex")}`;
const SIGNING_SECRET = `proof-signing-${randomBytes(32).toString("hex")}`;
const PRIVATE_ARGUMENT = `private-argument-${randomBytes(20).toString("hex")}`;

const state = {
  child: null,
  origin: null,
  output: "",
};

function safeOutput(value) {
  return String(value)
    .replaceAll(ADMIN_PASSWORD, "[REDACTED]")
    .replaceAll(BEARER_TOKEN, "[REDACTED]")
    .replaceAll(SIGNING_SECRET, "[REDACTED]")
    .replaceAll(PRIVATE_ARGUMENT, "[REDACTED]")
    .slice(-8_000);
}

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function stopChild(signal = "SIGTERM") {
  if (!state.child || state.child.exitCode !== null || state.child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && state.child.pid) process.kill(-state.child.pid, signal);
    else state.child.kill(signal);
  } catch {
    // The proof process may have already exited.
  }
}

async function startDiagnostics(ctx) {
  const port = await freeLoopbackPort();
  state.origin = `http://127.0.0.1:${port}`;
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  state.child = spawn(command, ["--filter", "@openwork-ee/diagnostics", "dev"], {
    cwd: ROOT,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      DIAGNOSTICS_ADMIN_PASSWORD: ADMIN_PASSWORD,
      DIAGNOSTICS_ADMIN_USERNAME: ADMIN_USERNAME,
      DIAGNOSTICS_MCP_BEARER_TOKEN: BEARER_TOKEN,
      DIAGNOSTICS_PORT: String(port),
      DIAGNOSTICS_PROFILE: "microsoft",
      DIAGNOSTICS_SIGNING_SECRET: SIGNING_SECRET,
      NEXT_PUBLIC_DIAGNOSTICS_ORIGIN: state.origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const remember = (chunk) => {
    state.output = safeOutput(`${state.output}${String(chunk)}`);
  };
  state.child.stdout?.on("data", remember);
  state.child.stderr?.on("data", remember);
  process.once("exit", () => stopChild("SIGKILL"));

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${state.origin}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) break;
    } catch {
      // Wait for Next.js to become ready.
    }
    if (state.child.exitCode !== null) throw new Error(`Diagnostics exited before readiness.\n${state.output}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const ready = await fetch(`${state.origin}/health`).catch(() => null);
  ctx.assert(ready?.ok === true, `Diagnostics did not become ready.\n${state.output}`);

  await ctx.client.send("Network.enable");
  await ctx.client.send("Network.setExtraHTTPHeaders", {
    headers: { Authorization: `Basic ${Buffer.from(`${ADMIN_USERNAME}:${ADMIN_PASSWORD}`).toString("base64")}` },
  });
}

async function stopDiagnostics() {
  stopChild("SIGTERM");
  if (!state.child) return;
  await Promise.race([
    new Promise((resolve) => state.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  stopChild("SIGKILL");
}

async function navigate(ctx) {
  await ctx.client.send("Page.navigate", { url: state.origin });
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 20_000, label: "Diagnostics dashboard" });
}

async function handshake() {
  const endpoint = `${state.origin}/mcp`;
  const baseHeaders = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${BEARER_TOKEN}`,
    "content-type": "application/json",
  };
  const initialize = await fetch(endpoint, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: { capabilities: {}, clientInfo: { name: "fraimz-proof", version: "1" }, protocolVersion: "2025-11-25" },
    }),
    headers: baseHeaders,
    method: "POST",
  });
  const session = initialize.headers.get("mcp-session-id");
  const version = initialize.headers.get("mcp-protocol-version");
  if (!session || !version) throw new Error("Diagnostics did not issue an MCP session.");
  const headers = { ...baseHeaders, "mcp-protocol-version": version, "mcp-session-id": session };
  const messages = [
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
    { id: 3, jsonrpc: "2.0", method: "tools/call", params: { arguments: { query: PRIVATE_ARGUMENT }, name: "search_microsoft_365" } },
  ];
  const statuses = [initialize.status];
  for (const body of messages) {
    const response = await fetch(endpoint, { body: JSON.stringify(body), headers, method: "POST" });
    statuses.push(response.status);
  }
  return statuses;
}

function record(ctx, assertion, passed, actual) {
  ctx.recordEvidence({ assertion, actual, status: passed ? "passed" : "failed", type: "assertion" });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

export default {
  id: FLOW_ID,
  title: "A fixed enterprise MCP endpoint produces safe, specific wire history",
  kind: "user-facing",
  preserveTheme: true,
  precondition: async (ctx) => {
    await startDiagnostics(ctx);
    return null;
  },
  steps: [
    {
      name: "Successful MCP handshake",
      run: async (ctx) => {
        await ctx.prove("The complete synthetic MCP handshake is visible as four correlated exchanges", {
          voiceover: vo[0],
          action: async () => {
            ctx.handshakeStatuses = await handshake();
            await navigate(ctx);
          },
          assert: async () => {
            const view = await ctx.eval(`(() => ({
              count: document.querySelectorAll('article.exchange').length,
              endpoint: document.querySelector('.endpoint')?.textContent ?? '',
              statuses: [...document.querySelectorAll('.status')].map((item) => item.textContent?.trim()),
            }))()`);
            record(ctx, "The MCP client completed initialize, ready, catalog, and tool call", JSON.stringify(ctx.handshakeStatuses) === "[200,202,200,200]", ctx.handshakeStatuses);
            record(ctx, "The dashboard shows exactly four recent exchanges", view.count === 4, view);
            record(ctx, "The dashboard identifies the Microsoft-shaped fixed endpoint", view.endpoint.includes("microsoft") && view.endpoint.includes("/mcp"), view.endpoint);
          },
          screenshot: { name: "successful-handshake", requireText: ["Diagnostics", "4 recent exchanges", "HTTP 202"] },
        });
      },
    },
    {
      name: "Redacted request evidence",
      run: async (ctx) => {
        await ctx.prove("Protocol structure remains useful while private values are absent", {
          voiceover: vo[1],
          action: async () => {
            await ctx.eval(`(() => { const details = document.querySelector('details'); if (details) details.open = true; return Boolean(details); })()`);
          },
          assert: async () => {
            const html = await ctx.eval("document.documentElement.innerHTML");
            record(ctx, "The synthetic Bearer token is absent from rendered evidence", !html.includes(BEARER_TOKEN), "token absent");
            record(ctx, "The tool argument value is absent from rendered evidence", !html.includes(PRIVATE_ARGUMENT), "argument absent");
            record(ctx, "Session header values are represented only by a hash", !html.includes("mcp-session-id: ey") && html.includes("sha256:"), "session value absent; hash present");
          },
          screenshot: { name: "redacted-exchange", requireText: ["Request headers", "Request body", "VALUE REDACTED"] },
        });
      },
    },
    {
      name: "Specific incompatible-client failure",
      run: async (ctx) => {
        try {
          await ctx.prove("An invalid Streamable HTTP contract is identified as HTTP 406 not_acceptable", {
            voiceover: vo[2],
            action: async () => {
              const response = await fetch(`${state.origin}/mcp`, {
                body: JSON.stringify({ id: 9, jsonrpc: "2.0", method: "initialize", params: {} }),
                headers: { accept: "application/json", authorization: `Bearer ${BEARER_TOKEN}`, "content-type": "application/json" },
                method: "POST",
              });
              ctx.failureStatus = response.status;
              await navigate(ctx);
              await ctx.eval(`(() => { const details = document.querySelector('details'); if (details) details.open = true; return Boolean(details); })()`);
            },
            assert: async () => {
              const text = await ctx.eval("document.body.innerText");
              record(ctx, "The incompatible request returns HTTP 406", ctx.failureStatus === 406 && text.includes("HTTP 406"), ctx.failureStatus);
              record(ctx, "The safe response preview names not_acceptable", text.includes("not_acceptable"), "not_acceptable visible");
            },
            screenshot: { name: "specific-accept-failure", requireText: ["HTTP 406", "not_acceptable"] },
          });
        } finally {
          await stopDiagnostics();
        }
      },
    },
  ],
};
