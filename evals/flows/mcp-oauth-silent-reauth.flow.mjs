/**
 * Silent re-auth for remote OAuth MCP connectors (issue: "Sign in needed"
 * every ~1h / on app reopen even though the stored refresh token works).
 *
 * The OpenCode engine only refreshes MCP access tokens reactively — once per
 * transport — so an expired token or a transient outage at engine boot
 * strands the connector in "Sign in needed"/"Issue" until the user clicks
 * Sign in manually. OpenWork now heals this quietly: every MCP status
 * refresh retries `mcp.connect` for unhealthy remote OAuth entries, which
 * re-runs the refresh-token grant on a fresh transport without ever opening
 * a browser or modal (apps/app/src/react-app/domains/connections/mcp-silent-reauth.ts).
 *
 * This flow proves it end-to-end against a real OAuth MCP server
 * (scripts/mock-oauth-mcp-server.mjs — real authorization-code + PKCE +
 * refresh grants; in-memory access tokens so a restart invalidates them):
 *
 *   1. One-time interactive sign-in for a custom "Advanced OAuth"
 *      (pre-registered client) connector → Ready.
 *   2. The connector's API goes down and OpenWork "reopens" (engine
 *      restart) → connector is stranded (the reported bug state).
 *   3. The API comes back. With zero clicks beyond a status refresh, the
 *      connector flips back to Ready. Ground truth from the mock IdP's
 *      request log: exactly a refresh-token grant (POST /token) and NO
 *      interactive authorization (GET /authorize), no sign-in modal.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MOCK_PORT = 4517;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const MCP_NAME = "mock-oauth-crm";
const SERVER_SCRIPT = fileURLToPath(new URL("../../scripts/mock-oauth-mcp-server.mjs", import.meta.url));

let mockChild = null;

async function mockHealthy() {
  try {
    const response = await fetch(`${MOCK_BASE}/health`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startMock(ctx) {
  if (await mockHealthy()) {
    throw new Error(`Port ${MOCK_PORT} is already serving; stop it before running this flow.`);
  }
  mockChild = spawn(process.execPath, [SERVER_SCRIPT], {
    env: { ...process.env, PORT: String(MOCK_PORT) },
    stdio: "ignore",
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (await mockHealthy()) {
      ctx.log(`Mock OAuth MCP server up at ${MOCK_BASE}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Mock OAuth MCP server did not become healthy.");
}

async function stopMock(ctx) {
  if (!mockChild) return;
  mockChild.kill("SIGKILL");
  mockChild = null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5_000) {
    if (!(await mockHealthy())) {
      ctx.log("Mock OAuth MCP server stopped.");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Mock OAuth MCP server did not stop.");
}

async function mockRequests() {
  const response = await fetch(`${MOCK_BASE}/requests`, { signal: AbortSignal.timeout(2_000) });
  const payload = await response.json();
  return payload.requests ?? [];
}

// The connector row in Extensions -> "YOUR APPS": climb from the exact-name
// leaf to the row and report its friendly status label.
const CARD_STATUS_EXPR = `(() => {
  const leaves = [...document.querySelectorAll("*")].filter(
    (e) => e.children.length === 0 && (e.textContent ?? "").trim() === ${JSON.stringify(MCP_NAME)},
  );
  const labels = ["Ready", "Sign in needed", "Issue", "Offline", "Paused"];
  for (const leaf of leaves) {
    let node = leaf;
    for (let i = 0; i < 8 && node; i += 1) {
      const text = node.textContent ?? "";
      for (const label of labels) {
        if (text.includes(label)) return label;
      }
      node = node.parentElement;
    }
  }
  return null;
})()`;

async function cardStatus(ctx) {
  return ctx.eval(CARD_STATUS_EXPR);
}

// The connector card lives below the fold in Extensions; frames must show it.
async function scrollCardIntoView(ctx) {
  await ctx.eval(`(() => {
    const leaf = [...document.querySelectorAll("*")].find(
      (e) => e.children.length === 0 && (e.textContent ?? "").trim() === ${JSON.stringify(MCP_NAME)},
    );
    if (leaf) leaf.scrollIntoView({ block: "center" });
    return Boolean(leaf);
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function openExtensions(ctx) {
  await ctx.eval(`(() => {
    const hash = window.location.hash;
    const workspace = hash.match(/#\\/workspace\\/[^/]+/);
    window.location.hash = workspace
      ? workspace[0].slice(1) + "/settings/extensions/mcp"
      : "/settings/extensions/mcp";
    return true;
  })()`);
  await ctx.waitForText("Add Custom App", { timeoutMs: 30_000 });
}

async function refreshStatuses(ctx) {
  await ctx.eval(`(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Refresh");
    if (btn) btn.click();
    return Boolean(btn);
  })()`);
}

async function restartEngine(ctx) {
  await ctx.eval(
    'window.__OPENWORK_ELECTRON__.invokeDesktop("engineRestart", {})',
    { awaitPromise: true },
  );
  ctx.log("Engine restarted (simulates quitting and reopening OpenWork).");
  // Give the engine a moment to boot before the next status read.
  await new Promise((resolve) => setTimeout(resolve, 8_000));
}

async function waitForCardStatus(ctx, accepted, { timeoutMs, refreshEveryMs = 10_000 } = {}) {
  const startedAt = Date.now();
  let lastRefresh = 0;
  let status = null;
  while (Date.now() - startedAt < (timeoutMs ?? 60_000)) {
    if (Date.now() - lastRefresh >= refreshEveryMs) {
      lastRefresh = Date.now();
      await refreshStatuses(ctx);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    status = await cardStatus(ctx);
    if (accepted.includes(status)) return status;
  }
  throw new Error(`Timed out waiting for ${MCP_NAME} status in [${accepted.join(", ")}]; last: ${status}`);
}

export default {
  id: "mcp-oauth-silent-reauth",
  title: "Remote OAuth MCP silently re-authenticates after token expiry / app reopen",
  spec: "evals/browser-extension-flows.md",
  steps: [
    {
      name: "App booted with an open workspace",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000 });
        await ctx.waitFor("window.location.hash.includes('/workspace/')", {
          timeoutMs: 30_000,
          label: "an open workspace (this flow needs one to configure MCPs)",
        });
      },
    },
    {
      name: "Setup: start the mock OAuth MCP service",
      run: async (ctx) => {
        await startMock(ctx);
      },
    },
    {
      name: "Add the custom OAuth connector and sign in once (baseline)",
      run: async (ctx) => {
        await openExtensions(ctx);
        await refreshStatuses(ctx);
        await new Promise((resolve) => setTimeout(resolve, 2_000));

        if (!(await cardStatus(ctx))) {
          // Add Custom App -> Remote URL + Advanced OAuth (pre-registered client).
          await ctx.clickText("Add Custom App", { timeoutMs: 20_000 });
          await ctx.waitForText("Server URL", { timeoutMs: 15_000 });
          await ctx.fill('input[placeholder="github-copilot"]', MCP_NAME);
          await ctx.fill('input[placeholder="https://api.githubcopilot.com/mcp/"]', `${MOCK_BASE}/mcp`);
          await ctx.clickText("Advanced OAuth", { timeoutMs: 10_000 });
          await ctx.fill('input[placeholder="Paste the OAuth client ID"]', "openwork-eval-preregistered-client");
          await ctx.clickText("Add App", { timeoutMs: 10_000 });
          // A sign-in modal may auto-open; the row's Sign in button below is
          // the canonical path, so close it if present.
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          await ctx.eval(`(() => {
            const dlg = document.querySelector("[role=dialog]");
            const cancel = dlg && [...dlg.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Cancel");
            if (cancel) cancel.click();
            return true;
          })()`);
        }

        // Fresh entries can need an engine reload before they register.
        let status = await waitForCardStatus(ctx, ["Ready", "Sign in needed", "Issue", "Offline"], { timeoutMs: 30_000 });
        if (status === "Offline" || status === "Issue") {
          await restartEngine(ctx);
          await openExtensions(ctx);
          status = await waitForCardStatus(ctx, ["Ready", "Sign in needed"], { timeoutMs: 45_000 });
        }

        if (status !== "Ready") {
          // Expand the row and run the one-time interactive OAuth sign-in.
          await ctx.clickText(MCP_NAME, { selector: "button", timeoutMs: 15_000 });
          await ctx.clickText("Sign in", { timeoutMs: 15_000 });
          await waitForCardStatus(ctx, ["Ready"], { timeoutMs: 60_000 });
        }

        await ctx.prove("The custom OAuth connector is connected after a one-time sign-in", {
          assert: async () => {
            ctx.assert((await cardStatus(ctx)) === "Ready", "Connector card should show Ready.");
            await scrollCardIntoView(ctx);
          },
          screenshot: {
            name: "connector-connected-baseline",
            claim: "mock-oauth-crm shows Ready after the initial OAuth sign-in.",
            requireText: [MCP_NAME, "Ready"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Token expires and the API is unreachable while OpenWork reopens",
      run: async (ctx) => {
        // Restarting the mock wipes its in-memory access tokens (= expiry);
        // stopping it entirely reproduces the wake-from-sleep outage.
        await stopMock(ctx);
        await restartEngine(ctx);
        await openExtensions(ctx);

        await ctx.prove("The connector is stranded after reopening during an outage (the reported bug state)", {
          assert: async () => {
            const status = await waitForCardStatus(ctx, ["Issue", "Sign in needed"], { timeoutMs: 60_000 });
            ctx.log(`Stranded status: ${status}`);
            await scrollCardIntoView(ctx);
          },
          screenshot: {
            name: "connector-stranded",
            claim: "mock-oauth-crm is unhealthy (Issue / Sign in needed) after the engine reconnect failed.",
            requireText: [MCP_NAME],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "API returns; OpenWork silently re-authenticates with the stored refresh token",
      run: async (ctx) => {
        await startMock(ctx); // fresh instance: old access tokens invalid, request log empty

        await ctx.prove("The connector heals to Ready with no sign-in modal and no browser", {
          assert: async () => {
            // Status refreshes trigger the silent reauth; the cooldown means
            // the first eligible attempt can land up to ~60s after the
            // engine-restart attempt that fired while the API was down.
            await waitForCardStatus(ctx, ["Ready"], { timeoutMs: 180_000 });
            const modalOpen = await ctx.eval("Boolean(document.querySelector('[role=dialog]'))");
            ctx.assert(!modalOpen, "No sign-in modal should open during the silent reauth.");

            // Ground truth from the IdP: reconnection used the refresh-token
            // grant (POST /token) and never the interactive authorization
            // endpoint (GET /authorize).
            const requests = await mockRequests();
            const tokenGrants = requests.filter((r) => r.path === "/token").length;
            const interactive = requests.filter((r) => r.path === "/authorize").length;
            ctx.recordEvidence({
              type: "assertion",
              status: tokenGrants >= 1 && interactive === 0 ? "passed" : "failed",
              assertion: `IdP saw refresh grant only (POST /token x${tokenGrants}, GET /authorize x${interactive})`,
            });
            ctx.assert(tokenGrants >= 1, "Expected at least one refresh-token grant at the IdP.");
            ctx.assert(interactive === 0, "Silent reauth must not hit the interactive /authorize endpoint.");
            await scrollCardIntoView(ctx);
          },
          screenshot: {
            name: "connector-silently-healed",
            claim: "mock-oauth-crm is Ready again — reconnected via refresh-token grant, zero user interaction.",
            requireText: [MCP_NAME, "Ready"],
            rejectText: ["Something went wrong", "Connect mock-oauth-crm"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Cleanup: stop the mock OAuth MCP service",
      run: async (ctx) => {
        await stopMock(ctx);
      },
    },
  ],
};
