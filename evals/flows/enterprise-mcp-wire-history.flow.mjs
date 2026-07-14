import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
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
  await ctx.client.send("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: 900,
    mobile: false,
    width: 1200,
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

async function navigate(ctx, runId = null) {
  const url = runId ? `${state.origin}/?runId=${encodeURIComponent(runId)}` : state.origin;
  await ctx.client.send("Page.navigate", { url });
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 20_000, label: "Diagnostics dashboard" });
}

async function diagnosticRequest(pathname, runId, step, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-openwork-diagnostic-run-id", runId);
  headers.set("x-openwork-diagnostic-step", step);
  headers.set(
    "x-openwork-diagnostic-signature",
    createHmac("sha256", BEARER_TOKEN).update(`openwork-diagnostics-v1\n${runId}\n${step}`).digest("hex"),
  );
  return fetch(`${state.origin}${pathname}`, { ...init, headers });
}

async function runControlledDiagnostic() {
  const runId = randomUUID();
  const statuses = [];
  statuses.push((await diagnosticRequest("/diagnostics/egress", runId, "reachability-get")).status);
  statuses.push((await diagnosticRequest("/diagnostics/egress", runId, "http-head", { method: "HEAD" })).status);
  statuses.push((await diagnosticRequest("/diagnostics/egress", runId, "http-options", { method: "OPTIONS" })).status);
  statuses.push((await diagnosticRequest("/diagnostics/egress", runId, "http-post", {
    body: JSON.stringify({ probe: "openwork-egress-diagnostic" }),
    headers: { authorization: `Bearer ${BEARER_TOKEN}`, "content-type": "application/json" },
    method: "POST",
  })).status);
  const redirect = await diagnosticRequest("/diagnostics/redirect", runId, "redirect-start", { redirect: "manual" });
  statuses.push(redirect.status);
  const redirectUrl = new URL(redirect.headers.get("location"), state.origin);
  statuses.push((await diagnosticRequest(`${redirectUrl.pathname}${redirectUrl.search}`, runId, "redirect-complete")).status);
  statuses.push((await diagnosticRequest("/.well-known/oauth-protected-resource/mcp", runId, "oauth-protected-resource")).status);
  statuses.push((await diagnosticRequest("/.well-known/oauth-authorization-server", runId, "oauth-authorization-server")).status);
  const tokenResponse = await diagnosticRequest("/oauth/token", runId, "oauth-token", {
    body: new URLSearchParams({ grant_type: "client_credentials", resource: `${state.origin}/mcp`, scope: "diagnostics:connectivity" }),
    headers: {
      authorization: `Basic ${Buffer.from(`openwork-diagnostics:${BEARER_TOKEN}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });
  statuses.push(tokenResponse.status);
  const tokenBody = await tokenResponse.json();
  const accessToken = tokenBody.access_token;

  const endpoint = `${state.origin}/mcp`;
  const baseHeaders = {
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    "x-openwork-diagnostic-run-id": runId,
    "x-openwork-diagnostic-step": "mcp-initialize",
    "x-openwork-diagnostic-signature": createHmac("sha256", BEARER_TOKEN)
      .update(`openwork-diagnostics-v1\n${runId}\nmcp-initialize`)
      .digest("hex"),
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
  statuses.push(initialize.status);
  const steps = ["mcp-initialized", "mcp-tools-list", "mcp-tools-call"];
  for (const [index, body] of messages.entries()) {
    const step = steps[index];
    const response = await fetch(endpoint, {
      body: JSON.stringify(body),
      headers: {
        ...headers,
        "x-openwork-diagnostic-step": step,
        "x-openwork-diagnostic-signature": createHmac("sha256", BEARER_TOKEN)
          .update(`openwork-diagnostics-v1\n${runId}\n${step}`)
          .digest("hex"),
      },
      method: "POST",
    });
    statuses.push(response.status);
  }
  return { accessToken, runId, statuses };
}

function record(ctx, assertion, passed, actual) {
  ctx.recordEvidence({ assertion, actual, status: passed ? "passed" : "failed", type: "assertion" });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

export default {
  id: FLOW_ID,
  title: "A private-cloud Den run produces a correlated HTTP, OAuth, and MCP support story",
  kind: "user-facing",
  preserveTheme: true,
  precondition: async (ctx) => {
    await startDiagnostics(ctx);
    return null;
  },
  steps: [
    {
      name: "Administrator sign-in",
      run: async (ctx) => {
        await ctx.prove("The dashboard uses an application sign-in instead of browser-native authentication", {
          voiceover: vo[0],
          action: async () => {
            await navigate(ctx);
          },
          assert: async () => {
            const view = await ctx.eval(`(() => ({
              form: Boolean(document.querySelector('form.login-form')),
              password: document.querySelector('input[name="password"]')?.getAttribute('autocomplete') ?? '',
              username: document.querySelector('input[name="username"]')?.getAttribute('autocomplete') ?? '',
            }))()`);
            record(ctx, "An unauthenticated browser is redirected to the Diagnostics sign-in form", view.form, view);
            record(ctx, "The sign-in fields expose the correct password-manager semantics", view.username === "username" && view.password === "current-password", view);
          },
          screenshot: { name: "administrator-sign-in", requireText: ["Sign in", "Username", "Password"] },
        });
        await ctx.eval(`(() => {
          const username = document.querySelector('input[name="username"]');
          const password = document.querySelector('input[name="password"]');
          const form = document.querySelector('form.login-form');
          if (!(username instanceof HTMLInputElement) || !(password instanceof HTMLInputElement) || !(form instanceof HTMLFormElement)) return false;
          username.value = ${JSON.stringify(ADMIN_USERNAME)};
          password.value = ${JSON.stringify(ADMIN_PASSWORD)};
          form.requestSubmit();
          return true;
        })()`);
        await ctx.waitFor("!document.querySelector('form.login-form') && Boolean(document.querySelector('.hero'))", { timeoutMs: 20_000, label: "Authenticated Diagnostics dashboard" });
      },
    },
    {
      name: "One private-cloud run",
      run: async (ctx) => {
        await ctx.prove("One run ID groups every request that reached the public Diagnostics service", {
          voiceover: vo[1],
          action: async () => {
            ctx.diagnostic = await runControlledDiagnostic();
            await navigate(ctx, ctx.diagnostic.runId);
            await ctx.eval(`(() => { document.querySelector('.run-filter')?.scrollIntoView({ block: 'center' }); return true; })()`);
          },
          assert: async () => {
            const view = await ctx.eval(`(() => ({
              count: document.querySelectorAll('article.exchange').length,
              run: document.querySelector('.run-filter')?.textContent ?? '',
            }))()`);
            record(ctx, "All thirteen staged HTTP, redirect, OAuth, and MCP requests completed", JSON.stringify(ctx.diagnostic.statuses) === "[200,204,204,200,302,200,200,200,200,200,202,200,200]", ctx.diagnostic.statuses);
            record(ctx, "The support dashboard shows exactly thirteen exchanges for the run", view.count === 13, view);
            record(ctx, "The dashboard is filtered to the customer-provided run ID", view.run.includes(ctx.diagnostic.runId), view.run);
          },
          screenshot: { name: "correlated-run", requireText: ["Support trace", "13 recent exchanges"] },
        });
      },
    },
    {
      name: "OAuth boundary",
      run: async (ctx) => {
        await ctx.prove("OAuth discovery and token exchange are independently visible without exposing either secret", {
          voiceover: vo[2],
          action: async () => {
            await ctx.eval(`(() => {
              const article = [...document.querySelectorAll('article.exchange')].find((item) => item.textContent?.includes('oauth-token'));
              const details = article?.querySelector('details');
              if (details) details.open = true;
              article?.scrollIntoView({ block: 'center' });
              return Boolean(article);
            })()`);
          },
          assert: async () => {
            const html = await ctx.eval("document.documentElement.innerHTML");
            const text = await ctx.eval("document.body.innerText");
            record(ctx, "The OAuth token request is a separately attributed step", text.includes("POST /oauth/token") && text.includes("oauth-token"), "OAuth token step visible");
            record(ctx, "The shared diagnostic secret is absent from rendered evidence", !html.includes(BEARER_TOKEN), "secret absent");
            record(ctx, "The issued access token is absent from rendered evidence", !html.includes(ctx.diagnostic.accessToken), "access token value absent");
          },
          screenshot: { name: "oauth-boundary", requireText: ["POST /oauth/token", "oauth-token", "Request headers"] },
        });
      },
    },
    {
      name: "MCP boundary",
      run: async (ctx) => {
        await ctx.prove("MCP initialize, session continuity, catalog, and tool call remain separate diagnostic steps", {
          voiceover: vo[3],
          action: async () => {
            await ctx.eval(`(() => {
              const article = [...document.querySelectorAll('article.exchange')].find((item) => item.textContent?.includes('mcp-tools-call'));
              article?.scrollIntoView({ block: 'center' });
              return Boolean(article);
            })()`);
          },
          assert: async () => {
            const text = await ctx.eval("document.body.innerText");
            record(ctx, "The final MCP tool call is visible and successful", text.includes("mcp-tools-call") && text.includes("HTTP 200"), "MCP tool call visible");
            record(ctx, "The private synthetic tool argument is absent", !text.includes(PRIVATE_ARGUMENT), "tool argument absent");
          },
          screenshot: { name: "mcp-boundary", requireText: ["mcp-tools-call", "POST /mcp", "HTTP 200"] },
        });
      },
    },
    {
      name: "Specific proxy-style failure",
      run: async (ctx) => {
        try {
          await ctx.prove("A stripped authorization header is attributed to the authenticated POST step as HTTP 401", {
            voiceover: vo[4],
            action: async () => {
              ctx.failureRunId = randomUUID();
              const response = await diagnosticRequest("/diagnostics/egress", ctx.failureRunId, "http-post", {
                body: JSON.stringify({ probe: "openwork-egress-diagnostic" }),
                headers: { "content-type": "application/json" },
                method: "POST",
              });
              ctx.failureStatus = response.status;
              await navigate(ctx, ctx.failureRunId);
              await ctx.eval(`(() => { const article = document.querySelector('article.exchange'); article?.scrollIntoView({ block: 'center' }); return Boolean(article); })()`);
            },
            assert: async () => {
              const text = await ctx.eval("document.body.textContent");
              record(ctx, "The rejected authenticated POST returns HTTP 401", ctx.failureStatus === 401 && text.includes("HTTP 401"), ctx.failureStatus);
              record(ctx, "The support trace identifies the exact http-post stage", text.includes("http-post"), "http-post visible");
              record(ctx, "The safe response names unauthorized", text.includes("unauthorized"), "unauthorized visible");
            },
            screenshot: { name: "specific-auth-failure", requireText: ["HTTP 401", "http-post"] },
          });
        } finally {
          await stopDiagnostics();
        }
      },
    },
  ],
};
