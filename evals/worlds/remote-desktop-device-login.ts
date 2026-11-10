import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { control, createDesktopHandoffGrant, denFetch, quitDesktop } from "@openwork/behaviors";
import { browserScript, evaluateOnSurface } from "@openwork/cdp";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import type { App, Den, Seed } from "@openwork/env";
import { record, rows, text } from "./org-invite.ts";

const exec = promisify(execFile);
const clientId = "openwork-desktop-device";
const tokenPath = "/api/auth/device/token";

/** A shell on the packaged desktop's host. It never reads Den credentials. */
function desktopShell(app: App, den: Den, binary: string) {
  const profile = app.handle.profileDir;
  if (!profile?.startsWith("/tmp/openwork-device-proof-")) throw new Error("The proof requires its own disposable /tmp desktop profile.");
  const directory = join(profile, "device-login-proof");
  const discovery = join(profile, "electron-userdata", "openwork-ui-control.json");
  const sandbox = app.handle.sandboxId;
  async function node(source: string) {
    if (sandbox) {
      const encoded = Buffer.from(source).toString("base64");
      return (await execInSandbox(defaultDaytonaExec, sandbox,
        `node -e "eval(Buffer.from(\\\"${encoded}\\\",\\\"base64\\\").toString())"`,
        { timeoutMs: 30_000, context: "packaged device-login public witness" })).stdout;
    }
    return (await exec(process.execPath, ["-e", source], { timeout: 30_000 })).stdout;
  }
  return {
    async preparePermissions() {
      // Only these two proof-owned parents are changed. /tmp and / are never
      // chmodded, so a successful command must rely on the file's own 0600.
      await node(`const fs = require("node:fs"); for (const p of ${JSON.stringify([profile, dirname(discovery)])}) fs.chmodSync(p, 0o755);`);
    },
    async discoveryCustody() {
      const raw = await node(`const fs = require("node:fs"), path = require("node:path");
        const file = ${JSON.stringify(discovery)}, info = fs.lstatSync(file), uid = process.getuid();
        let p = path.dirname(file), privateAncestor = false;
        for (;;) { const s = fs.lstatSync(p); if (s.uid === uid && (s.mode & 0o077) === 0) privateAncestor = true; const next = path.dirname(p); if (p === next) break; p = next; }
        process.stdout.write(JSON.stringify({ mode: info.mode & 0o777, ownedByCurrentUser: info.uid === uid, regularFile: info.isFile(), privateAncestor }));`);
      return record(JSON.parse(raw));
    },
    async start() {
      const runner = `
        const fs = require("node:fs"), cp = require("node:child_process");
        const dir = ${JSON.stringify(directory)}; fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
        const out = fs.openSync(dir + "/output", "w", 0o600);
        const child = cp.spawn(${JSON.stringify(binary)}, ["login", "--base-url", ${JSON.stringify(den.ref.webUrl)}, "--api-base-url", ${JSON.stringify(den.ref.apiUrl)}], {
          cwd: ${JSON.stringify(profile)}, stdio: ["ignore", out, out],
          // The disposable unpacked Linux artifact has no installed SUID helper.
          // Match its GUI fixture's explicit sandbox opt-out, never a production default.
          env: { PATH: process.env.PATH, HOME: ${JSON.stringify(join(profile, "home"))}, OPENWORK_DEV_MODE: "0", ELECTRON_DISABLE_SANDBOX: "1", OPENWORK_UI_CONTROL_DISCOVERY: ${JSON.stringify(discovery)} } });
        fs.writeFileSync(dir + "/pid", String(child.pid), { mode: 0o600 });
        child.once("exit", code => fs.writeFileSync(dir + "/exit", String(code), { mode: 0o600 }));
        child.once("error", () => { fs.writeFileSync(dir + "/exit", "127", { mode: 0o600 }); });
      `;
      await node(`require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(runner)}], { detached: true, stdio: "ignore" }).unref();`);
    },
    async output() {
      return node(`const fs = require("node:fs"), f = ${JSON.stringify(join(directory, "output"))}; process.stdout.write(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");`);
    },
    async desktopLog() {
      const log = app.handle.meta?.log;
      if (!log) throw new Error("The desktop did not publish its private process log path.");
      return node(`process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(log)}, "utf8"));`);
    },
    async exitCode() {
      const value = await node(`const fs = require("node:fs"), f = ${JSON.stringify(join(directory, "exit"))}; process.stdout.write(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "pending");`);
      return value.trim() === "pending" ? null : Number(value.trim());
    },
    async stop() {
      await node(`const fs = require("node:fs"), f = ${JSON.stringify(join(directory, "pid"))}; if (fs.existsSync(f)) { try { process.kill(Number(fs.readFileSync(f, "utf8")), "SIGINT"); } catch {} }`);
    },
    async removeProfile() { await node(`require("node:fs").rmSync(${JSON.stringify(profile)}, { recursive: true, force: true });`); },
  };
}

/** Real scoped MCP clients; tokens stay in the world closure, outside evidence. */
async function targetsReader(seed: Seed, den: Den, organizationId: string) {
  const issued = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST", headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  if (!issued.response.ok) throw new Error(`Scoped target reader: HTTP ${issued.response.status}`);
  const token = text(record(issued.body).token);
  return async () => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: { name: "remote-session:targets", body: {} } } }),
    });
    if (!response.ok) throw new Error(`Read registered targets: HTTP ${response.status}`);
    const raw = await response.text();
    const line = raw.split("\n").find(entry => entry.startsWith("data:"));
    const content = record(record(record(JSON.parse(line ? line.slice(5) : raw)).result).structuredContent);
    return rows(content.computers).map(computer => ({ computerId: text(computer.computerId), registered: computer.kind === "registered", online: computer.online === true }));
  };
}

/** Real external Den, separate approving browser, unsigned packaged Electron. */
export async function remoteDesktopDeviceLogin(seed: Seed) {
  const binary = process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim();
  if (!binary?.startsWith("/") || !binary.endsWith("/openwork")) throw new Error("Native proof requires the prebuilt Linux unpacked openwork binary in OPENWORK_EVAL_ELECTRON_BINARY; source Electron is not evidence.");
  const den = await seed.den({ org: { name: "Device workspace A", admin: { name: "Device Approver" }, members: {} }, env: { DEN_FEATURE_REMOTE_DESKTOP_DEVICE_LOGIN: undefined } });
  // /v1 supports bearer sessions; Better Auth's session-list endpoint requires
  // its signed cookie. Arrange both from one real password sign-in, without
  // copying either credential into the desktop or exposing them to evidence.
  const login = await denFetch(den.ref, "/api/auth/sign-in/email", {
    method: "POST", body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
  });
  if (!login.response.ok) throw new Error(`Arrange approving session: HTTP ${login.response.status}`);
  const approvingCookie = login.response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  if (!approvingCookie) throw new Error("Approving session did not issue its signed cookie.");
  den.admin = { ...den.admin, token: text(record(login.body).token) };
  const api = (path: string, init?: RequestInit) => denFetch(den.admin, path, {
    ...init, headers: { authorization: `Bearer ${den.admin.token}`, ...init?.headers }, signal: AbortSignal.timeout(15_000),
  });
  const rollout = async (enabled: boolean, killed = false) => {
    const result = await api("/v1/admin/features/remoteDesktopDeviceLogin", { method: "PUT", body: JSON.stringify({ enabled, killed }) });
    if (!result.response.ok) throw new Error(`Operator rollout: HTTP ${result.response.status}`);
  };
  const publicFeatures = async () => record(record((await denFetch(den.ref, "/v1/features")).body).features).remoteDesktopDeviceLogin;
  const sessionCount = async () => {
    const result = await api("/api/auth/list-sessions", { headers: { cookie: approvingCookie } });
    if (!result.response.ok) throw new Error(`Read own session count: HTTP ${result.response.status}`);
    // Better Auth's session records can contain credentials. Only the count is
    // returned from this closure; never include response content in errors.
    if (!Array.isArray(result.body) || result.body.length === 0) throw new Error("Own session list must contain the live approving session.");
    return result.body.length;
  };
  const defaultEnabled = await publicFeatures();
  const second = await seed.api(den.admin, "/v1/org", { method: "POST", body: JSON.stringify({ name: "Device workspace B" }) });
  if (!second.response.ok) throw new Error(`Create second workspace: HTTP ${second.response.status}`);
  const orgB = record(record(second.body).organization);
  const organizations = rows(record((await seed.api(den.admin, "/v1/me/orgs")).body).orgs);
  const orgA = organizations.find(org => org.id !== orgB.id);
  if (!orgA || !organizations.some(org => org.id === orgB.id)) throw new Error("The approving user needs two organizations.");
  const active = await seed.api(den.admin, "/v1/me/active-organization", { method: "POST", body: JSON.stringify({ organizationId: text(orgA.id) }) });
  if (!active.response.ok) throw new Error("Cannot arrange the browser's active workspace A.");
  const targetsA = await targetsReader(seed, den, text(orgA.id));
  const targetsB = await targetsReader(seed, den, text(orgB.id));
  const baselineA = await targetsA();
  const baselineB = await targetsB();
  // A real pending API-client request lets the off-state prove decision and
  // redemption enforcement, not just rejection of a fabricated invalid code.
  await rollout(true);
  const pending = await denFetch(den.ref, "/api/auth/device/code", { method: "POST", body: JSON.stringify({ client_id: clientId }) });
  if (!pending.response.ok) throw new Error(`Arrange pending API request: HTTP ${pending.response.status}`);
  const pendingCode = record(pending.body);
  await rollout(false);
  const baselineSessionCount = await sessionCount();
  const proxy = await seed.faultProxy({ ...den, ref: { apiUrl: den.ref.apiUrl, webUrl: den.ref.apiUrl } });
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/device", headless: true, viewport: { width: 1440, height: 1000 } });
  const profileDir = `/tmp/openwork-device-proof-${randomUUID()}`;
  const app = await seed.desktop({ den, signIn: false, workspace: false, profileDir,
    env: { OPENWORK_DEV_MODE: "0", OPENWORK_ELECTRON_START_URL: "", ELECTRON_START_URL: "", OPENWORK_AUTOMATION_RUNNER: "on",
      HOME: join(profileDir, "home"), XDG_CONFIG_HOME: join(profileDir, "xdg/config"), XDG_DATA_HOME: join(profileDir, "xdg/data"),
      XDG_CACHE_HOME: join(profileDir, "xdg/cache"), XDG_STATE_HOME: join(profileDir, "xdg/state"),
      OPENWORK_CONFIG_DIR: join(profileDir, "openwork/config"), OPENWORK_DATA_DIR: join(profileDir, "openwork/data"),
      OPENCODE_CONFIG_DIR: join(profileDir, "opencode/config"),
    },
  });
  if (app.handle.profileDir !== profileDir) throw new Error("Packaged desktop did not use the proof-owned profile directory.");
  const shell = desktopShell(app, den, binary);
  await shell.preparePermissions();
  return {
    den, app, web, shell, proxy, defaultEnabled,
    orgA: { id: text(orgA.id), name: text(orgA.name) }, orgB: { id: text(orgB.id), name: text(orgB.name) },
    email: den.admin.email, baselineA, baselineB, baselineSessionCount, sessionCount,
    async exchangeExistingHandoff() {
      // Existing production grant helper + unchanged documented control action.
      // The grant and response remain in this closure, never in evidence args.
      const grant = await createDesktopHandoffGrant(den.admin);
      const result = record(await control(app, "auth.exchange-grant", { grant, baseUrl: den.ref.webUrl, apiBaseUrl: den.ref.apiUrl }));
      return { email: typeof result.email === "string" ? result.email : null };
    },
    args: { baseUrl: den.ref.webUrl, apiBaseUrl: den.ref.apiUrl },
    faultArgs: { baseUrl: den.ref.webUrl, apiBaseUrl: proxy.ref.apiUrl },
    rollout, features: publicFeatures,
    async enableOrganizationOverride() {
      const result = await api(`/v1/admin/organizations/${encodeURIComponent(text(orgB.id))}/capabilities`, {
        method: "PUT", body: JSON.stringify({ capabilities: { remoteDesktopDeviceLogin: true } }),
      });
      if (!result.response.ok) throw new Error(`Organization override: HTTP ${result.response.status}`);
      return result.response.status;
    },
    async packagedOrigin() { return evaluateOnSurface(app, () => ({ protocol: location.protocol, origin: location.origin, path: location.pathname })); },
    async codeStatus(client = clientId) {
      const result = await denFetch(den.ref, "/api/auth/device/code", { method: "POST", body: JSON.stringify({ client_id: client }), signal: AbortSignal.timeout(15_000) });
      return { status: result.response.status, error: record(result.body).error };
    },
    async offBoundaries() {
      const decision = await api("/v1/auth/device/decision", { method: "POST", body: JSON.stringify({ userCode: text(pendingCode.user_code), decision: "approve", organizationId: text(orgB.id) }) });
      const redemption = await denFetch(den.ref, tokenPath, { method: "POST", body: JSON.stringify({ client_id: clientId, device_code: text(pendingCode.device_code), grant_type: "urn:ietf:params:oauth:grant-type:device_code" }), signal: AbortSignal.timeout(15_000) });
      return { decisionStatus: decision.response.status, tokenStatus: redemption.response.status, sessionIssued: typeof record(redemption.body).access_token === "string" };
    },
    async approveWithoutOrganization(userCode: string) {
      return (await api("/v1/auth/device/decision", { method: "POST", body: JSON.stringify({ userCode: userCode.replaceAll("-", ""), decision: "approve" }) })).response.status;
    },
    async runnerRegistration() {
      const [inA, inB] = await Promise.all([targetsA(), targetsB()]);
      const addedB = inB.filter(item => !baselineB.some(before => before.computerId === item.computerId));
      const log = await den.apiLog();
      const sessionOnlyTokenMinted = log.split("\n").some(line => {
        try { const entry = record(JSON.parse(line)); return entry.http_route === "/v1/session-runners/token" && entry.http_status_code === 200; }
        catch { return false; }
      });
      return { inA, addedB, sessionOnlyTokenMinted, sameIdentityAbsentInA: addedB.every(item => !inA.some(other => other.computerId === item.computerId)) };
    },
    async tokenFault(error: "expired_token" | "slow_down" | "authorization_pending", status = 400, headers?: Record<string, string>) { await proxy.faults.status(tokenPath, status, { times: 1, method: "POST", body: { error }, headers }); },
    async holdNextToken() { await proxy.faults.latency(tokenPath, 9_000, { times: 1, method: "POST" }); },
    async traffic() {
      const requests = await proxy.requestLog();
      if (!proxy.arrivals) throw new Error("The proxy does not expose its read-only token-arrival witness.");
      const arrivals = await proxy.arrivals();
      return { codes: requests.filter(item => item.path === "/api/auth/device/code"), tokens: requests.filter(item => item.path === tokenPath), tokenArrivals: arrivals.filter(item => item.path === tokenPath) };
    },
    async custody(output: string) {
      const desktopLog = await shell.desktopLog();
      // Read-only digest/booleans: neither session bearer leaves the renderer.
      const result = await evaluateOnSurface(app, browserScript(async (captured, log) => {
        const token = localStorage.getItem("openwork.den.authToken") ?? "";
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
        return { tokenPresent: token.length > 0, digest: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
          outputContainsToken: token.length > 0 && captured.includes(token), logContainsToken: token.length > 0 && log.includes(token), activeOrgId: localStorage.getItem("openwork.den.activeOrgId") };
      }, [output, desktopLog]), { awaitPromise: true });
      return { tokenPresent: result.tokenPresent, distinctBrowserSession: result.digest !== createHash("sha256").update(den.admin.token).digest("hex"),
        outputContainsToken: result.outputContainsToken, outputContainsBrowserToken: output.includes(den.admin.token), activeOrgId: result.activeOrgId,
        logContainsBrowserToken: desktopLog.includes(den.admin.token), logContainsToken: result.logContainsToken };
    },
    async [Symbol.asyncDispose]() {
      await shell.stop();
      await rollout(false);
      // A packaged executable is not named electron. Use the maintained
      // graceful quit so runtime children close before host disposal.
      await quitDesktop(app);
      await app.stop();
      await shell.removeProfile();
    },
  };
}
