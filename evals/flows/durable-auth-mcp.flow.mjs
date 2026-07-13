import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  denApiFetch,
  mcpAgentCall,
  mintMcpToken,
  openAdminConnections,
  signInApi,
  signInViaBrowser,
} from "./lib/den-web.mjs";

const FLOW_ID = "durable-auth-mcp";
const vo = await loadVoiceoverParagraphs(FLOW_ID);
const execFileAsync = promisify(execFile);

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
const DEN_BROWSER_API_URL = DEN_API_URL.replace("://127.0.0.1", "://localhost");
const DEMO_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const DEMO_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MYSQL_CONTAINER = process.env.OPENWORK_EVAL_DEN_MYSQL_CONTAINER?.trim() || "openwork-web-local-mysql";
const MOCK_PORT = Number(process.env.OPENWORK_EVAL_DURABLE_AUTH_MCP_PORT ?? 4521);
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const MOCK_SERVER_SCRIPT = fileURLToPath(new URL("../../scripts/mock-oauth-mcp-server.mjs", import.meta.url));
const RUN_TAG = Date.now();
const CONNECTION_PREFIX = "durable-auth-shared-";
const FIRST_CONNECTION = `${CONNECTION_PREFIX}baseline-${RUN_TAG}`;
const SECOND_CONNECTION = `${CONNECTION_PREFIX}stale-session-${RUN_TAG}`;
const ECHO_TEXT = `durable auth refresh ${RUN_TAG}`;
const LOCAL_DRAFT = "Local draft remains available while OpenWork Cloud reconnects";
const WORKSPACE_PATH = `/tmp/openwork-durable-auth-mcp-${RUN_TAG}`;
const COPY_INSTALL_LINK_SELECTOR = '[data-testid="copy-install-link"]';

const state = {
  adminSession: null,
  orgId: null,
  desktopToken: null,
  desktopSessionStats: null,
  workspaceId: null,
  workspacePrepared: false,
  firstConnectionId: null,
  secondConnectionId: null,
  mcpToken: null,
  browserSessionId: null,
  reauthDialogText: null,
  firstConsentStartedAt: null,
  secondConsentStartedAt: null,
  secondConnectionSkippedReauth: false,
  engineRestarted: false,
  legacyClientId: null,
};

let mockChild = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sqlString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function orgHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    "x-openwork-legacy-org-id": state.orgId,
  };
}

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

async function runMysql(ctx, sql) {
  const { stdout, stderr } = await execFileAsync("docker", [
    "exec",
    MYSQL_CONTAINER,
    "mysql",
    "-uroot",
    "-ppassword",
    "openwork_den",
    "-N",
    "-B",
    "-e",
    sql,
  ]);
  if (stderr.trim()) ctx.log(`mysql stderr: ${stderr.trim()}`);
  return stdout.trim();
}

async function mockHealthy() {
  try {
    const response = await fetch(`${MOCK_BASE}/health`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function startMock(ctx) {
  if (mockChild) return;
  ctx.assert(!(await mockHealthy()), `Port ${MOCK_PORT} is already serving. Stop that process before running ${FLOW_ID}.`);
  mockChild = spawn(process.execPath, [MOCK_SERVER_SCRIPT], {
    env: { ...process.env, PORT: String(MOCK_PORT), AUTO_APPROVE: "0" },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await mockHealthy()) return;
    await sleep(250);
  }
  throw new Error(`Mock OAuth MCP server did not start at ${MOCK_BASE}.`);
}

async function stopMock(ctx) {
  if (!mockChild) return;
  mockChild.kill("SIGKILL");
  mockChild = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await mockHealthy())) return;
    await sleep(200);
  }
  ctx.assert(false, `Mock OAuth MCP server did not stop at ${MOCK_BASE}.`);
}

async function mockRequests() {
  const response = await fetch(`${MOCK_BASE}/requests`, { signal: AbortSignal.timeout(2_000) });
  const payload = await response.json();
  return payload.requests ?? [];
}

async function selectAdminOrganization(ctx) {
  const listed = await denApiFetch("/v1/me/orgs", {
    headers: { authorization: `Bearer ${state.adminSession}` },
  });
  ctx.assert(listed.response.ok, `Could not list organizations: ${listed.response.status}`);
  const orgs = Array.isArray(listed.body?.orgs) ? listed.body.orgs : [];
  const selected = orgs.find((org) => org.slug === "acme-robotics-demo")
    ?? orgs.find((org) => ["owner", "admin"].includes(String(org.role ?? "").toLowerCase()))
    ?? orgs[0];
  ctx.assert(selected && typeof selected.id === "string", `No organization found for ${DEMO_EMAIL}.`);
  state.orgId = selected.id;
  const activated = await denApiFetch("/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${state.adminSession}` },
    body: JSON.stringify({ organizationId: state.orgId }),
  });
  ctx.assert(activated.response.ok, `Could not activate organization ${state.orgId}: ${activated.response.status}`);
}

async function cleanupConnections(ctx, token) {
  const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
    headers: orgHeaders(token),
  });
  if (!existing.response.ok) return;
  for (const connection of existing.body.connections ?? []) {
    if (!connection.name?.startsWith?.(CONNECTION_PREFIX)) continue;
    const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
      method: "DELETE",
      headers: orgHeaders(token),
    });
    ctx.assert(removed.response.ok, `Cleanup failed for ${connection.id}: ${removed.response.status}`);
  }
}

async function cleanupEvalBrowserTargets(ctx) {
  if (!ctx.cdpBaseUrl) return;
  const response = await fetch(`${ctx.cdpBaseUrl.replace(/\/$/, "")}/json/list`);
  if (!response.ok) return;
  const targets = await response.json();
  for (const target of targets) {
    const url = String(target.url ?? "");
    const belongsToEval =
      url.startsWith(DEN_WEB_URL) ||
      url.startsWith(MOCK_BASE) ||
      url.startsWith(`${DEN_API_URL}/v1/mcp-connections/`);
    if (!belongsToEval || !target.id) continue;
    await fetch(`${ctx.cdpBaseUrl.replace(/\/$/, "")}/json/close/${encodeURIComponent(target.id)}`).catch(() => undefined);
  }
}

async function cleanupDesktopEvalWorkspaces(ctx) {
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", {
    timeoutMs: 30_000,
    label: "desktop bridge for workspace cleanup",
  });
  const cleanup = await ctx.eval(`(async () => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop('openworkServerInfo', {});
    if (!info?.baseUrl) return { deleted: 0, failed: ['OpenWork server info unavailable'] };
    const token = info.ownerToken || info.clientToken;
    const headers = token ? { authorization: 'Bearer ' + token } : {};
    const listed = await fetch(info.baseUrl + '/workspaces', { headers });
    if (!listed.ok) return { deleted: 0, failed: ['Workspace list returned ' + listed.status] };
    const payload = await listed.json();
    const stale = (payload.workspaces ?? []).filter((workspace) =>
      typeof workspace.path === 'string' && workspace.path.startsWith('/tmp/openwork-durable-auth-mcp-')
    );
    const failed = [];
    let deleted = 0;
    for (const workspace of stale) {
      const response = await fetch(info.baseUrl + '/workspaces/' + encodeURIComponent(workspace.id), {
        method: 'DELETE',
        headers,
      });
      if (response.ok) deleted += 1;
      else failed.push(workspace.id + ':' + response.status);
    }
    return { deleted, failed };
  })()`, { awaitPromise: true });
  ctx.assert(cleanup.failed.length === 0, `Could not clean prior eval workspaces: ${cleanup.failed.join(", ")}`);
}

async function prepareCloudState(ctx) {
  await cleanupEvalBrowserTargets(ctx);
  await cleanupDesktopEvalWorkspaces(ctx);
  await runMysql(ctx, "DELETE FROM oauthAccessToken WHERE client_id IN (SELECT client_id FROM oauthClient WHERE name LIKE 'Legacy MCP client %');");
  await runMysql(ctx, "DELETE FROM oauthRefreshToken WHERE client_id IN (SELECT client_id FROM oauthClient WHERE name LIKE 'Legacy MCP client %');");
  await runMysql(ctx, "DELETE FROM oauthConsent WHERE client_id IN (SELECT client_id FROM oauthClient WHERE name LIKE 'Legacy MCP client %');");
  await runMysql(ctx, "DELETE FROM oauthClient WHERE name LIKE 'Legacy MCP client %';");
  await startMock(ctx);
  state.adminSession = await signInApi(DEMO_EMAIL, DEMO_PASSWORD);
  ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${DEMO_EMAIL}.`);
  await selectAdminOrganization(ctx);
  await cleanupConnections(ctx, state.adminSession);
  await runMysql(ctx, `
    UPDATE organization
    SET metadata = JSON_MERGE_PATCH(
      COALESCE(metadata, JSON_OBJECT()),
      JSON_OBJECT('capabilities', JSON_OBJECT('installLinks', true))
    );
  `);
}

async function completeDesktopOnboarding(ctx) {
  const deadline = Date.now() + 90_000;
  let stableWorkspaceTicks = 0;
  while (Date.now() < deadline) {
    const view = await ctx.eval(`(() => ({
      hash: location.hash,
      text: document.body.innerText,
      hasFolder: Boolean(document.querySelector('input[placeholder="/workspace/my-project"]')),
    }))()`);
    if (view.hash.includes("/workspace/") && !view.hasFolder && !view.text.includes("Choose your organization")) {
      stableWorkspaceTicks += 1;
      if (stableWorkspaceTicks >= 10) break;
      await sleep(500);
      continue;
    }
    stableWorkspaceTicks = 0;
    if (view.hasFolder) {
      await ctx.fill('input[placeholder="/workspace/my-project"]', WORKSPACE_PATH);
      await ctx.clickText("Use this folder", { timeoutMs: 15_000 });
      state.workspacePrepared = true;
    } else {
      const advanced = await ctx.eval(`(() => {
        const labels = ["Continue with organization", "Continue to workspace", "Continue without OpenWork Models", "Continue"];
        const button = [...document.querySelectorAll('button')].find((candidate) => labels.includes((candidate.textContent ?? '').trim()) && !candidate.disabled);
        button?.click();
        return Boolean(button);
      })()`);
      if (!advanced) await sleep(500);
    }
    await sleep(500);
  }
  await ctx.waitFor("location.hash.includes('/workspace/')", { timeoutMs: 30_000, label: "desktop workspace" });
  state.workspaceId = await ctx.eval("(location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? null");
  ctx.assert(Boolean(state.workspaceId), "Desktop workspace id was missing.");
}

async function ensureDedicatedWorkspace(ctx) {
  if (state.workspacePrepared) return;
  const previousWorkspaceId = state.workspaceId;
  await ctx.waitFor(
    "window.__openworkControl?.listActions?.().find((action) => action.id === 'workspace.create')?.disabled === false",
    { timeoutMs: 30_000, label: "workspace.create action" },
  );
  await ctx.control("workspace.create", {
    path: WORKSPACE_PATH,
    projectLabel: "Durable authentication proof",
  });
  await ctx.waitFor(`(() => {
    const id = (location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? null;
    return Boolean(id && id !== ${JSON.stringify(previousWorkspaceId)});
  })()`, { timeoutMs: 45_000, label: "dedicated auth-proof workspace" });
  state.workspacePrepared = true;
  await completeDesktopOnboarding(ctx);
}

async function signDesktopIntoCloud(ctx) {
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000, label: "desktop control API" });
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 30_000, label: "desktop bridge" });
  const bootstrap = { baseUrl: DEN_API_URL, apiBaseUrl: DEN_API_URL, requireSignin: false, handoff: null };
  const written = await ctx.eval(`(async () => {
    await window.__OPENWORK_ELECTRON__.invokeDesktop("setDesktopBootstrapConfig", ${JSON.stringify(bootstrap)});
    localStorage.setItem("openwork.den.baseUrl", ${JSON.stringify(DEN_API_URL)});
    localStorage.setItem("openwork.den.apiBaseUrl", ${JSON.stringify(DEN_API_URL)});
    localStorage.removeItem("openwork.den.authToken");
    localStorage.removeItem("openwork.den.activeOrgId");
    return true;
  })()`, { awaitPromise: true });
  ctx.assert(written === true, "Desktop bootstrap was not written.");
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop after bootstrap reload" });

  const handoff = await denApiFetch("/v1/auth/desktop-handoff", {
    method: "POST",
    headers: orgHeaders(state.adminSession),
    body: JSON.stringify({ desktopScheme: "openwork" }),
  });
  ctx.assert(handoff.response.ok && typeof handoff.body?.grant === "string", `Desktop handoff failed: ${handoff.response.status}`);
  await ctx.control("auth.exchange-grant", { grant: handoff.body.grant, baseUrl: DEN_API_URL });
  await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", {
    timeoutMs: 45_000,
    label: "desktop bearer session",
  });
  state.desktopToken = await ctx.eval("localStorage.getItem('openwork.den.authToken')");
  await completeDesktopOnboarding(ctx);
  await ensureDedicatedWorkspace(ctx);
}

async function openDenWebTab(ctx) {
  await ctx.eval(`(() => {
    document.getElementById('durable-auth-open-dashboard')?.remove();
    const link = document.createElement('a');
    link.id = 'durable-auth-open-dashboard';
    link.href = ${JSON.stringify(DEN_WEB_URL)};
    link.target = '_blank';
    link.textContent = 'Open OpenWork dashboard';
    link.style.position = 'fixed';
    link.style.left = '12px';
    link.style.bottom = '12px';
    link.style.zIndex = '99999';
    document.body.appendChild(link);
    return true;
  })()`);
  const switching = ctx.switchToNewTab({ timeoutMs: 20_000, label: "OpenWork dashboard" });
  await sleep(750);
  await ctx.trustedClick("#durable-auth-open-dashboard");
  await switching;
  await ctx.waitFor(
    `location.origin === ${JSON.stringify(new URL(DEN_WEB_URL).origin)} && document.readyState !== 'loading'`,
    { timeoutMs: 30_000, label: "OpenWork dashboard document" },
  );
  if (ctx.client?.send) {
    await ctx.client.send("Network.clearBrowserCookies", {});
  }
  await ctx.eval("localStorage.clear(); sessionStorage.clear(); true");
  await signInViaBrowser(ctx, DEMO_EMAIL, DEMO_PASSWORD);
  const activated = await ctx.eval(`fetch('/api/den/v1/me/active-organization', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ organizationId: ${JSON.stringify(state.orgId)} }),
  }).then((response) => response.ok)`, { awaitPromise: true });
  ctx.assert(activated, `Browser could not activate organization ${state.orgId}.`);
}

async function openSharedConnectionDialog(ctx, name) {
  await openAdminConnections(ctx);
  const opened = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => {
      const text = (candidate.textContent ?? '').trim();
      return text === 'Add Custom' || text.startsWith('MCP server');
    });
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(opened, "The add-MCP-server action was not available.");
  await ctx.waitFor("Boolean(document.querySelector('input[placeholder=\"notion\"]'))", {
    timeoutMs: 15_000,
    label: "custom MCP dialog",
  });
  await ctx.fill('input[placeholder="notion"]', name);
  await ctx.fill('input[placeholder="https://mcp.example.com/mcp"]', `${MOCK_BASE}/mcp`);
  const selected = await ctx.eval(`(() => {
    const button = [...document.querySelectorAll('button')].find((candidate) => (candidate.textContent ?? '').trim() === 'One org account');
    button?.click();
    return Boolean(button);
  })()`);
  ctx.assert(selected, "One org account option was not available.");
}

async function submitSharedConnectionAndConsent(ctx) {
  await ctx.clickText("Add connection", { timeoutMs: 15_000 });
  const noOpenWorkReauth = await ctx.eval("!document.body.innerText.includes(\"Confirm it's you to continue\")");
  await ctx.switchToNewTab({ timeoutMs: 20_000, label: "provider consent" });
  await ctx.waitForText("Mock MCP OAuth", { timeoutMs: 30_000 });
  await ctx.clickText("Approve OpenWork", { timeoutMs: 15_000 });
  await ctx.waitForText("Connected", { timeoutMs: 30_000 });
  return noOpenWorkReauth;
}

async function waitForConnection(ctx, name) {
  const deadline = Date.now() + 60_000;
  let connection = null;
  while (Date.now() < deadline) {
    const listed = await denApiFetch("/v1/mcp-connections?scope=manageable", {
      headers: orgHeaders(state.adminSession),
    });
    connection = (listed.body?.connections ?? []).find((entry) => entry.name === name) ?? null;
    if (connection?.connected) return connection;
    await sleep(500);
  }
  ctx.assert(false, `${name} never became connected in the Den API.`);
  return connection;
}

async function waitForDesktopAuthStatus(ctx, expected, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  while (Date.now() < deadline) {
    try {
      status = (await ctx.control("auth.status"))?.status ?? null;
      if (status === expected) return status;
    } catch {
      // The control registry can briefly reset during a renderer reload.
    }
    await sleep(250);
  }
  ctx.assert(false, `Desktop auth status never became ${expected}; last status: ${status}.`);
  return status;
}

async function stageAndRenewDesktopSession(ctx) {
  await runMysql(ctx, `
    UPDATE session
    SET created_at = DATE_SUB(NOW(3), INTERVAL 8 DAY),
        updated_at = DATE_SUB(NOW(3), INTERVAL 2 DAY),
        expires_at = DATE_ADD(NOW(3), INTERVAL 10 MINUTE)
    WHERE token = ${sqlString(state.desktopToken)};
  `);
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop reopened" });
  await waitForDesktopAuthStatus(ctx, "signed_in");
  const raw = await runMysql(ctx, `
    SELECT TIMESTAMPDIFF(DAY, created_at, NOW(3)), TIMESTAMPDIFF(HOUR, NOW(3), expires_at)
    FROM session
    WHERE token = ${sqlString(state.desktopToken)}
    LIMIT 1;
  `);
  const [createdAgeDays, remainingHours] = raw.split(/\s+/).map(Number);
  state.desktopSessionStats = { createdAgeDays, remainingHours };
}

async function openDesktopMcpSettings(ctx) {
  await ctx.navigateHash(`/workspace/${state.workspaceId}/settings/extensions/mcp`);
  await completeDesktopOnboarding(ctx);
  await ctx.waitForText("Add Custom App", { timeoutMs: 45_000 });
  const showingHidden = await ctx.eval("document.body.innerText.includes('Showing hidden')");
  if (!showingHidden) await ctx.clickText("Show hidden", { timeoutMs: 20_000 }).catch(() => {});
  await ctx.waitForText("OpenWork Cloud Control", { timeoutMs: 90_000 });
  await ctx.waitFor(`(() => {
    const leaves = [...document.querySelectorAll('*')].filter((element) => element.children.length === 0 && (element.textContent ?? '').trim() === 'OpenWork Cloud Control');
    for (const leaf of leaves) {
      let node = leaf;
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const bounds = node.getBoundingClientRect();
        if ((node.textContent ?? '').includes('Ready') && bounds.height > 0 && bounds.height < 360) {
          node.scrollIntoView({ block: 'center' });
          return true;
        }
        node = node.parentElement;
      }
    }
    return false;
  })()`, { timeoutMs: 120_000, label: "OpenWork Cloud Control Ready" });
}

async function expireAndRefreshSharedMcp(ctx) {
  state.mcpToken = await mintMcpToken(state.desktopToken, ctx);
  await stopMock(ctx);
  await startMock(ctx);
  await ctx.eval('window.__OPENWORK_ELECTRON__.invokeDesktop("engineRestart", {})', { awaitPromise: true });
  state.engineRestarted = true;

  const searchResult = await mcpAgentCall(state.mcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query: "echo" },
  }, ctx);
  const matchesText = searchResult.content?.[0]?.text ?? "";
  const parsed = JSON.parse(matchesText);
  const match = (parsed.matches ?? []).find((entry) => entry.summary?.includes?.(FIRST_CONNECTION));
  ctx.assert(Boolean(match), `search_capabilities did not find ${FIRST_CONNECTION}: ${matchesText.slice(0, 500)}`);
  const executeResult = await mcpAgentCall(state.mcpToken, "tools/call", {
    name: "execute_capability",
    arguments: { name: match.name, body: { text: ECHO_TEXT } },
  }, ctx);
  ctx.assert(executeResult.content?.[0]?.text === ECHO_TEXT, "The refreshed shared MCP did not return the expected echo result.");
  await openDesktopMcpSettings(ctx);
}

async function ensureLocalDraft(ctx) {
  await ctx.navigateHash(`/workspace/${state.workspaceId}/session`);
  await ctx.waitFor("location.hash.includes('/session')", { timeoutMs: 30_000, label: "local task route" });
  const hasComposer = await ctx.eval("Boolean(document.querySelector('[data-lexical-editor=\"true\"]'))");
  if (!hasComposer) {
    const deadline = Date.now() + 90_000;
    let created = false;
    while (Date.now() < deadline && !created) {
      await ctx.waitFor(
        "window.__openworkControl?.listActions?.().find((action) => action.id === 'session.create_task')?.disabled === false",
        { timeoutMs: 30_000, label: "new local task action" },
      );
      await ctx.control("session.create_task");
      created = await ctx.waitFor(
        "location.hash.match(/\\/session\\/[^/?]+/) !== null || Boolean(document.querySelector('[data-lexical-editor=\"true\"]'))",
        { timeoutMs: 10_000, label: "created local task" },
      ).then(() => true).catch(() => false);
      if (!created) await sleep(1_000);
    }
    ctx.assert(created, "OpenWork did not create a local task after the engine restart.");
  }
  await ctx.waitFor("window.__openworkControl?.listActions?.().find((action) => action.id === 'composer.set_text')?.disabled === false", {
    timeoutMs: 60_000,
    label: "local draft composer",
  });
  await ctx.control("composer.set_text", { text: LOCAL_DRAFT });
  await ctx.waitFor(`document.body.innerText.includes(${JSON.stringify(LOCAL_DRAFT)})`, {
    timeoutMs: 15_000,
    label: "local draft text",
  });
}

async function simulateCloudPartition(ctx) {
  await ctx.control("eval.auth.set-base-url", { baseUrl: "http://127.0.0.1:1" });
  await ctx.waitForText("OpenWork Cloud is temporarily unavailable.", { timeoutMs: 30_000 });
  await waitForDesktopAuthStatus(ctx, "unavailable");
}

async function restoreCloudConnectivity(ctx) {
  await ctx.control("eval.auth.set-base-url", { baseUrl: DEN_API_URL });
  await waitForDesktopAuthStatus(ctx, "signed_in", 60_000);
  await ctx.waitFor("!document.body.innerText.includes('OpenWork Cloud is temporarily unavailable.')", {
    timeoutMs: 30_000,
    label: "Cloud reconnect banner cleared",
  });
}

async function stageBrowserSessionStale(ctx) {
  let sessionId = await ctx.eval("fetch('/api/den/v1/me', { credentials: 'include' }).then((response) => response.json()).then((body) => body?.session?.id ?? null)", {
    awaitPromise: true,
  });
  if (!sessionId) {
    const fallback = await runMysql(ctx, `
      SELECT session.id
      FROM session
      INNER JOIN user ON user.id = session.user_id
      WHERE user.email = ${sqlString(DEMO_EMAIL)}
      ORDER BY session.created_at DESC
      LIMIT 1;
    `);
    sessionId = fallback.trim() || null;
  }
  ctx.assert(Boolean(sessionId), "Could not resolve the den-web browser session id.");
  state.browserSessionId = sessionId;
  await runMysql(ctx, `UPDATE session SET created_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE id = ${sqlString(sessionId)};`);
}

async function navigateDenWeb(ctx, path) {
  await ctx.eval(`(() => { location.assign(${JSON.stringify(new URL(path, DEN_WEB_URL).toString())}); return true; })()`);
  await ctx.waitFor(`location.pathname === ${JSON.stringify(path)}`, { timeoutMs: 30_000, label: `den-web ${path}` });
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: `${path} loaded` });
}

async function grantClipboard(ctx) {
  if (!ctx.client?.send) return;
  await ctx.client.send("Browser.grantPermissions", {
    origin: new URL(DEN_WEB_URL).origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  }).catch((error) => ctx.log(`Clipboard permission grant skipped: ${error instanceof Error ? error.message : String(error)}`));
}

async function completeSensitiveAction(ctx) {
  await navigateDenWeb(ctx, "/dashboard/members");
  await grantClipboard(ctx);
  await ctx.waitFor(`(() => {
    const button = document.querySelector(${JSON.stringify(COPY_INSTALL_LINK_SELECTOR)});
    return Boolean(button && !button.disabled && button.textContent.includes('Copy install link'));
  })()`, { timeoutMs: 45_000, label: "copy install link action" });
  await ctx.trustedClick(COPY_INSTALL_LINK_SELECTOR);
  await ctx.waitFor(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return Boolean(dialog && dialog.textContent.includes("Confirm it's you to continue"));
  })()`, { timeoutMs: 30_000, label: "security check" });
  state.reauthDialogText = await ctx.eval("document.querySelector('[role=dialog]')?.textContent ?? ''");
  await ctx.fill('input[autocomplete="current-password"]', DEMO_PASSWORD);
  await ctx.clickText("Verify password", { timeoutMs: 20_000 });
  await ctx.waitFor(`(() => {
    const button = document.querySelector(${JSON.stringify(COPY_INSTALL_LINK_SELECTOR)});
    return !document.querySelector('[role="dialog"]') && Boolean(button?.textContent.includes('Copied'));
  })()`, { timeoutMs: 45_000, label: "queued action automatically resumed" });
}

async function revokedMcpResponse() {
  const response = await fetch(`${DEN_API_URL}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${state.mcpToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} }),
  });
  return { status: response.status, ok: response.ok, text: await response.text() };
}

async function openLegacyMcpAuthorization(ctx) {
  const registered = await denApiFetch("/register", {
    method: "POST",
    body: JSON.stringify({
      client_name: `Legacy MCP client ${RUN_TAG}`,
      redirect_uris: ["http://127.0.0.1:49152/oauth/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:read mcp:write",
    }),
  });
  ctx.assert(registered.response.ok && typeof registered.body?.client_id === "string", `Legacy client registration failed: ${registered.response.status}`);
  state.legacyClientId = registered.body.client_id;

  await openDenWebTab(ctx);
  const verifier = `durable-auth-legacy-client-${RUN_TAG}`;
  const authorizeUrl = new URL("/api/auth/oauth2/authorize", DEN_BROWSER_API_URL);
  authorizeUrl.searchParams.set("client_id", state.legacyClientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", "http://127.0.0.1:49152/oauth/callback");
  authorizeUrl.searchParams.set("scope", "mcp:read mcp:write offline_access");
  authorizeUrl.searchParams.set("resource", `${DEN_API_URL}/mcp`);
  authorizeUrl.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("prompt", "consent");
  await ctx.eval(`(() => { location.assign(${JSON.stringify(authorizeUrl.toString())}); return true; })()`);
  await ctx.waitFor("location.pathname === '/mcp/select-organization'", { timeoutMs: 45_000, label: "legacy MCP workspace authorization redirect" });
  await ctx.eval(`(() => {
    if (location.origin === ${JSON.stringify(new URL(DEN_WEB_URL).origin)}) return true;
    location.assign(${JSON.stringify(DEN_WEB_URL)} + location.pathname + location.search);
    return true;
  })()`);
  await ctx.waitForText("Authorize and continue", { timeoutMs: 45_000 });
}

export default {
  id: FLOW_ID,
  title: "Active OpenWork and MCP sessions renew silently while real security boundaries still hold",
  kind: "user-facing",
  spec: "evals/voiceovers/durable-auth-mcp.md",
  requiredEnv: [
    "OPENWORK_EVAL_DEN_API_URL",
    "OPENWORK_EVAL_DEN_WEB_URL",
    "OPENWORK_EVAL_DEN_MYSQL_CONTAINER",
  ],
  steps: [
    {
      name: "Setup: local Den, browser dashboard, and OAuth MCP provider are ready",
      run: async (ctx) => {
        await prepareCloudState(ctx);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Maya signs in once, approves one provider consent, and the shared MCP becomes connected", {
          voiceover: vo[0],
          action: async () => {
            await signDesktopIntoCloud(ctx);
            await openDenWebTab(ctx);
            await openSharedConnectionDialog(ctx, FIRST_CONNECTION);
            state.firstConsentStartedAt = new Date().toISOString();
            await submitSharedConnectionAndConsent(ctx);
            const connected = await waitForConnection(ctx, FIRST_CONNECTION);
            state.firstConnectionId = connected.id;
            await ctx.switchBack();
            await ctx.eval("location.reload(); true");
            await ctx.waitForText(FIRST_CONNECTION, { timeoutMs: 45_000 });
          },
          assert: async () => {
            const auth = await denApiFetch("/v1/mcp-connections?scope=manageable", {
              headers: orgHeaders(state.adminSession),
            });
            const connection = (auth.body?.connections ?? []).find((entry) => entry.id === state.firstConnectionId);
            const requests = (await mockRequests()).filter((entry) => entry.at >= state.firstConsentStartedAt);
            const authorizeCount = requests.filter((entry) => entry.method === "GET" && entry.path === "/authorize").length;
            recordAssertion(ctx, "The shared connection is connected in Den", connection?.connected === true, connection);
            recordAssertion(ctx, "The provider received exactly one interactive consent request", authorizeCount === 1, { authorizeCount, requests });
            await ctx.expectText("Connected");
            await ctx.expectText(FIRST_CONNECTION);
          },
          screenshot: {
            name: "shared-mcp-connected-once",
            claim: "The shared MCP appears Connected in OpenWork Cloud after one provider consent.",
            requireText: ["Connected", FIRST_CONNECTION],
            rejectText: ["Connection failed", "Confirm it's you to continue"],
          },
        });
        await ctx.switchBack();
        await ctx.eval("document.getElementById('durable-auth-open-dashboard')?.remove(); true");
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("An active desktop session older than seven days renews without returning Maya to sign-in", {
          voiceover: vo[1],
          action: async () => {
            await stageAndRenewDesktopSession(ctx);
            await ctx.navigateHash("/settings/cloud-account");
            await ctx.waitForText("Sign out", { timeoutMs: 45_000 });
          },
          assert: async () => {
            const persisted = await ctx.eval("localStorage.getItem('openwork.den.authToken')");
            recordAssertion(ctx, "The same desktop bearer remains stored", persisted === state.desktopToken, { persisted: Boolean(persisted) });
            recordAssertion(ctx, "The session creation time is more than seven days old", state.desktopSessionStats.createdAgeDays >= 7, state.desktopSessionStats);
            recordAssertion(ctx, "The server rolled expiry forward by roughly seven days", state.desktopSessionStats.remainingHours >= 166, state.desktopSessionStats);
            await ctx.expectNoText("Paste sign-in code");
            ctx.output("renewed-session.txt", JSON.stringify(state.desktopSessionStats, null, 2));
          },
          screenshot: {
            name: "desktop-session-renewed",
            claim: "Cloud Account remains signed in after the server renews an eight-day-old active session.",
            requireText: ["OpenWork Cloud", "Sign out"],
            rejectText: ["Paste sign-in code", "OpenWork Cloud is temporarily unavailable."],
            hashIncludes: "/settings/cloud-account",
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("After token invalidation and an engine restart, the MCP refreshes silently and is Ready again", {
          voiceover: vo[2],
          action: async () => {
            await expireAndRefreshSharedMcp(ctx);
          },
          assert: async () => {
            const requests = await mockRequests();
            const refreshCount = requests.filter((entry) => entry.method === "POST" && entry.path === "/token").length;
            const authorizeCount = requests.filter((entry) => entry.method === "GET" && entry.path === "/authorize").length;
            const firstMcpIndex = requests.findIndex((entry) => entry.method === "POST" && entry.path === "/mcp");
            const refreshIndex = requests.findIndex((entry) => entry.method === "POST" && entry.path === "/token");
            const retriedMcpIndex = requests.findIndex((entry, index) => index > refreshIndex && entry.method === "POST" && entry.path === "/mcp");
            recordAssertion(ctx, "The desktop agent engine restarted before the MCP was exercised", state.engineRestarted === true, null);
            recordAssertion(ctx, "The provider issued a refresh-token grant", refreshCount >= 1, { refreshCount, requests });
            recordAssertion(
              ctx,
              "The restarted provider saw an MCP attempt, a refresh grant, and then an MCP retry",
              firstMcpIndex >= 0 && refreshIndex > firstMcpIndex && retriedMcpIndex > refreshIndex,
              { firstMcpIndex, refreshIndex, retriedMcpIndex, requests },
            );
            recordAssertion(ctx, "Silent recovery did not revisit provider authorization", authorizeCount === 0, { authorizeCount, requests });
            recordAssertion(ctx, "No OAuth, security-check, or reload dialog is open", !(await ctx.eval("Boolean(document.querySelector('[role=dialog]'))")), null);
            ctx.output("silent-mcp-refresh-requests.json", JSON.stringify(requests, null, 2));
          },
          screenshot: {
            name: "mcp-silent-refresh-ready",
            claim: "The engine-facing Cloud Control MCP is Ready after refresh-only recovery.",
            requireText: ["OpenWork Cloud Control", "Ready"],
            rejectText: ["Sign in needed", "Confirm it's you to continue", "Applying changes before sign-in", "Reloading OpenCode config"],
            hashIncludes: "/settings/extensions/mcp",
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ensureLocalDraft(ctx);
        try {
          await ctx.prove("A temporary Cloud outage preserves Maya's local work and session while OpenWork reconnects", {
            voiceover: vo[3],
            action: async () => {
              await simulateCloudPartition(ctx);
            },
            assert: async () => {
              const persisted = await ctx.eval("localStorage.getItem('openwork.den.authToken')");
              recordAssertion(ctx, "The Cloud bearer is retained during a transient failure", persisted === state.desktopToken, { persisted: Boolean(persisted) });
              recordAssertion(ctx, "The local task composer remains mounted", await ctx.eval("Boolean(document.querySelector('[contenteditable=\"true\"][data-lexical-editor=\"true\"]'))"), null);
              await ctx.expectText(LOCAL_DRAFT);
              await ctx.expectNoText("Paste sign-in code");
            },
            screenshot: {
              name: "cloud-outage-local-work-retained",
              claim: "The reconnecting banner appears over the still-usable local task and retained draft.",
              requireText: ["OpenWork Cloud is temporarily unavailable.", "Local work remains available. Reconnecting automatically.", LOCAL_DRAFT],
              rejectText: ["Paste sign-in code"],
              hashIncludes: "/session",
            },
          });
        } finally {
          await restoreCloudConnectivity(ctx);
        }
        recordAssertion(ctx, "Cloud account state recovered automatically after connectivity returned", true, { status: "signed_in" });
        await ctx.expectText(LOCAL_DRAFT);
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("A stale admin session goes directly to provider consent for another shared MCP", {
          voiceover: vo[4],
          action: async () => {
            await openDenWebTab(ctx);
            await stageBrowserSessionStale(ctx);
            await openSharedConnectionDialog(ctx, SECOND_CONNECTION);
            state.secondConsentStartedAt = new Date().toISOString();
            state.secondConnectionSkippedReauth = await submitSharedConnectionAndConsent(ctx);
            const connected = await waitForConnection(ctx, SECOND_CONNECTION);
            state.secondConnectionId = connected.id;
            await ctx.switchBack();
            await ctx.eval("location.reload(); true");
            await ctx.waitForText(SECOND_CONNECTION, { timeoutMs: 45_000 });
          },
          assert: async () => {
            const requests = (await mockRequests()).filter((entry) => entry.at >= state.secondConsentStartedAt);
            const authorizeCount = requests.filter((entry) => entry.method === "GET" && entry.path === "/authorize").length;
            recordAssertion(ctx, "OpenWork did not insert its own identity check before provider consent", state.secondConnectionSkippedReauth === true, null);
            recordAssertion(ctx, "The second shared MCP needed exactly one provider consent", authorizeCount === 1, { authorizeCount, requests });
            await ctx.expectText("Connected");
            await ctx.expectText(SECOND_CONNECTION);
          },
          screenshot: {
            name: "stale-session-direct-provider-consent",
            claim: "The second shared MCP appears Connected without an intervening OpenWork security check.",
            requireText: ["Connected", SECOND_CONNECTION],
            rejectText: ["Connection failed", "Confirm it's you to continue"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("A genuinely sensitive action still asks for identity confirmation and resumes after one verification", {
          voiceover: vo[5],
          action: async () => {
            await completeSensitiveAction(ctx);
          },
          assert: async () => {
            recordAssertion(
              ctx,
              "The security check appeared before the sensitive action",
              state.reauthDialogText?.includes("Confirm it's you to continue") === true,
              state.reauthDialogText,
            );
            const buttonText = await ctx.eval(`document.querySelector(${JSON.stringify(COPY_INSTALL_LINK_SELECTOR)})?.textContent ?? ''`);
            recordAssertion(ctx, "The queued action resumed without a second click", buttonText.includes("Copied"), buttonText);
            await ctx.expectNoText("For security, confirm it's you before changing workspace settings.");
          },
          screenshot: {
            name: "sensitive-action-resumed-after-reauth",
            claim: "After one identity confirmation, the original sensitive action resumes and reaches Copied.",
            targetUrlIncludes: "/dashboard/members",
            requireText: ["Members", "Copied"],
            rejectText: ["Confirm it's you to continue", "For security, confirm it's you before changing workspace settings."],
          },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.switchBack();
        await ctx.eval("document.getElementById('durable-auth-open-dashboard')?.remove(); true");
        await ctx.prove("Explicit sign-out revokes both the desktop bearer and its MCP access immediately", {
          voiceover: vo[6],
          action: async () => {
            await ctx.navigateHash("/settings/cloud-account");
            await ctx.waitForText("Sign out", { timeoutMs: 30_000 });
            await ctx.clickText("Sign out", { timeoutMs: 20_000 });
            await ctx.waitForText("Paste sign-in code", { timeoutMs: 45_000 });
          },
          assert: async () => {
            const localToken = await ctx.eval("localStorage.getItem('openwork.den.authToken')");
            const bearerResponse = await fetch(`${DEN_API_URL}/v1/me`, {
              headers: { authorization: `Bearer ${state.desktopToken}` },
            });
            const mcpResponse = await revokedMcpResponse();
            recordAssertion(ctx, "The desktop removed its persisted bearer", !localToken, { localTokenPresent: Boolean(localToken) });
            recordAssertion(ctx, "The signed-out bearer is rejected by Den", bearerResponse.status === 401, { status: bearerResponse.status });
            recordAssertion(
              ctx,
              "MCP access tied to that session is rejected as session-revoked",
              mcpResponse.ok === false && mcpResponse.status === 401 && mcpResponse.text.includes("mcp_session_revoked"),
              mcpResponse,
            );
          },
          screenshot: {
            name: "signout-revokes-session-and-mcp",
            claim: "Cloud Account is signed out, and server assertions confirm its bearer and MCP token are revoked.",
            requireText: ["OpenWork Cloud", "Paste sign-in code"],
            rejectText: ["Sign out", "OpenWork Cloud is temporarily unavailable."],
            hashIncludes: "/settings/cloud-account",
          },
        });
      },
    },
    {
      name: "Frame 8",
      run: async (ctx) => {
        await ctx.prove("A legacy MCP client reaches workspace authorization when it adds offline access", {
          voiceover: vo[7],
          action: async () => {
            await openLegacyMcpAuthorization(ctx);
          },
          assert: async () => {
            const storedScopes = await runMysql(
              ctx,
              `SELECT scopes FROM oauthClient WHERE client_id = ${sqlString(state.legacyClientId)} LIMIT 1;`,
            );
            const currentUrl = await ctx.eval("location.href");
            recordAssertion(ctx, "The legacy MCP client gained only the refresh-enabling scope it requested", storedScopes.includes("mcp:read") && storedScopes.includes("mcp:write") && storedScopes.includes("offline_access"), storedScopes);
            recordAssertion(ctx, "Authorization reached workspace selection instead of an invalid-scope callback", !currentUrl.includes("invalid_scope"), currentUrl);
            await ctx.expectText("Authorize and continue");
            await ctx.expectNoText("The following scopes are invalid");
          },
          screenshot: {
            name: "legacy-mcp-offline-access-authorizes",
            claim: "A previously registered MCP client reaches OpenWork workspace authorization after requesting offline access.",
            targetUrlIncludes: "/mcp/select-organization",
            requireText: ["Where should this client work?", "OpenWork", "Authorize and continue"],
            rejectText: ["The following scopes are invalid", "No authorization code received"],
          },
        });
      },
    },
    {
      name: "Cleanup: remove eval connections and stop the OAuth MCP provider",
      run: async (ctx) => {
        const cleanupSession = await signInApi(DEMO_EMAIL, DEMO_PASSWORD);
        if (cleanupSession) {
          state.adminSession = cleanupSession;
          await selectAdminOrganization(ctx);
          await cleanupConnections(ctx, cleanupSession);
        }
        if (state.legacyClientId) {
          await runMysql(ctx, `DELETE FROM oauthAccessToken WHERE client_id = ${sqlString(state.legacyClientId)};`);
          await runMysql(ctx, `DELETE FROM oauthRefreshToken WHERE client_id = ${sqlString(state.legacyClientId)};`);
          await runMysql(ctx, `DELETE FROM oauthConsent WHERE client_id = ${sqlString(state.legacyClientId)};`);
          await runMysql(ctx, `DELETE FROM oauthClient WHERE client_id = ${sqlString(state.legacyClientId)};`);
        }
        await stopMock(ctx);
      },
    },
  ],
};
