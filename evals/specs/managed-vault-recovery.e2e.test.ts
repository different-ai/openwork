import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import { createAndSelectWorkspace, evalIn, go, waitFor } from "@openwork/behaviors";
import { allocateFreePort } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import type { DesktopHandle } from "@openwork/hosts";
import { startMockMcp } from "@openwork/labs";
import { eventually, needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_LOCAL_MANAGED_MCP"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `Managed vault recovery skipped — needs: ${missingRequirements.join(", ")}`
  : "OpenWork recovers managed MCP connections after the OS secure-storage key changes";

const VAULT_FILE = "local-managed-mcp-vault.json";
const RECONNECT_REASON = "Secure storage on this device changed";
const RECONNECT_LABEL = "Reconnect needed";
const READY_LABEL = "Ready";

interface ServerTarget {
  baseUrl: string;
  token: string;
}

interface ApiResult {
  status: number;
  body: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The embedded openwork-server's base URL and client token, read from the app itself. */
async function serverTarget(app: DesktopHandle): Promise<ServerTarget> {
  return eventually(async () => {
    const info = await evalIn(app, `(async () => {
      const value = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
      return {
        baseUrl: String(value?.baseUrl ?? value?.connectUrl ?? ""),
        token: String(value?.ownerToken ?? value?.clientToken ?? ""),
      };
    })()`, { awaitPromise: true, timeoutMs: 15_000 });
    if (!isRecord(info)) throw new Error("openworkServerInfo returned no record");
    const baseUrl = String(info.baseUrl ?? "").replace(/\/+$/, "");
    const token = String(info.token ?? "");
    if (!baseUrl || !token) throw new Error("embedded openwork-server credentials not ready");
    return { baseUrl, token };
  }, { within: 120_000, intervalMs: 1_000, label: "embedded openwork-server credentials" });
}

async function api(target: ServerTarget, method: string, path: string, payload?: unknown): Promise<ApiResult> {
  const response = await fetch(`${target.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${target.token}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

function managedPath(workspaceId: string, name: string): string {
  return `/workspace/${encodeURIComponent(workspaceId)}/mcp/${encodeURIComponent(name)}/managed`;
}

/** Drive the provider handshake the way the system browser would: AUTO_APPROVE redirects to the local callback. */
async function completeManagedOAuth(authorizeUrl: string): Promise<void> {
  const authorization = await fetch(authorizeUrl, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
  expect(authorization.status).toBe(302);
  const callbackUrl = authorization.headers.get("location");
  expect(callbackUrl).toBeTruthy();
  if (!callbackUrl) throw new Error("The mock IdP did not redirect to a callback URL.");
  expect(callbackUrl).toContain("/mcp/oauth/callback");
  const callback = await fetch(callbackUrl, { signal: AbortSignal.timeout(20_000) });
  expect(callback.ok).toBe(true);
}

async function waitUntilManaged(
  target: ServerTarget,
  workspaceId: string,
  name: string,
  wanted: string,
  withinMs: number,
): Promise<Record<string, unknown>> {
  const result = await eventually(
    () => api(target, "GET", managedPath(workspaceId, name)),
    {
      within: withinMs,
      intervalMs: 1_000,
      label: `managed connection ${name} reports ${wanted}`,
      until: (value) => isRecord(value.body) && value.body.status === wanted,
    },
  );
  if (!isRecord(result.body)) throw new Error(`Managed status for ${name} was not an object.`);
  return result.body;
}

/** Current (non-backup) managed vault files under the Electron profile root. */
async function vaultFilesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries
    .map((entry) => String(entry))
    .filter((rel) => rel.endsWith(VAULT_FILE))
    .map((rel) => join(root, rel));
}

async function backupNamesIn(storageDir: string): Promise<string[]> {
  const entries = await readdir(storageDir);
  return entries.filter((entry) => entry.startsWith(`${VAULT_FILE}.openwork-backup-`));
}

function rowExpression(name: string, statusLabel: string): string {
  return `(() => {
    const row = [...document.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").includes(${JSON.stringify(name)}));
    return Boolean(row && (row.textContent ?? "").includes(${JSON.stringify(statusLabel)}));
  })()`;
}

test(title, { timeout: 900_000 }, async ({ evidence }) => {
  needs(requirements);
  const stamp = Date.now();
  const nameA = `vault-a-${stamp}`;
  const nameB = `vault-b-${stamp}`;
  const namePlain = `plain-${stamp}`;
  const keyOne = `openwork-eval-secure-storage-key-one-${stamp}`;
  const keyTwo = `openwork-eval-secure-storage-key-two-${stamp}`;
  // The spec owns the profile so it survives the relaunch; the host never deletes caller-owned profiles.
  const profileDir = await mkdtemp(join(tmpdir(), "openwork-vault-recovery-"));
  const workspacePath = join(tmpdir(), `openwork-vault-recovery-ws-${stamp}`);
  await using mock = await startMockMcp({ port: await allocateFreePort() });

  let app: DesktopHandle | null = null;
  try {
    // ── Phase 1: desktop launches with OPENWORK_ENCRYPTION_KEY = K1 ──────────
    app = await desktop({
      name: "managed-vault-recovery",
      profileDir,
      env: { OPENWORK_ENCRYPTION_KEY: keyOne },
    });
    const { workspaceId } = await createAndSelectWorkspace(app, { path: workspacePath });
    const firstTarget = await serverTarget(app);
    const workspaceMcpPath = `/workspace/${encodeURIComponent(workspaceId)}/mcp`;

    // Two managed OAuth connections: native applicationType + dynamic client
    // registration (no clientSecret), both fully connected against the witness.
    for (const name of [nameA, nameB]) {
      const started = await api(firstTarget, "POST", `${workspaceMcpPath}/managed`, {
        name,
        url: mock.mcpUrl,
        oauth: { applicationType: "native", requestedScopes: ["mcp:read", "mcp:write"] },
      });
      expect(started.status, `create managed MCP ${name}: ${JSON.stringify(started.body)}`).toBe(201);
      if (!isRecord(started.body)) throw new Error(`Managed MCP ${name} start response was invalid`);
      expect(started.body.status).toBe("needs_auth");
      expect(typeof started.body.authorizeUrl).toBe("string");
      await completeManagedOAuth(String(started.body.authorizeUrl));
      const connected = await waitUntilManaged(firstTarget, workspaceId, name, "connected", 30_000);
      expect(connected).toMatchObject({ status: "connected", hasCredential: true, enabled: true });
    }

    // One ordinary (non-managed) remote MCP so the negative claim has a subject.
    const plainAdded = await api(firstTarget, "POST", workspaceMcpPath, {
      name: namePlain,
      config: { type: "remote", url: mock.mcpUrl, enabled: true, oauth: false },
    });
    expect(plainAdded.status, `add ordinary MCP: ${JSON.stringify(plainAdded.body)}`).toBe(200);

    // The vault file's directory is the runtime storage dir; discover it now,
    // while the first launch is the only writer.
    const vaultPath = await eventually(async () => {
      const files = await vaultFilesUnder(profileDir);
      const [only] = files;
      if (files.length !== 1 || !only) throw new Error(`expected exactly one vault file, saw ${JSON.stringify(files)}`);
      return only;
    }, { within: 30_000, intervalMs: 1_000, label: "managed vault file on disk" });
    const storageDir = dirname(vaultPath);
    expect(await backupNamesIn(storageDir)).toHaveLength(0);
    evidence.recordAssertionEvidence(
      "First launch owns two connected managed MCP connections plus one ordinary MCP",
      `Under K1, ${nameA} and ${nameB} completed OAuth (DCR, native) against the mock and reported connected with credentials; ${namePlain} was added as a plain remote entry; the vault lives at ${vaultPath} with no backups.`,
      true,
    );

    // ── Phase 2: quit, relaunch same profile with OPENWORK_ENCRYPTION_KEY = K2 ──
    await app.stop();
    app = null;
    app = await desktop({
      name: "managed-vault-recovery",
      profileDir,
      env: { OPENWORK_ENCRYPTION_KEY: keyTwo },
    });
    const relaunched = app;
    const target = await serverTarget(relaunched);

    // (a) The MCP settings view still renders the list — not blanked.
    await go(app, `/workspace/${workspaceId}/settings/mcp`);
    await waitFor(app, `(() => {
      const text = document.body.textContent ?? "";
      return text.includes(${JSON.stringify(nameA)})
        && text.includes(${JSON.stringify(nameB)})
        && text.includes(${JSON.stringify(namePlain)});
    })()`, { timeoutMs: 120_000, label: "MCP settings list shows managed and ordinary entries" });
    const unavailableBannerAbsent = await evalIn(
      app,
      `!document.querySelector('[data-testid="mcp-managed-oauth-unavailable"]')`,
    );
    expect(unavailableBannerAbsent, "managed OAuth must not report unavailable after recovery").toBe(true);

    // (b) The first managed row shows the reconnect state with the recovery reason.
    const expandedRowA = await evalIn(app, `(() => {
      const row = [...document.querySelectorAll("button")]
        .find((button) => (button.textContent ?? "").includes(${JSON.stringify(nameA)}));
      if (!(row instanceof HTMLElement)) return false;
      row.click();
      return true;
    })()`);
    expect(expandedRowA).toBe(true);
    await waitFor(app, rowExpression(nameA, RECONNECT_LABEL), {
      timeoutMs: 60_000,
      label: `row ${nameA} shows "${RECONNECT_LABEL}"`,
    });

    // API cross-check: 200 (not the old 503 blanking), reconnect_required, no
    // credential, and the managed vault still available.
    const listed = await api(target, "GET", workspaceMcpPath);
    expect(listed.status).toBe(200);
    if (!isRecord(listed.body) || !Array.isArray(listed.body.items)) {
      throw new Error(`workspace MCP list was invalid: ${JSON.stringify(listed.body)}`);
    }
    const items = listed.body.items.filter(isRecord);
    const itemA = items.find((item) => item.name === nameA);
    const itemPlain = items.find((item) => item.name === namePlain);
    expect(itemPlain, "ordinary MCP entry must survive the key change").toBeTruthy();
    if (!isRecord(itemA) || !isRecord(itemA.managedOAuth)) {
      throw new Error(`managed item ${nameA} missing from the list: ${JSON.stringify(items.map((item) => item.name))}`);
    }
    expect(itemA.managedOAuth).toMatchObject({ status: "reconnect_required", hasCredential: false });
    if (!isRecord(listed.body.managedOAuthState)) throw new Error("managedOAuthState missing from the MCP list");
    expect(listed.body.managedOAuthState.available).toBe(true);
    console.log(`[managed-vault-recovery] ${nameA} lastError after relaunch: ${JSON.stringify(itemA.managedOAuth.lastError)}`);

    // The row's expanded details name the cause, so a member knows why they
    // must reconnect.
    await eventually(async () => {
      const text = await evalIn(
        relaunched,
        `(document.querySelector('[data-testid="mcp-managed-reconnect-reason"]')?.textContent ?? "")`,
      );
      return typeof text === "string" ? text : "";
    }, {
      within: 60_000,
      intervalMs: 1_000,
      label: "reconnect reason mentions the secure storage change",
      until: (text) => text.includes(RECONNECT_REASON),
    });
    evidence.recordAssertionEvidence(
      "The key change surfaces as reconnect_required instead of blanking the list",
      `GET /workspace/:id/mcp returned 200 with ${items.length} items including ${namePlain}; ${nameA} reported managedOAuth.status=reconnect_required with hasCredential=false and managedOAuthState.available=true.`,
      listed.status === 200 && itemPlain !== undefined && itemA.managedOAuth.status === "reconnect_required",
    );

    // (e, before reconnect) On-disk recovery evidence: exactly one quarantine
    // backup, and the rebuilt vault kept the index but no credential material.
    const backupsAfterRecovery = await eventually(() => backupNamesIn(storageDir), {
      within: 30_000,
      intervalMs: 1_000,
      label: "quarantined vault backup",
      until: (names) => names.length > 0,
    });
    expect(backupsAfterRecovery).toHaveLength(1);
    const recoveredVaultText = await readFile(vaultPath, "utf8");
    expect(recoveredVaultText).toContain('"schemaVersion":2');
    expect(recoveredVaultText).not.toContain("mock-access-");
    expect(recoveredVaultText).not.toContain("refresh_token");
    const recoveredVault: unknown = JSON.parse(recoveredVaultText);
    if (!isRecord(recoveredVault) || !isRecord(recoveredVault.index)) {
      throw new Error("The recovered vault has no plaintext index.");
    }
    const recoveredManagedEntries = Object.values(recoveredVault.index)
      .filter(isRecord)
      .filter((entry) => entry.name === nameA || entry.name === nameB);
    expect(recoveredManagedEntries).toHaveLength(2);
    for (const entry of recoveredManagedEntries) {
      expect(entry).toMatchObject({ status: "reconnect_required", hasCredential: false });
    }
    evidence.recordAssertionEvidence(
      "The unreadable vault was quarantined once and rebuilt without credentials",
      `Exactly one ${VAULT_FILE}.openwork-backup-* exists (${backupsAfterRecovery[0]}); the rebuilt vault is schemaVersion 2, contains no mock access/refresh token material, and both managed index entries carry hasCredential=false before reconnect.`,
      backupsAfterRecovery.length === 1 && recoveredManagedEntries.length === 2,
    );

    await evalIn(app, `(() => {
      document.querySelector('[data-testid="mcp-managed-reconnect-reason"]')
        ?.scrollIntoView({ block: "center" });
      return true;
    })()`);
    const reconnectNeededShot = await screenshot(app);
    const reconnectNeededSeen = await validate(reconnectNeededShot, [
      `An MCP connections settings list shows an entry with status "${RECONNECT_LABEL}"`,
      "A highlighted message says secure storage on this device changed and sign-ins were cleared",
      "A Reconnect button is visible",
    ]);
    expect(reconnectNeededSeen.ok, reconnectNeededSeen.why).toBe(true);

    // (c) Reconnect the first connection: click the row action, and — because
    // the UI hands OAuth to the system browser, which CI cannot drive — also
    // complete the handshake through the embedded server.
    const beforeReconnectIso = new Date().toISOString();
    const actionLabel = await evalIn(
      app,
      `(document.querySelector('[data-testid="mcp-managed-auth-action"]')?.textContent ?? "").trim()`,
    );
    expect(actionLabel).toBe("Reconnect");
    const clickedReconnect = await evalIn(app, `(() => {
      const button = document.querySelector('[data-testid="mcp-managed-auth-action"]');
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    })()`);
    expect(clickedReconnect).toBe(true);

    const restarted = await api(target, "POST", `${managedPath(workspaceId, nameA)}/connect`);
    expect(restarted.status, `reconnect ${nameA}: ${JSON.stringify(restarted.body)}`).toBe(200);
    if (!isRecord(restarted.body)) throw new Error("Managed reconnect response was invalid");
    expect(restarted.body.status).toBe("needs_auth");
    expect(typeof restarted.body.authorizeUrl).toBe("string");
    await completeManagedOAuth(String(restarted.body.authorizeUrl));

    const reconnected = await waitUntilManaged(target, workspaceId, nameA, "connected", 60_000);
    expect(reconnected).toMatchObject({ status: "connected", hasCredential: true, enabled: true });
    // Witness fact: the mock IdP really served a NEW authorization after relaunch.
    const newAuthorization = await mock.authorizeRequestSince(beforeReconnectIso, { timeoutMs: 60_000 });
    evidence.recordAssertionEvidence(
      "The mock IdP observed a fresh authorization after the relaunch",
      `GET /authorize hit the witness at ${newAuthorization.at} (>= ${beforeReconnectIso}); afterwards ${nameA} reported connected with hasCredential=true.`,
      newAuthorization.at >= beforeReconnectIso && reconnected.status === "connected",
    );

    // The UI row flips to connected ("Ready"). The click's own poll refreshes
    // the list; if that raced, revisiting the view refreshes it the way a
    // person would.
    const rowAReady = rowExpression(nameA, READY_LABEL);
    try {
      await waitFor(app, rowAReady, { timeoutMs: 60_000, label: `row ${nameA} flips to "${READY_LABEL}"` });
    } catch {
      await go(app, `/workspace/${workspaceId}/session`);
      await go(app, `/workspace/${workspaceId}/settings/mcp`);
      await waitFor(app, rowAReady, {
        timeoutMs: 60_000,
        label: `row ${nameA} flips to "${READY_LABEL}" after revisiting the view`,
      });
    }

    // (d) No state bleed: the second managed connection still needs reconnect.
    await waitFor(app, rowExpression(nameB, RECONNECT_LABEL), {
      timeoutMs: 30_000,
      label: `row ${nameB} still shows "${RECONNECT_LABEL}"`,
    });
    const second = await api(target, "GET", managedPath(workspaceId, nameB));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: "reconnect_required", hasCredential: false });
    evidence.recordAssertionEvidence(
      "Reconnecting one connection did not bleed into the other",
      `After ${nameA} reconnected, ${nameB} still reports reconnect_required with hasCredential=false via API and "${RECONNECT_LABEL}" in the UI.`,
      isRecord(second.body) && second.body.status === "reconnect_required" && second.body.hasCredential === false,
    );

    // (e, after reconnect) Still exactly one quarantine backup, and the live
    // vault still exposes no plaintext token material.
    expect(await backupNamesIn(storageDir)).toHaveLength(1);
    const finalVaultText = await readFile(vaultPath, "utf8");
    expect(finalVaultText).not.toContain("mock-access-");
    expect(finalVaultText).not.toContain("refresh_token");

    // Collapse the reconnected row so both rows' statuses share the frame.
    await evalIn(app, `(() => {
      const row = [...document.querySelectorAll("button")]
        .find((button) => (button.textContent ?? "").includes(${JSON.stringify(nameA)}));
      if (!(row instanceof HTMLElement)) return false;
      row.scrollIntoView({ block: "center" });
      const expanded = (row.parentElement?.querySelectorAll("button").length ?? 0) > 1;
      if (expanded) row.click();
      return true;
    })()`);
    await waitFor(app, rowExpression(nameA, READY_LABEL), {
      timeoutMs: 30_000,
      label: `row ${nameA} header still shows "${READY_LABEL}" after collapsing`,
    });
    const reconnectedShot = await screenshot(app);
    const reconnectedSeen = await validate(reconnectedShot, [
      `An MCP connections settings list shows an entry with status "${READY_LABEL}"`,
      `Another MCP entry still shows status "${RECONNECT_LABEL}"`,
    ]);
    expect(reconnectedSeen.ok, reconnectedSeen.why).toBe(true);
  } finally {
    if (app) await app.stop().catch(() => undefined);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  }
});
