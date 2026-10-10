import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { denFetch } from "@openwork/behaviors";
import { allocateFreePort, evaluateOnSurface, type Surface } from "@openwork/cdp";
import { defaultDaytonaExec, execInSandbox, readSandboxRepoSourceReceipt, startScriptOnSandbox } from "@openwork/hosts";
import type { Place, Seed } from "@openwork/env";
import { object, records, string, remoteSessionGateway } from "./fixtures/remote-session-gateway.ts";

export { object, record, records, string } from "./fixtures/remote-session-gateway.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const pluginDirectory = join(repoRoot, "packages/opencode-plugin");
const fixturePath = join(import.meta.dirname, "fixtures/opencode-native-fixture.mjs");
export type OpenCodeRun = { status: number | null; stdout: string; stderr: string };
export type PluginLogin = {
  verificationUrl: string;
  userCode: string;
  finished: Promise<OpenCodeRun>;
  stop(): Promise<void>;
};
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid native fixture number");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid native fixture text");
  return value;
}
function cliResult(value: unknown): OpenCodeRun {
  const result = object(value);
  return { status: result.status === null ? null : number(result.status), stdout: text(result.stdout), stderr: text(result.stderr) };
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Build current source, including the shared runner core, rather than using snapshot dist. */
function pluginArtifact() {
  const built = spawnSync("pnpm", ["--dir", pluginDirectory, "build"], { cwd: repoRoot, encoding: "utf8", timeout: 120_000 });
  if (built.status !== 0) throw new Error(`Building the current OpenCode plugin failed: ${built.stdout}${built.stderr}`);
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const sourceSha = head.stdout.trim();
  if (head.status !== 0 || !/^[0-9a-f]{40,64}$/.test(sourceSha)) throw new Error("Native fixture has no immutable source commit");
  const files = readdirSync(join(pluginDirectory, "dist")).filter(name => name.endsWith(".js")).sort().map(name => {
    const bytes = readFileSync(join(pluginDirectory, "dist", name));
    return { name, base64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  if (!files.some(file => file.name === "server.js")) throw new Error("Current plugin build has no compiled server entrypoint");
  const json = JSON.stringify({ sourceSha, files });
  return { json, sourceSha, sha256: createHash("sha256").update(json).digest("hex") };
}

// probe.dom exposes geometry but not computed font size or line height. This
// fixed, read-only witness measures the real approval headline without changing
// the page, matching style classes, or weakening the design-review rubric.
function deviceApprovalHeading(surface: Surface) {
  return evaluateOnSurface(surface, () => {
    const heading = document.querySelector('[data-testid="setup-frame"] h1');
    if (!heading) throw new Error("The device sign-in heading is missing.");
    const style = getComputedStyle(heading);
    return {
      text: heading.textContent?.trim() ?? "",
      fontSize: Number.parseFloat(style.fontSize),
      lineHeight: Number.parseFloat(style.lineHeight),
      height: heading.getBoundingClientRect().height,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: window.innerHeight,
    };
  });
}

/**
 * World functions run on the driver. Native OpenCode, its proxy, HOME, service
 * and browser callback must instead run on the actual Den browser's host.
 */
export async function opencodePluginSignIn(seed: Seed, options: { remoteSessions?: boolean; place?: Place } = {}) {
  const organizationName = "OpenCode Plugin Org";
  const den = await seed.den({
    org: { name: organizationName, admin: { name: "Native Session Proof Admin", email: "native-session-admin@example.test" }, members: options.remoteSessions ? { other: { name: "Other Plugin Member" } } : {} },
    env: {
      DEN_BOOTSTRAP_ADMIN_EMAILS: "native-session-admin@example.test",
      ...(options.remoteSessions ? {
        DEN_AUTOMATIONS_ENABLED: "false", DEN_AUTOMATIONS_RUNTIME_ENABLED: "false", DEN_OPENWORK_WEB_ENABLED: "false",
      } : {}),
    },
  });
  const web = await seed.web({ den, signedInAs: "admin", headless: true, viewport: { width: 1280, height: 900 } });
  const hostKind = web.handle.hostKind;
  if (hostKind !== "local" && hostKind !== "daytona") throw new Error(`Native OpenCode fixture does not support browser host ${hostKind}`);
  if (options.place && options.place.kind !== hostKind) throw new Error("Browser host does not match the world's selected placement");
  const sandbox = hostKind === "daytona" ? web.handle.sandboxId : undefined;
  if (hostKind === "daytona" && !sandbox) throw new Error("Daytona browser has no sandboxId for its native fixture");
  const artifact = pluginArtifact();
  if (sandbox) {
    const ref = process.env.OPENWORK_EVAL_REF;
    if (!ref || !/^[0-9a-f]{40,64}$/.test(ref) || ref !== artifact.sourceSha) throw new Error("Daytona native proof requires OPENWORK_EVAL_REF equal to the pushed immutable HEAD commit");
    const sourceState = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", "packages/opencode-plugin", "packages/remote-sessions"], { cwd: repoRoot, encoding: "utf8" });
    if (sourceState.status !== 0 || sourceState.stdout.trim()) throw new Error("Commit the current plugin and shared runner source before claiming immutable Daytona artifact provenance");
    const receipt = await readSandboxRepoSourceReceipt({ sandbox, expectedRef: ref });
    if (receipt.actualSha !== artifact.sourceSha) throw new Error("Browser sandbox and current plugin artifact have different source commits");
  }
  const label = `native-opencode-${randomBytes(6).toString("hex")}`;
  // seed.tmpPath is only a driver-side string: never use it as a remote HOME.
  const root = sandbox ? `/workspace/.openwork-daytona/${label}` : seed.tmpPath(label);
  const token = randomBytes(32).toString("hex");
  const source = readFileSync(fixturePath, "utf8");
  const sourceFingerprint = createHash("sha256").update(source).digest("hex");
  await using setup = new AsyncDisposableStack();
  async function remoteExec(script: string, context: string, timeoutMs = 30_000) {
    if (!sandbox) throw new Error("Missing browser sandbox for native fixture execution");
    const encoded = Buffer.from(script).toString("base64");
    return execInSandbox(defaultDaytonaExec, sandbox, `printf %s ${encoded} | base64 -d | bash`, { timeoutMs, context });
  }
  async function upload(path: string, content: string) {
    const encoded = Buffer.from(content).toString("base64");
    await remoteExec(`umask 077\nmkdir -p ${root}\n: > ${path}.b64`, "Native plugin artifact upload setup");
    for (let offset = 0; offset < encoded.length; offset += 8192) {
      await remoteExec(`printf %s ${encoded.slice(offset, offset + 8192)} >> ${path}.b64`, "Native plugin artifact chunk upload");
    }
    await remoteExec(`base64 -d ${path}.b64 > ${path}\nrm -f ${path}.b64`, "Native plugin artifact upload finalize");
  }
  const port = sandbox
    ? number(JSON.parse((await remoteExec(`node --input-type=module <<NODE\nimport {createServer} from "node:net";\nconst server=createServer();\nserver.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close();});\nNODE`, "Allocate native fixture port on browser host")).stdout.trim()))
    : await allocateFreePort();
  const loopbackUrl = `http://127.0.0.1:${port}`;
  async function control(command: string, body: Record<string, unknown> = {}, timeoutMs = 150_000): Promise<unknown> {
    const payload = JSON.stringify({ ...body, command });
    let envelope: Record<string, unknown>;
    if (sandbox) {
      // Loopback-only and token-authenticated. No public shell or service discovery endpoint.
      const encoded = Buffer.from(payload).toString("base64");
      const result = await remoteExec(`printf %s ${encoded} | base64 -d | curl --silent --show-error --fail --max-time ${Math.ceil(timeoutMs / 1000)} -H "Authorization: Bearer ${token}" -H "Content-Type: application/json" --data-binary @- ${loopbackUrl}/control`, `Native fixture ${command}`, timeoutMs + 10_000);
      envelope = object(JSON.parse(result.stdout.trim()));
    } else {
      const response = await fetch(`${loopbackUrl}/control`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: payload, signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Native fixture control failed: HTTP ${response.status}`);
      envelope = object(await response.json());
    }
    if (envelope.ok !== true) throw new Error(`Native fixture ${command} failed: ${text(envelope.error)}`);
    return envelope.data;
  }
  const fixtureEnv = {
    NATIVE_FIXTURE_ROOT: root, NATIVE_FIXTURE_TOKEN: token, NATIVE_FIXTURE_DEN_API: den.ref.apiUrl,
    NATIVE_FIXTURE_HOST_KIND: hostKind, NATIVE_FIXTURE_ARTIFACT_SHA: artifact.sha256,
    NATIVE_FIXTURE_REMOTE_SESSIONS: options.remoteSessions ? "1" : "0",
  };
  if (sandbox) {
    let helper: Awaited<ReturnType<typeof startScriptOnSandbox>> | undefined;
    // Register cleanup before upload/start. Initialize is called only once the
    // helper is healthy, so a failed start cannot leave a native service behind.
    setup.defer(async () => {
      try { if (helper) await control("shutdown", {}, 40_000); }
      finally {
        // The generic helper stop script repeats its path in a later rm
        // command; pkill can match that shell and return 143. This unique
        // bracketed prefix cannot match its own invocation.
        await remoteExec(`pkill -f "[o]penwork-${label}-" || true`, "Stop owned native fixture helper");
        await remoteExec(`rm -f /tmp/openwork-${label}-${sourceFingerprint.slice(0, 16)}.mjs`, "Remove owned native fixture source");
        await remoteExec(`rm -rf ${root}`, "Remove private native fixture files");
      }
    });
    await upload(`${root}/plugin-artifact.json`, artifact.json);
    helper = await startScriptOnSandbox({ sandbox, label, port, scriptSource: source, env: fixtureEnv, healthPath: "/health", exec: defaultDaytonaExec });
  } else {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "plugin-artifact.json"), artifact.json);
    const child = spawn(process.execPath, [fixturePath], { cwd: repoRoot, env: { ...process.env, ...fixtureEnv, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    child.stdout.on("data", chunk => { logs += String(chunk); });
    child.stderr.on("data", chunk => { logs += String(chunk); });
    setup.defer(async () => {
      try { if (child.exitCode === null) await control("shutdown", {}, 40_000); }
      finally {
        child.kill("SIGTERM");
        if (child.exitCode === null) await Promise.race([new Promise<void>(resolve => child.once("close", () => resolve())), delay(5000).then(() => { child.kill("SIGKILL"); })]);
      }
    });
    const deadline = Date.now() + 15_000;
    while (!await fetch(`${loopbackUrl}/health`, { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false)) {
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Native fixture helper did not start: ${logs.slice(-2000)}`);
      await delay(100);
    }
  }
  const initialized = object(await control("initialize", {}, 240_000));
  if (initialized.artifactSha !== artifact.sha256 || initialized.sourceSha !== artifact.sourceSha || initialized.sourceFingerprint !== sourceFingerprint) throw new Error("Native helper's verified artifact/source receipt does not match this checkout");
  if (sandbox && initialized.platform !== "linux-x64") throw new Error("Daytona proof did not execute the pinned Linux native binary");
  const home = string(initialized.home);
  const directory = string(initialized.directory);
  const fixtureProvenance = {
    hostKind, sandboxId: sandbox ?? null, browserSandboxId: web.handle.sandboxId ?? null,
    platform: string(initialized.platform), artifactSha: string(initialized.artifactSha), sourceSha: string(initialized.sourceSha),
    helperSourceSha: sourceFingerprint, binaryIntegrity: string(initialized.binaryIntegrity),
    helperPid: number(initialized.helperPid), servicePort: number(initialized.servicePort),
    restartPidMethod: "opencode api get /api/info before and after private service stop/start",
  };
  async function run(args: string[], timeoutMs = 120_000) { return cliResult(await control("run", { args, timeoutMs }, timeoutMs + 15_000)); }
  async function native(path: string): Promise<unknown> {
    const result = await run(["api", "get", path]);
    if (result.status !== 0) throw new Error(`Native OpenCode ${path} failed: exit ${result.status} ${result.stdout}${result.stderr}`);
    try { return JSON.parse(result.stdout); }
    catch { throw new Error(`Native OpenCode ${path} did not return JSON: ${result.stdout.slice(0, 500)}`); }
  }
  async function loginStatus(id: string) { return object(await control("login-status", { id }, 15_000)); }
  async function startLogin(method: "browser" | "code", options: { throttleTokenPoll?: boolean } = {}): Promise<PluginLogin> {
    const id = string(object(await control("login-start", { method, throttleTokenPoll: options.throttleTokenPoll === true })).id);
    const deadline = Date.now() + 130_000;
    async function status() {
      if (Date.now() >= deadline) throw new Error("Native OpenCode login exceeded its bounded lifecycle");
      const value = await loginStatus(id);
      if (value.error !== null) throw new Error(`Native login spawn failed: ${text(value.error)}`);
      return value;
    }
    let value = await status();
    while (value.verificationUrl === null || value.userCode === null) {
      if (value.result !== null) throw new Error(`Login exited before showing a code: ${cliResult(value.result).stdout.slice(0, 800)}`);
      await delay(250);
      value = await status();
    }
    const finished = (async () => {
      let current = value;
      while (current.result === null) { await delay(sandbox ? 1000 : 250); current = await status(); }
      return cliResult(current.result);
    })();
    // Early test failures still own this pending login; avoid an unhandled rejection during teardown.
    void finished.catch(() => undefined);
    return { verificationUrl: string(value.verificationUrl), userCode: string(value.userCode), finished, async stop() { await control("login-stop", { id }); } };
  }
  async function setPluginSignIn(enabled: boolean) {
    const result = await denFetch(den.ref, "/v1/admin/features/opencodePlugin", {
      method: "PUT", headers: { authorization: `Bearer ${den.admin.token}` }, body: JSON.stringify({ enabled }),
    });
    if (!result.response.ok) throw new Error(`Turning opencodePlugin ${enabled ? "on" : "off"} failed: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
  }
  const gateway = remoteSessionGateway({ owner: { session: den.admin }, ...(den.members.other ? { other: { session: den.members.other } } : {}) });
  const cleanup = setup.move();
  return {
    den, web, organizationName, home, directory, fixtureProvenance, run, native, startLogin, setPluginSignIn,
    approvalHeading: () => deviceApprovalHeading(web),
    get nativeWorkspaceDirectory() { return directory; },
    nativePlugins: () => native(`/api/plugin?location%5Bdirectory%5D=${encodeURIComponent(home)}`),
    async nativeSessions() { return records(object(await native(`/api/session?directory=${encodeURIComponent(home)}&limit=100`)).data); },
    async nativeSession(sessionId: string) { return object(object(await native(`/api/session/${encodeURIComponent(sessionId)}`)).data); },
    async nativeContext(sessionId: string) { return records(object(await native(`/api/session/${encodeURIComponent(sessionId)}/context`)).data); },
    async nativeInbox(sessionId: string) { return records(object(await native(`/api/session/${encodeURIComponent(sessionId)}/inbox`)).data); },
    remote: (action: "targets" | "create" | "read" | "list" | "send" | "stop", body: Record<string, unknown>, persona = "owner") => gateway.remote(persona, action, body),
    searchRemote: () => gateway.call("owner", "search_capabilities", { query: "remote session targets registered computer", limit: 20 }),
    rollout: gateway.rollout,
    async featureState() {
      const result = await gateway.api("owner", "/v1/admin/features");
      if (result.status !== 200) throw new Error(`Feature inventory failed: HTTP ${result.status}`);
      const feature = records(object(result.body).features).find(item => item.key === "remoteSessionTargets");
      if (!feature) throw new Error("Remote session rollout is absent from the feature inventory");
      return feature;
    },
    webAccess: () => gateway.api("owner", "/v1/billing/web"),
    automationRoute: () => gateway.api("owner", "/v1/automations"),
    async disconnectAfterNextCompletion() { await control("disconnect-next-completion"); },
    async setRunnerConnection(online: boolean) { await control("runner-connection", { online }); },
    async runnerWitness() {
      const witness = object(await control("runner-witness"));
      return { lostCompletionResponses: number(witness.lostCompletionResponses), refusedRequests: number(witness.refusedRequests), requests: records(witness.requests).map(request => ({ method: string(request.method), path: string(request.path), status: number(request.status) })) };
    },
    async restartNativeService() {
      const witness = object(await control("restart", {}, 150_000));
      return { stopped: number(witness.stopped), started: number(witness.started), beforePid: number(witness.beforePid), afterPid: number(witness.afterPid) };
    },
    async tokenPollFault() {
      const witness = object(await control("token-witness"));
      return { injected: number(witness.injected), http429s: number(witness.http429s), authorizations: number(witness.authorizations), retriedPolls: number(witness.retriedPolls) };
    },
    async [Symbol.asyncDispose]() { await cleanup.disposeAsync(); },
  };
}

/** Only this journey opts into native session offloading. Both placements are real native processes. */
export async function opencodePluginRemoteSessions(seed: Seed, context: { place: Place }) {
  return opencodePluginSignIn(seed, { ...context, remoteSessions: true });
}
