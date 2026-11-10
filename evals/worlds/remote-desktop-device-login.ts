import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { denFetch } from "@openwork/behaviors";
import { browserScript, evaluateOnSurface } from "@openwork/cdp";
import { defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import type { App, Den, Seed } from "@openwork/env";
import { record, rows, text } from "./org-invite.ts";

const exec = promisify(execFile);
const clientId = "openwork-desktop-device";

/** No credential leaves the target host; only public shell output is returned. */
function desktopShell(app: App, den: Den) {
  const profile = app.handle.profileDir;
  const root = app.workspaceRoot;
  if (!profile || !root) throw new Error("The device-login proof requires an owned desktop profile and host workspace.");
  const directory = join(profile, "device-login-proof");
  const sandbox = app.handle.sandboxId;
  async function node(source: string) {
    if (sandbox) {
      const encoded = Buffer.from(source).toString("base64");
      const result = await execInSandbox(defaultDaytonaExec, sandbox,
        `node -e "eval(Buffer.from(\\\"${encoded}\\\",\\\"base64\\\").toString())"`,
        { timeoutMs: 30_000, context: "device-login shell witness" });
      return result.stdout;
    }
    return (await exec(process.execPath, ["-e", source], { timeout: 30_000 })).stdout;
  }
  return {
    async start() {
      // Invoke the product CLI, not an imported implementation or a substitute
      // control server. The app owns its real authenticated loopback bridge.
      const runner = `
        const fs = require("node:fs"); const cp = require("node:child_process");
        const dir = ${JSON.stringify(directory)}; fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const out = fs.openSync(dir + "/output", "w", 0o600);
        const args = ["--conditions=development", "apps/server/bin/openwork-server.mjs", "device-login", "--base-url", ${JSON.stringify(den.ref.webUrl)}, "--api-base-url", ${JSON.stringify(den.ref.apiUrl)}];
        const child = cp.spawn(process.execPath, args, { cwd: ${JSON.stringify(root)},
          env: { ...process.env, OPENWORK_UI_CONTROL_DISCOVERY: ${JSON.stringify(join(profile, "electron-userdata", "openwork-ui-control.json"))} },
          stdio: ["ignore", out, out] });
        fs.writeFileSync(dir + "/pid", String(child.pid), { mode: 0o600 });
        child.once("exit", code => fs.writeFileSync(dir + "/exit", String(code), { mode: 0o600 }));
      `;
      await node(`require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(runner)}], { detached: true, stdio: "ignore" }).unref();`);
    },
    async output() {
      return node(`const fs = require("node:fs"); process.stdout.write(fs.existsSync(${JSON.stringify(join(directory, "output"))}) ? fs.readFileSync(${JSON.stringify(join(directory, "output"))}, "utf8") : "");`);
    },
    async desktopLog() {
      const log = app.handle.meta?.log;
      if (!log) throw new Error("The desktop did not publish its private process log path.");
      return node(`const fs = require("node:fs"); process.stdout.write(fs.readFileSync(${JSON.stringify(log)}, "utf8"));`);
    },
    async exitCode() {
      const value = await node(`const fs = require("node:fs"); process.stdout.write(fs.existsSync(${JSON.stringify(join(directory, "exit"))}) ? fs.readFileSync(${JSON.stringify(join(directory, "exit"))}, "utf8") : "pending");`);
      return value.trim() === "pending" ? null : Number(value.trim());
    },
    async stop() {
      await node(`const fs = require("node:fs"); const f = ${JSON.stringify(join(directory, "pid"))}; if (fs.existsSync(f)) { try { process.kill(Number(fs.readFileSync(f, "utf8")), "SIGINT"); } catch {} }`);
    },
  };
}

/** Real Den, a separate approving browser, and a signed-out native desktop. */
export async function remoteDesktopDeviceLogin(seed: Seed) {
  const den = await seed.den({
    org: { name: "Device workspace A", admin: { name: "Device Approver" }, members: {} },
    env: { DEN_FEATURE_REMOTE_DESKTOP_DEVICE_LOGIN: undefined },
  });
  const second = await seed.api(den.admin, "/v1/org", {
    method: "POST", body: JSON.stringify({ name: "Device workspace B" }),
  });
  if (!second.response.ok) throw new Error(`Create second workspace: HTTP ${second.response.status}`);
  const orgB = record(record(second.body).organization);
  const directory = await seed.api(den.admin, "/v1/me/orgs");
  const organizations = rows(record(directory.body).orgs);
  const orgBIndex = organizations.findIndex(org => org.id === orgB.id);
  const orgA = organizations.find((org) => org.id !== orgB.id);
  if (!orgA) throw new Error("The approving user needs two organizations.");
  const active = await seed.api(den.admin, "/v1/me/active-organization", {
    method: "POST", body: JSON.stringify({ organizationId: text(orgA.id) }),
  });
  if (!active.response.ok) throw new Error("Cannot arrange the browser's active workspace A.");
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/device", headless: true, viewport: { width: 1440, height: 1000 } });
  const app = await seed.desktop({ den, signIn: false, workspace: false });
  const shell = desktopShell(app, den);
  const api = (path: string, init?: RequestInit) => denFetch(den.admin, path, {
    ...init, headers: { authorization: `Bearer ${den.admin.token}`, ...init?.headers }, signal: AbortSignal.timeout(15_000),
  });
  return {
    den, app, web, shell, orgA: { id: text(orgA.id), name: text(orgA.name) }, orgB: { id: text(orgB.id), name: text(orgB.name) },
    email: den.admin.email, orgBIndex,
    args: { baseUrl: den.ref.webUrl, apiBaseUrl: den.ref.apiUrl },
    async rollout(enabled: boolean, killed = false) {
      const result = await api("/v1/admin/features/remoteDesktopDeviceLogin", {
        method: "PUT", body: JSON.stringify({ enabled, killed }),
      });
      if (!result.response.ok) throw new Error(`Operator rollout: HTTP ${result.response.status}`);
    },
    async features() {
      const result = await denFetch(den.ref, "/v1/features");
      return record(record(result.body).features).remoteDesktopDeviceLogin;
    },
    async codeStatus(client = clientId) {
      const result = await denFetch(den.ref, "/api/auth/device/code", {
        method: "POST", body: JSON.stringify({ client_id: client }), signal: AbortSignal.timeout(15_000),
      });
      return { status: result.response.status, error: record(result.body).error };
    },
    async approveWithoutOrganization(userCode: string) {
      const result = await api("/v1/auth/device/decision", { method: "POST", body: JSON.stringify({ userCode: userCode.replaceAll("-", ""), decision: "approve" }) });
      return result.response.status;
    },
    async runnerAttempted() {
      const log = await den.apiLog();
      return /\/v1\/(?:automation|session)-runners\/token/.test(log);
    },
    async custody(output: string) {
      // A read-only digest comparison proves independence without returning either
      // session token or embedding it in a CDP expression/error/evidence record.
      const desktopLog = await shell.desktopLog();
      const result = await evaluateOnSurface(app, browserScript(async (captured, log) => {
        const token = localStorage.getItem("openwork.den.authToken") ?? "";
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
        return {
          tokenPresent: token.length > 0,
          digest: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join(""),
          outputContainsToken: token.length > 0 && captured.includes(token),
          logContainsToken: token.length > 0 && log.includes(token),
          activeOrgId: localStorage.getItem("openwork.den.activeOrgId"),
        };
      }, [output, desktopLog]), { awaitPromise: true });
      const browserDigest = createHash("sha256").update(den.admin.token).digest("hex");
      return {
        tokenPresent: result.tokenPresent, distinctBrowserSession: result.digest !== browserDigest,
        outputContainsToken: result.outputContainsToken, outputContainsBrowserToken: output.includes(den.admin.token),
        activeOrgId: result.activeOrgId, logContainsBrowserToken: desktopLog.includes(den.admin.token), logContainsToken: result.logContainsToken,
      };
    },
    async [Symbol.asyncDispose]() {
      await shell.stop();
      await api("/v1/admin/features/remoteDesktopDeviceLogin", { method: "PUT", body: JSON.stringify({ enabled: false, killed: false }) });
    },
  };
}
