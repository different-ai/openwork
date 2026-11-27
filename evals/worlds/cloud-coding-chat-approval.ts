import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dumpScreenState } from "@openwork/cdp";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SkipError, type Place, type Seed } from "@openwork/env";
import { startCloudRuntimeWitness, startMockGithubCloudCoding } from "@openwork/labs";
import { z } from "zod";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export const checkoutRepository = "acme/storefront";
export const checkoutTitle = "Fix one-cent rounding in checkout total";
const checkoutRequest = "Fix the one-cent rounding bug in the checkout total.";
const cloudCodingPath = "/v1/cloud-coding";

function run(command: string, args: string[], cwd: string, home: string) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    execFile(command, args, { cwd, env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    }, encoding: "utf8", timeout: 45_000 }, (error, stdout, stderr) => {
      const code = error ? error.code : 0;
      if (typeof code !== "number") return reject(new Error(`${command} could not complete.`));
      resolve({ code, output: `${stdout}${stderr}`.replace(/(?:gh[sur]_|occ_task_)[\w-]+/g, "[redacted]") });
    });
  });
}

export async function cloudCodingChatApprovalWorld(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("Den, the cloud computer, Chrome, and the lab must share loopback");
  if (process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) throw new Error("Unset OPENWORK_EVAL_DEN_API_URL to use the isolated GitHub and cloud runtime fixtures.");
  await using setup = new AsyncDisposableStack();
  const scratch = seed.tmpPath("acme-cloud-coding");
  await mkdir(scratch, { recursive: true });
  setup.defer(() => rm(scratch, { recursive: true, force: true }));
  const github = setup.use(await startMockGithubCloudCoding({ gitDirectory: scratch }));
  const git = github.git;
  if (!git) throw new Error("The GitHub lab needs bare repositories for the chat proof.");
  const runtime = setup.use(await startCloudRuntimeWitness());
  runtime.ready();
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Acme Corp", admin: { name: "Maya Chen", email: "maya@acme.dev" } },
    env: { ...github.env, DEN_DEPLOYMENT: "cloud", DEN_OPENWORK_WEB_ENABLED: "true", DEN_PLAN_GATING_ENABLED: "false",
      CLOUD_RUNTIME_PROVIDER: "daytona", DAYTONA_API_URL: runtime.url, DAYTONA_API_KEY: "acme-cloud-runtime-fixture",
      DAYTONA_SNAPSHOT: "acme-cloud-runtime", RESEND_API_KEY: "", SMTP_HOST: "" },
  });
  const maya = den.admin;
  github.setDenWebOrigin(den.ref.webUrl);
  const organizationId = await enableOrganizationCapabilities(seed, maya, { cloudCoding: true });
  const post = async (path: string, body: unknown, method = "POST") => {
    const result = await seed.api(maya, path, { method, headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify(body) });
    if (!result.response.ok) throw new Error(`Preparing Acme failed at ${path}: HTTP ${result.response.status} ${result.text.slice(0, 200)}.`);
    return result.body;
  };
  await post(`/v1/admin/organizations/${organizationId}/openwork-web-access`, { enabled: true, reason: "Acme browser proof" }, "PUT");
  const organization = await seed.api(maya, "/v1/org");
  const memberId = z.object({ currentMember: z.object({ id: z.string() }) }).parse(organization.body).currentMember.id;
  await post(`/v1/members/${memberId}/openwork-web`, { enabled: true });
  const install = new URL(z.object({ redirectUrl: z.url() }).parse(await post(`${cloudCodingPath}/github/install/start`, {})).redirectUrl);
  if (install.origin !== github.env.GITHUB_CLOUD_CODING_WEB_BASE) throw new Error("The GitHub install did not point to the Acme lab.");
  const installPage = await fetch(install);
  const confirmation = /name="confirmation" value="([a-f0-9-]+)"/.exec(await installPage.text())?.[1];
  if (!installPage.ok || !confirmation) throw new Error("GitHub did not offer an install confirmation.");
  const authorized = await fetch(install, { method: "POST", body: new URLSearchParams({ confirmation }), redirect: "manual" });
  const redirect = authorized.headers.get("location");
  if (authorized.status !== 303 || !redirect) throw new Error("GitHub did not complete installation.");
  const callback = new URL(redirect);
  const connected = await post(`${cloudCodingPath}/github/callback`, {
    state: callback.searchParams.get("state"), code: callback.searchParams.get("code"), installationId: Number(callback.searchParams.get("installation_id")),
  });
  z.object({ outcome: z.literal("connected") }).parse(connected);
  const main = await git.readBranch(checkoutRepository, "main");
  if (!main) throw new Error("The storefront needs a main branch.");

  const { token } = z.object({ token: z.string() }).parse(await post("/v1/mcp/token", { scopes: ["mcp:read", "mcp:write"] }));
  const workspacePath = join(scratch, "chat");
  await mkdir(workspacePath);
  const localToken = randomUUID();
  const hostToken = randomUUID();
  const { app, workspace } = await signedInAppWeb(seed, { den, webPort, workspacePath: await realpath(workspacePath), engine: "v2", headless: true,
    name: "acme-coding-chat", env: { OPENWORK_TOKEN: localToken, OPENWORK_HOST_TOKEN: hostToken },
    mocks: { agent: seed.mock({}) },
  });
  const model = app.mocks.agent;
  if (!model) throw new Error("The local chat needs a fixture model in its picker.");
  const configured = await fetch(`${app.openworkUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/config`, {
    method: "PATCH", headers: { authorization: `Bearer ${localToken}`, "x-openwork-host-token": hostToken, "content-type": "application/json" },
    body: JSON.stringify({ opencode: { model: "acme/checkout", provider: { acme: { npm: "@ai-sdk/openai-compatible", name: "Acme", options: { baseURL: `${model.url}/v1`, apiKey: "acme-local-fixture" }, models: { checkout: { name: "Acme Checkout" } } } } } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!configured.ok) throw new Error(`The chat workspace could not load its fixture model: HTTP ${configured.status}.`);
  const chat = await seed.session(app, { title: "Storefront checkout" }).catch(async (error: unknown) => {
    throw new Error(`${String(error)}. On screen: ${await dumpScreenState(app)}`);
  });
  const dashboard = await seed.web({ den, signedInAs: maya, startPath: "/dashboard/cloud-coding", headless: true, viewport: { width: 1440, height: 960 } });
  const startReceipt = z.object({ status: z.string().optional(), error: z.string().optional(), taskId: z.string().optional(), sessionId: z.string().optional(), retryAfterMs: z.number().optional() });
  const frameSchema = z.object({ result: z.object({ structuredContent: startReceipt }) });

  async function startTask() {
    let taskId: string | undefined;
    const deadline = Date.now() + 90_000;
    for (let attempt = 1; Date.now() < deadline; attempt++) {
      const reply = await fetch(`${den.ref.apiUrl}/mcp/agent`, { method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: attempt, method: "tools/call", params: {
        name: "execute_capability", arguments: { name: "cloud-coding:start", arguments: { repository: checkoutRepository, task: checkoutRequest, ...(taskId ? { taskId } : {}) } },
      } }), signal: AbortSignal.timeout(35_000) });
      const raw = await reply.text();
      const frame = raw.split("\n").find(line => line.startsWith("data:"))?.slice(5) ?? raw;
      const parsed = frameSchema.safeParse(JSON.parse(frame));
      if (!reply.ok || !parsed.success) throw new Error(`The agent did not return a cloud start receipt (HTTP ${reply.status}).`);
      const receipt = parsed.data.result.structuredContent;
      if (receipt.status === "running" && receipt.taskId && receipt.sessionId) {
        const kickoff = runtime.sessions.find(session => session.id === receipt.sessionId)?.prompts.at(0);
        const command = kickoff?.split("\n").find(line => line.startsWith("mkdir -p ~/.openwork/cloud-coding"));
        const setupArgs = / setup --api "([^"\\]+)" --code "([\w-]+)"$/.exec(command ?? "");
        const code = setupArgs?.[2];
        const helperUrl = `${den.ref.apiUrl}${cloudCodingPath}/gateway/helper.mjs`;
        if (!code || setupArgs?.[1] !== den.ref.apiUrl || !command?.includes(`curl -fsSL "${helperUrl}"`)) throw new Error("The cloud runtime did not receive the expected setup command from Den.");
        const id = receipt.taskId;
        return {
          status: receipt.status,
          leakedSetupCode: raw.includes(code),
          async requestPush(branch: string) {
            const home = join(scratch, id, "home");
            const work = join(scratch, id, "work");
            const state = join(home, ".openwork", "cloud-coding");
            await mkdir(state, { recursive: true });
            await mkdir(work, { recursive: true });
            const helper = join(state, "openwork-code.mjs");
            const downloaded = await fetch(helperUrl, { signal: AbortSignal.timeout(10_000) });
            if (!downloaded.ok) throw new Error(`Could not download the helper: HTTP ${downloaded.status}.`);
            await writeFile(helper, await downloaded.text(), { mode: 0o700 });
            const launch = await run(process.execPath, [helper, "setup", "--api", den.ref.apiUrl, "--code", code], work, home);
            if (launch.code !== 0) throw new Error(`Checkout setup failed (${launch.code}): ${launch.output.replaceAll(code, "[redacted]")}`);
            const cwd = join(work, "storefront");
            const file = join(cwd, "src", "total.js");
            const before = await readFile(file, "utf8");
            if (!before.includes("Math.floor")) throw new Error("The cloned fixture did not have the rounding bug.");
            await writeFile(file, before.replace("Math.floor", "Math.round"));
            const tests = await run("npm", ["test"], cwd, home);
            if (tests.code !== 0 || !/^ℹ pass 1$|^# pass 1$/m.test(tests.output)) throw new Error(`The checkout test did not pass: ${tests.output}`);
            const bodyFile = join(state, "pull-request.md");
            await writeFile(bodyFile, "Round the checkout total to the nearest cent instead of always rounding down.\n");
            const request = await run(process.execPath, [helper, "request-push", "--task", id, "--branch", branch, "--title", checkoutTitle,
              "--body-file", bodyFile, "--tests", "passed", "--test-command", "npm test", "--test-summary", "1 passed", "--wait-seconds", "1"], cwd, home);
            return { ...request, wait: () => run(process.execPath, [helper, "wait", "--task", id], cwd, home) };
          },
        };
      }
      if (receipt.error !== "cloud_runtime_provisioning" && receipt.error !== "cloud_runtime_waking") {
        throw new Error(`Cloud coding did not start: ${receipt.error ?? "no running receipt"}. Cloud witness unhandled routes: ${runtime.unexpected.join(", ") || "none"}.`);
      }
      if (!receipt.taskId) throw new Error("The starting cloud computer did not return a task to retry.");
      taskId = receipt.taskId;
      await new Promise(resolve => setTimeout(resolve, Math.max(1_000, Math.min(receipt.retryAfterMs ?? 1_000, 5_000))));
    }
    throw new Error(`The cloud computer stayed in startup. Cloud witness unhandled routes: ${runtime.unexpected.join(", ") || "none"}.`);
  }

  const resources = setup.move();
  return { app, chat, dashboard, maya, git, mainSha: main.sha, startTask, [Symbol.asyncDispose]: () => resources.disposeAsync() };
}
