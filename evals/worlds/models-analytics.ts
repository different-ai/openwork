import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allocateFreePort } from "@openwork/cdp";
import { provisionOrg } from "@openwork/behaviors";
import { createDaytonaHost, defaultDaytonaExec, execInSandbox } from "@openwork/hosts";
import type { Seed } from "@openwork/env";
function modelsFixtureKey(memberId: string) { return `ow_inf_models-analytics-fixture-${memberId}`; }

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = "evals/packages/labs/src/models-analytics-fixture.mjs";
const fixtureSecrets = {
  DEN_DB_ENCRYPTION_KEY: "models-analytics-fixture-encryption-key-not-for-production",
  BETTER_AUTH_SECRET: "models-analytics-fixture-auth-secret-not-for-production",
};
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an API object");
  return Object.fromEntries(Object.entries(value));
}

export async function modelsAnalyticsWorld(seed: Seed) {
  const den = await seed.den({ web: true, org: { name: "Models Analytics Upgrade", admin: { name: "Models Admin" }, members: { teammate: { name: "Models Member" } } },
    env: { ...fixtureSecrets, DEN_ORG_MODE: "multi_org", OPENROUTER_MANAGEMENT_API_KEY: "fixture-management-unused", DEN_PLAN_GATING_ENABLED: "true" },
  });
  const context = object((await seed.api(den.admin, "/v1/org")).body);
  const orgId = String(object(context.organization).id);
  const memberId = String(object(context.currentMember).id);
  const remote = den.placement?.kind === "daytona" ? den.placement.sandboxId : null;
  const inferencePort = remote ? 8791 : await allocateFreePort();
  const witnessPort = remote ? 8792 : await allocateFreePort();
  const host = remote ? createDaytonaHost({ sandboxId: remote, repoRoot: root, log: () => {} }) : null;
  const inferenceUrl = host ? await host.previewUrl(inferencePort) : `http://127.0.0.1:${inferencePort}`;
  const witnessUrl = host ? await host.previewUrl(witnessPort) : `http://127.0.0.1:${witnessPort}`;
  const databaseUrl = remote ? "mysql://root:password@127.0.0.1:3306/openwork_den" : den.database?.url;
  if (!databaseUrl) throw new Error("The upgrade world requires its own isolated Den database");
  const env = {
    OPENWORK_DEV_MODE: "1", DATABASE_URL: databaseUrl, DB_MODE: "mysql",
    ...fixtureSecrets, SENTRY_DSN: "", NEXT_PUBLIC_SENTRY_DSN: "",
    PORT: String(inferencePort), MODELS_WITNESS_PORT: String(witnessPort),
    OPENROUTER_UPSTREAM_URL: `http://127.0.0.1:${witnessPort}`,
  };
  async function remoteExec(script: string, context: string) {
    if (!remote) throw new Error("Missing isolated server sandbox");
    const encoded = Buffer.from(script).toString("base64");
    return execInSandbox(defaultDaytonaExec, remote, `printf %s ${encoded} | base64 -d | bash`, { timeoutMs: 60_000, context });
  }
  async function arrange(command: string, targetOrgId = orgId) {
    const args = ["node", "--conditions=development", "--import", "./ee/apps/den-api/node_modules/tsx/dist/loader.mjs", fixture, command, targetOrgId, inferenceUrl];
    if (remote) {
      const shell = `cd /workspace && env ${Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ")} ${args.map(quote).join(" ")}`;
      const result = await remoteExec(shell, "Models fixture arrangement");
      if (result.code !== 0) throw new Error("Models fixture arrangement failed");
    } else await new Promise<void>((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), { cwd: root, env: { ...process.env, ...env }, stdio: "pipe" });
      let diagnostic = "";
      child.stderr.on("data", (data) => { diagnostic += data.toString(); });
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Fixture failed: ${diagnostic.slice(-1000)}`)));
    });
  }
  await arrange("subscription");
  const enabled = await seed.api(den.admin, "/v1/inference", { method: "PATCH", body: JSON.stringify({ enabled: true, tier: "tier1" }) });
  if (!enabled.response.ok) throw new Error(`Existing Models subscriber setup failed: HTTP ${enabled.response.status}`);
  await arrange("configure");
  await arrange("before-migration");
  let child: ReturnType<typeof spawn> | null = null;
  if (remote) {
    const config = Buffer.from(JSON.stringify(env)).toString("base64");
    await remoteExec(`cd /workspace && python3 - <<'PY'\nimport os,json,base64,subprocess\ne=dict(os.environ);e.update(json.loads(base64.b64decode('${config}')))\nwith open('/tmp/models-analytics-fixture.log','ab',buffering=0) as log:\n subprocess.Popen(['node','--conditions=development','--import','./ee/apps/den-api/node_modules/tsx/dist/loader.mjs','${fixture}','serve'],env=e,stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)\nPY`, "Start Models inference witness");
  } else child = spawn("node", ["--conditions=development", "--import", "./ee/apps/den-api/node_modules/tsx/dist/loader.mjs", fixture, "serve"], { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" });
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (Date.now() < deadline) {
    healthy = await fetch(`${inferenceUrl}/health`, { signal: AbortSignal.timeout(3_000) }).then((response) => response.ok).catch(() => false);
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!healthy) throw new Error("Models inference did not start");
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/inference", headless: true, viewport: { width: 1440, height: 1100 } });
  return {
    den, web, orgId, memberId, witnessUrl, inferenceUrl,
    async upgradeAnalytics() { await arrange("migrate"); },
    async analyticsStoreUnavailable(unavailable: boolean) { await arrange(unavailable ? "pause-analytics" : "resume-analytics"); },
    async anotherOrganization() { return provisionOrg(den.ref, {}); },
    async verifyErasure() { await arrange("assert-erased"); },
    async anotherSubscriber() {
      const other = await provisionOrg(den.ref, {});
      await arrange("subscription", other.orgId);
      const scoped = { "x-openwork-org-id": other.orgId };
      const enabled = await seed.api(other.admin, "/v1/inference", { method: "PATCH", headers: scoped, body: JSON.stringify({ enabled: true }) });
      if (!enabled.response.ok) throw new Error("Second subscriber setup failed");
      const rollout = await seed.api(den.admin, `/v1/admin/organizations/${other.orgId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { modelsAnalytics: true } }) });
      if (!rollout.response.ok) throw new Error("Second subscriber rollout failed");
      const analytics = await seed.api(other.admin, "/v1/inference/analytics/settings", { method: "PATCH", headers: scoped, body: JSON.stringify({ enabled: true, consentVersion: 1 }) });
      if (!analytics.response.ok) throw new Error("Second subscriber analytics setup failed");
      return other;
    },
    async desktop() {
      // Shape the API directly: the web /api/den route redirects to another
      // origin, which would strip bearer credentials before reaching Den.
      const analyticsTransport = await seed.denLink({ ...den, ref: { ...den.ref, webUrl: den.ref.apiUrl } }, remote ? { sandboxId: remote } : {});
      const desktopDen = { apiUrl: analyticsTransport.ref.webUrl, webUrl: analyticsTransport.ref.webUrl };
      const runtimeConfig = object(await fetch(`${den.ref.webUrl}/api/runtime-config`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.json()));
      const upgradeDenApi = async () => {
        // API discovery must keep the desktop on the independently observed link.
        await analyticsTransport.admin.rules([{ kind: "status", pathPrefix: "/api/runtime-config", statusCode: 200, times: 10_000, body: { ...runtimeConfig, denApiUrl: desktopDen.apiUrl } }]);
      };
      await analyticsTransport.admin.rules([
        { kind: "status", pathPrefix: "/api/runtime-config", statusCode: 200, times: 10_000, body: { ...runtimeConfig, denApiUrl: desktopDen.apiUrl } },
        { kind: "status", pathPrefix: "/v1/inference/analytics", statusCode: 404, times: 10_000, body: { error: "not_found" } },
      ]);
      const modelsAccess = await fetch(`${desktopDen.apiUrl}/v1/inference`, { headers: { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": orgId }, signal: AbortSignal.timeout(10_000) });
      if (!modelsAccess.ok) throw new Error(`Observed Den link cannot access the existing Models subscription: HTTP ${modelsAccess.status}`);
      const app = await seed.desktop({ den: { ...den, ref: desktopDen }, as: "admin", model: "openwork/z-ai/glm-5.2" });
      const workspacePath = seed.tmpPath("models-analytics-upgrade");
      const skillPath = join(workspacePath, ".opencode/skills/analytics-fixture");
      const skill = "---\nname: analytics-fixture\ndescription: A harmless skill for the Models analytics upgrade journey.\n---\n\nReport that Models are working. No files or external services are needed.\n";
      if (app.handle.sandboxId) {
        const script = `mkdir -p ${quote(skillPath)}\nprintf %s ${Buffer.from(skill).toString("base64")} | base64 -d > ${quote(join(skillPath, "SKILL.md"))}\nprintf %s eyJwZXJtaXNzaW9uIjp7InNraWxsIjoiYWxsb3cifX0= | base64 -d > ${quote(join(workspacePath, "opencode.json"))}`;
        const encoded = Buffer.from(script).toString("base64");
        const result = await execInSandbox(defaultDaytonaExec, app.handle.sandboxId, `printf %s ${encoded} | base64 -d | bash`, { timeoutMs: 15_000, context: "Seed native analytics skill" });
        if (result.code !== 0) throw new Error("Native skill arrangement failed");
      } else {
        await mkdir(skillPath, { recursive: true });
        await writeFile(join(skillPath, "SKILL.md"), skill);
        await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({ permission: { skill: "allow" } }));
      }
      await seed.workspace(app, workspacePath, { create: true });
      const session = await seed.session(app, { title: "Existing Models conversation" });
      return { app, session, analyticsTransport, upgradeDenApi };
    },
    async rollout(enabled: boolean) {
      const result = await seed.api(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { modelsAnalytics: enabled } }) });
      if (!result.response.ok) throw new Error(`Rollout fixture failed: ${result.response.status}`);
    },
    async subscription(active: boolean) { await arrange(active ? "restore" : "cancel"); },
    async complete(input: { sessionId: string; taskId: string; model?: string; prompt?: string; stream?: boolean }) {
      const response = await fetch(`${inferenceUrl}/api/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${modelsFixtureKey(memberId)}`,
          "x-openwork-session-id": input.sessionId, "x-openwork-task-id": input.taskId },
        body: JSON.stringify({ model: input.model ?? "z-ai/glm-5.2", messages: [{ role: "user", content: input.prompt ?? "A private task prompt" }], stream: input.stream ?? true }), signal: AbortSignal.timeout(15_000),
      });
      return { status: response.status, body: await response.text() };
    },
    async [Symbol.asyncDispose]() { child?.kill("SIGTERM"); },
  };
}
