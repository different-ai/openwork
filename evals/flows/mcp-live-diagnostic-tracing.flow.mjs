/**
 * Proves live Den-side tracing against the generic, ServiceNow, or Microsoft
 * enterprise mock profile. The flow discovers the exact MCP and OAuth paths
 * from /health instead of assuming the generic /mcp and /authorize routes.
 *
 * Generic:
 *   pnpm dev:mcp-diagnostic
 * Enterprise profile (the local UI proof intentionally enables mock DCR):
 *   MCP_MOCK_ENABLE_DCR=1 pnpm dev:mcp-diagnostic -- --profile servicenow
 *   MCP_MOCK_ENABLE_DCR=1 pnpm dev:mcp-diagnostic -- --profile microsoft-enterprise
 */
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { connect, debuggerUrlFor, evaluate, listTargets } from "../runner/cdp.mjs";
import { denApiFetch, denWebUrl, openAdminConnections, signInApi } from "./lib/den-web.mjs";

const vo = await loadVoiceoverParagraphs("mcp-live-diagnostic-tracing");
const DEMO_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const DEMO_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MOCK_DIAGNOSTICS_KEY = process.env.MCP_MOCK_DIAGNOSTICS_KEY?.trim() || null;

function configuredMockPort() {
  const explicit = process.env.MCP_DIAGNOSTIC_MOCK_PORT?.trim();
  const isolated = process.env.OPENWORK_EXTRA_APP_PORTS?.split(",")[0]?.trim();
  const raw = explicit || isolated || "3978";
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid MCP diagnostic mock port: ${JSON.stringify(raw)}.`);
  }
  return port;
}

function mockServerOrigin() {
  const explicit = process.env.MOCK_OAUTH_MCP_URL?.trim()
    || process.env.MOCK_DIAGNOSTIC_MCP_URL?.trim();
  if (explicit) return new URL(explicit).origin;
  return `http://127.0.0.1:${configuredMockPort()}`;
}

const MOCK_SERVER_URL = mockServerOrigin();
const PROFILE_LABELS = {
  generic: "Generic",
  servicenow: "ServiceNow",
  workiq: "Microsoft Work IQ",
  "microsoft-enterprise": "Microsoft Enterprise",
  "agent365-mail": "Microsoft Agent 365 Mail",
};

const state = {
  adminToken: null,
  connectionId: null,
  connectionName: null,
  mockHealth: null,
  authorizationEndpoint: null,
  mcpUrl: null,
  recoveryProtocolVersion: null,
};

async function configureMock(path, body) {
  const response = await fetch(`${MOCK_SERVER_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(MOCK_DIAGNOSTICS_KEY ? { "x-mock-diagnostics-key": MOCK_DIAGNOSTICS_KEY } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Mock configuration failed: ${response.status}`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function readMockHealth(value) {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error(`The deterministic OAuth MCP fixture is not healthy at ${MOCK_SERVER_URL}.`);
  }
  const contract = isRecord(value.fixtureContract) ? value.fixtureContract : null;
  const oauthEndpoints = contract && isRecord(contract.oauthEndpoints) ? contract.oauthEndpoints : null;
  const protocols = Array.isArray(value.protocols)
    ? value.protocols.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];
  if (typeof value.profile !== "string"
    || typeof value.resource !== "string"
    || typeof value.endpoint !== "string"
    || typeof oauthEndpoints?.authorization !== "string"
    || typeof oauthEndpoints?.token !== "string"
    || protocols.length === 0
  ) {
    throw new Error("The mock /health response is missing endpoint, OAuth, or protocol metadata required by this proof.");
  }
  if (contract?.mockRegistrationMode !== "dynamic") {
    throw new Error(
      `The ${value.profile} profile requires its explicit local DCR override for this UI proof. `
      + "Restart the mock with MCP_MOCK_ENABLE_DCR=1; production provider registration behavior remains unchanged.",
    );
  }
  return {
    ...value,
    fixtureContract: contract,
    protocols,
    resource: new URL(value.resource).toString(),
    authorizationEndpoint: new URL(oauthEndpoints.authorization).toString(),
    tokenEndpoint: new URL(oauthEndpoints.token).toString(),
  };
}

function rowButtonScript(label) {
  return `(() => {
    const leaf = [...document.querySelectorAll('p, span')]
      .find((element) => (element.textContent ?? '').trim() === ${JSON.stringify(state.connectionName)});
    if (!leaf) return false;
    let row = leaf;
    for (let depth = 0; depth < 7 && row; depth += 1) {
      const button = [...row.querySelectorAll('button')]
        .find((candidate) => (candidate.textContent ?? '').trim() === ${JSON.stringify(label)});
      if (button) {
        row.scrollIntoView({ block: 'center' });
        button.click();
        return true;
      }
      row = row.parentElement;
    }
    return false;
  })()`;
}

function witness(ctx, condition, assertion, actual) {
  ctx.assert(condition, assertion);
  ctx.recordEvidence({ type: "assertion", status: "passed", assertion, actual });
}

async function signInViaCurrentDenFlow(ctx, email, password) {
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000 });
  await ctx.eval("fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true).catch(() => true)", { awaitPromise: true });
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
  await ctx.waitFor('Boolean(document.querySelector(\'input[type="email"]\'))', { timeoutMs: 30_000, label: "email field" });
  await ctx.fill('input[type="email"]', email);

  const hasPassword = await ctx.eval('Boolean(document.querySelector(\'input[type="password"]\'))');
  if (!hasPassword) {
    const advanced = await ctx.eval(`(() => {
      const button = document.querySelector('button[type="submit"]')
        ?? [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Next');
      button?.click();
      return Boolean(button);
    })()`);
    witness(ctx, advanced, "The account flow advances from email identification to password authentication.");
    await ctx.waitFor('Boolean(document.querySelector(\'input[type="password"]\'))', { timeoutMs: 30_000, label: "password field" });
  }

  await ctx.fill('input[type="password"]', password);
  const submitted = await ctx.eval(`(() => {
    const button = document.querySelector('button[type="submit"]');
    button?.click();
    return Boolean(button);
  })()`);
  witness(ctx, submitted, "The owner submits the Den sign-in form.");
  await ctx.waitFor(`(() => {
    const text = document.body?.textContent ?? '';
    return text.includes('Dashboard') || text.includes('Signed in as');
  })()`, { timeoutMs: 30_000, label: "authenticated account or dashboard" });
  const needsAccountContinuation = await ctx.eval("!(document.body?.textContent ?? '').includes('Dashboard')");
  if (needsAccountContinuation) {
    const continued = await ctx.eval(`(() => {
      const button = document.querySelector('button[type="submit"]')
        ?? [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Next');
      button?.click();
      return Boolean(button);
    })()`);
    witness(ctx, continued, "The authenticated account continues into its Den dashboard.");
  }
  await ctx.waitForText("Dashboard", { timeoutMs: 30_000 });
}

async function approveExistingOAuthPopup(ctx) {
  let target;
  const deadline = Date.now() + 10_000;
  while (!target && Date.now() < deadline) {
    target = (await listTargets(ctx.cdpBaseUrl)).find((entry) => (
      entry.type === "page"
      && entry.webSocketDebuggerUrl
      && (() => {
        try {
          const actual = new URL(entry.url);
          const expected = new URL(state.authorizationEndpoint);
          return actual.origin === expected.origin
            && actual.pathname === expected.pathname
            && actual.searchParams.get("redirect_uri")?.includes(state.connectionId ?? "missing-connection");
        } catch {
          return false;
        }
      })()
    ));
    if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  witness(ctx, Boolean(target), "The diagnostic opened the provider authorization page in a separate tab.");
  const client = await connect(debuggerUrlFor(ctx.cdpBaseUrl, target));
  try {
    const clicked = await evaluate(client, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((entry) => (entry.textContent ?? '').trim() === 'Approve OpenWork');
      button?.click();
      return Boolean(button);
    })()`);
    witness(ctx, clicked, "The administrator approves the MCP OAuth request in the provider tab.");
    const callbackPath = `/v1/mcp-connections/${state.connectionId}/connect/callback`;
    let callbackObserved = false;
    const callbackDeadline = Date.now() + 10_000;
    while (!callbackObserved && Date.now() < callbackDeadline) {
      try {
        const currentUrl = await evaluate(client, "location.href");
        callbackObserved = new URL(currentUrl).pathname === callbackPath;
      } catch {
        // The static callback page closes the provider tab after success.
        callbackObserved = true;
      }
      if (!callbackObserved) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    witness(ctx, callbackObserved, "The provider redirects the approved grant to Den's connection callback.");
  } finally {
    client.close();
  }
}

export default {
  id: "mcp-live-diagnostic-tracing",
  title: "Den shows the first failing enterprise MCP layer live without exposing credentials",
  kind: "user-facing",
  spec: "evals/voiceovers/mcp-live-diagnostic-tracing.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup — publish an unconnected enterprise-style MCP endpoint",
      run: async (ctx) => {
        const healthResponse = await fetch(`${MOCK_SERVER_URL}/health`).catch(() => null);
        witness(ctx, Boolean(healthResponse?.ok), `The deterministic OAuth MCP fixture is reachable at ${MOCK_SERVER_URL}.`, {
          status: healthResponse?.status ?? null,
        });
        state.mockHealth = readMockHealth(await healthResponse.json());
        state.mcpUrl = state.mockHealth.resource;
        state.authorizationEndpoint = state.mockHealth.authorizationEndpoint;
        state.recoveryProtocolVersion = state.mockHealth.protocols[0];
        const profileLabel = PROFILE_LABELS[state.mockHealth.profile] || state.mockHealth.profile;
        state.connectionName = `Diagnostic ${profileLabel} ${Date.now()}`;
        witness(
          ctx,
          new URL(state.mcpUrl).pathname === state.mockHealth.endpoint,
          `The ${profileLabel} proof uses the exact MCP endpoint advertised by /health.`,
          { profile: state.mockHealth.profile, endpoint: state.mockHealth.endpoint },
        );
        witness(
          ctx,
          new URL(state.authorizationEndpoint).origin === new URL(state.mockHealth.tokenEndpoint).origin,
          `The ${profileLabel} proof discovered coherent mock OAuth authorization and token metadata.`,
          { profile: state.mockHealth.profile },
        );
        await configureMock("/__mock/auto-approve", { autoApprove: false });
        await configureMock("/__mock/protocol-version", { protocolVersion: "2099-01-01" });
        state.adminToken = await signInApi(DEMO_EMAIL, DEMO_PASSWORD);
        witness(ctx, Boolean(state.adminToken), `The demo owner can sign in as ${DEMO_EMAIL}.`);
        const created = await denApiFetch("/v1/mcp-connections", {
          method: "POST",
          headers: { authorization: `Bearer ${state.adminToken}` },
          body: JSON.stringify({
            name: state.connectionName,
            url: state.mcpUrl,
            authType: "oauth",
            credentialMode: "per_member",
            access: { orgWide: true, memberIds: [], teamIds: [] },
          }),
        });
        witness(ctx, created.response.ok && typeof created.body?.id === "string", "The external MCP connection is published without storing a user token.", {
          status: created.response.status,
        });
        state.connectionId = created.body.id;
      },
    },
    {
      name: "Frame 1 — Open Den-side diagnostic mode",
      run: async (ctx) => {
        await ctx.prove("The diagnostic explicitly runs from the Den server", {
          voiceover: vo[0],
          action: async () => {
            await signInViaCurrentDenFlow(ctx, DEMO_EMAIL, DEMO_PASSWORD);
            await openAdminConnections(ctx);
            await ctx.waitForText(state.connectionName, { timeoutMs: 30_000 });
            const clicked = await ctx.eval(rowButtonScript("Diagnose"));
            witness(ctx, clicked, "The enterprise MCP row exposes the admin-only Diagnose action.");
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"mcp-diagnostic-dialog\"]'))", { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText("This test runs from the Den server");
            await ctx.expectText("never tokens, authorization codes, session IDs, tool arguments, or customer content");
          },
          screenshot: {
            name: "mcp-diagnostic-den-boundary",
            requireText: ["Diagnose", "This test runs from the Den server", "HIGHEST HEALTH", "FIRST FAILURE"],
            rejectText: ["access_token", "refresh_token", "authorization_code"],
          },
        });
      },
    },
    {
      name: "Frame 2 — Watch the live handshake phases",
      run: async (ctx) => {
        await ctx.prove("The timeline advances through network and OAuth phases with timings", {
          voiceover: vo[1],
          action: async () => {
            await ctx.clickText("Run diagnostic", { timeoutMs: 10_000 });
            await ctx.waitForText("Auth User Or Workload", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText("Network Dns");
            await ctx.expectText("Network Tcp");
            await ctx.expectText("Http Routing");
            await ctx.expectText("Auth Resource Discovery");
            await ctx.expectText("waiting for administrator authorization");
            await ctx.expectText("Continue authorization");
          },
          screenshot: {
            name: "mcp-diagnostic-live-oauth-timeline",
            requireText: ["Live connection timeline", "Network Dns", "Http Routing", "Auth Resource Discovery", "Auth User Or Workload", "Continue authorization"],
            rejectText: ["mock-code", "mock-access", "MCP-Session-Id"],
          },
        });
      },
    },
    {
      name: "Frame 3 — Preserve health and name the first failure",
      run: async (ctx) => {
        await ctx.prove("A version mismatch preserves Authorized as the highest pass and MCP Version as the first failure", {
          voiceover: vo[2],
          action: async () => {
            await ctx.trustedClick('[data-testid="mcp-diagnostic-continue-authorization"]', { timeoutMs: 10_000 });
            await approveExistingOAuthPopup(ctx);
            await ctx.waitFor("document.querySelector('[data-testid=\"mcp-diagnostic-health\"]')?.textContent?.includes('Authorized')", { timeoutMs: 45_000 });
            await ctx.waitFor("document.querySelector('[data-testid=\"mcp-diagnostic-first-failure\"]')?.textContent?.includes('Mcp Version')", { timeoutMs: 20_000 });
          },
          assert: async () => {
            await ctx.expectText("Authorized");
            await ctx.expectText("Mcp Version");
            await ctx.expectText("did not agree on a supported stable MCP revision");
          },
          screenshot: {
            name: "mcp-diagnostic-first-version-failure",
            requireText: ["Authorized", "Mcp Version", "supported stable MCP revision"],
            rejectText: ["MCP failed", "Invalid credentials. Try again."],
          },
        });
      },
    },
    {
      name: "Frame 4 — Inspect redacted support evidence",
      run: async (ctx) => {
        await ctx.prove("Support evidence is actionable and contains no credential or customer payload", {
          voiceover: vo[3],
          action: async () => {
            await ctx.eval("document.querySelector('[data-testid=\"mcp-diagnostic-remediation\"]')?.scrollIntoView({ block: 'center' })");
          },
          assert: async () => {
            const text = await ctx.eval("document.querySelector('[data-testid=\"mcp-diagnostic-dialog\"]')?.textContent ?? ''");
            witness(ctx, !/mock-(access|refresh|code)|MCP-Session-Id|Synthetic incident/i.test(text), "The visible support record contains no token, code, session ID, or provider content.");
            await ctx.expectText("Action: Align Provider And Client Mcp Versions");
            await ctx.expectText("Support evidence is strictly redacted and retained for 24 hours");
          },
          screenshot: {
            name: "mcp-diagnostic-redacted-remediation",
            requireText: ["Action:", "Support evidence is strictly redacted", "retained for 24 hours"],
            rejectText: ["mock-access", "mock-refresh", "mock-code", "Synthetic incident"],
          },
        });
      },
    },
    {
      name: "Frame 5 — Retry to catalog ready",
      run: async (ctx) => {
        await ctx.prove("After the provider is corrected, the same panel reaches Catalog Ready without claiming an operation test", {
          voiceover: vo[4],
          action: async () => {
            await configureMock("/__mock/protocol-version", { protocolVersion: state.recoveryProtocolVersion });
            await ctx.clickText("Run again", { timeoutMs: 10_000 });
            await ctx.waitFor("document.querySelector('[data-testid=\"mcp-diagnostic-health\"]')?.textContent?.includes('Catalog Ready')", { timeoutMs: 45_000 });
          },
          assert: async () => {
            await ctx.expectText("Catalog Ready");
            await ctx.expectText("The complete tool catalog is available");
            await ctx.expectText("does not claim that a provider operation or mutation was tested");
          },
          screenshot: {
            name: "mcp-diagnostic-catalog-ready",
            requireText: ["Catalog Ready", "complete tool catalog", "does not claim that a provider operation or mutation was tested"],
            rejectText: ["Connection failed"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        await configureMock("/__mock/auto-approve", { autoApprove: true });
        await configureMock("/__mock/protocol-version", {
          protocolVersion: state.recoveryProtocolVersion || "2025-06-18",
        });
        if (!state.connectionId || !state.adminToken) return;
        const removed = await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${state.adminToken}` },
        });
        witness(ctx, removed.response.ok, "The diagnostic fixture connection is removed after proof.", { status: removed.response.status });
      },
    },
  ],
};
