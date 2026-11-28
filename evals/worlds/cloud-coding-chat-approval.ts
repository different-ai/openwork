import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { dumpScreenState } from "@openwork/cdp";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { queryDenDatabase, SkipError, type Place, type Seed } from "@openwork/env";
import { startCloudRuntimeWitness, startMockGithubCloudCoding } from "@openwork/labs";
import { CLOUD_CODING_WORKER_ID_HEADER, CLOUD_CODING_WORKER_PROOF_HEADER, CLOUD_CODING_WORKER_PROOF_VERSION, cloudCodingWorkerProofMessage } from "@openwork/types/den/cloud-coding";
import { z } from "zod";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

export const checkoutRepository = "acme/storefront";
export const checkoutTitle = "Fix one-cent rounding in checkout total";
const checkoutRequest = "Fix the one-cent rounding bug in the checkout total.";
const cloudCodingPath = "/v1/cloud-coding";
const cloudTaskPrefix = "/tmp/openwork-cloud-coding/";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function folderExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function run(command: string, args: string[], cwd: string, home: string) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    execFile(command, args, { cwd, env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`, HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
    }, encoding: "utf8", timeout: 45_000 }, (error, stdout, stderr) => {
      const code = error ? error.code : 0;
      if (typeof code !== "number") return reject(new Error(`${command} could not complete.`));
      resolve({ code, output: `${stdout}${stderr}`.replace(/(?:gh[sur]_|occ_task_|occ_setup_)[\w-]+/g, "[redacted]") });
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
  const database = den.database;
  if (!database || !new URL(database.url).pathname.startsWith("/openwork_eval_")) throw new Error("The Cloud coding proof needs an isolated eval database.");
  const databaseUrl = database.url;
  // Opening Web starts Maya's computer through Den, before the agent asks for Cloud coding.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const response = await seed.api(maya, "/v1/cloud/instance", { headers: { "x-openwork-org-id": organizationId } });
    const receipt = z.object({ status: z.string(), failure: z.object({ code: z.string() }).optional() }).safeParse(response.body);
    if (response.response.ok && receipt.success && receipt.data.status === "ready") break;
    if (!response.response.ok || !receipt.success || receipt.data.status === "failed" || Date.now() >= deadline) {
      throw new Error(`Maya's cloud computer was not ready: HTTP ${response.response.status}, ${receipt.success ? `${receipt.data.status} ${receipt.data.failure?.code ?? ""}` : response.text.slice(0, 200)}. Runtime unhandled routes: ${runtime.unexpected.join(", ") || "none"}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  const [sandbox] = runtime.sandboxes;
  if (!sandbox?.workerId || runtime.sandboxes.length !== 1) throw new Error("Den did not provision exactly one cloud worker for Maya.");
  // The Daytona witness records the worker ID, not bootstrap secrets. Read only
  // the corresponding activity row from this run's disposable database.
  const [activity] = z.array(z.object({ token: z.string().min(1) })).parse(await queryDenDatabase(databaseUrl,
    `SELECT t.token FROM worker_token t JOIN daytona_sandbox s ON s.worker_id = t.worker_id
     WHERE s.sandbox_id = ? AND t.scope = 'activity' AND t.revoked_at IS NULL`, [sandbox.id]));
  if (!activity) throw new Error("The provisioned worker has no active activity token.");
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
    name: "acme-coding-chat", env: { VITE_OPENWORK_DEPLOYMENT: "web", OPENWORK_TOKEN: localToken, OPENWORK_HOST_TOKEN: hostToken },
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
  const agentProof = createHmac("sha256", activity.token).update(cloudCodingWorkerProofMessage(sandbox.workerId, sha(token))).digest("hex");
  const proofHeaders = { [CLOUD_CODING_WORKER_ID_HEADER]: sandbox.workerId,
    [CLOUD_CODING_WORKER_PROOF_HEADER]: `${CLOUD_CODING_WORKER_PROOF_VERSION}.${agentProof}` };
  const originSessionId = chat.sessionId;
  const frameSchema = z.object({ result: z.object({ structuredContent: z.record(z.string(), z.unknown()) }) });

  async function executeStart(headers: Record<string, string> = {}) {
    const reply = await fetch(`${den.ref.apiUrl}/mcp/agent`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers,
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "execute_capability", arguments: { name: "cloud-coding:start", arguments: { repository: checkoutRepository, task: checkoutRequest, originSessionId } },
    } }), signal: AbortSignal.timeout(35_000) });
    const raw = await reply.text();
    const frame = raw.split("\n").find(line => line.startsWith("data:"))?.slice(5) ?? raw;
    const parsed = frameSchema.safeParse(JSON.parse(frame));
    if (!reply.ok || !parsed.success) throw new Error(`The agent did not return a cloud start receipt (HTTP ${reply.status}).`);
    return parsed.data.result.structuredContent;
  }

  async function countTasks() {
    return (await queryDenDatabase(databaseUrl, "SELECT 1 FROM cloud_coding_task")).length;
  }

  async function startWithoutWorkerProof() {
    const before = await countTasks();
    const receipt = await executeStart();
    return { error: receipt.error, hasTask: "taskId" in receipt, hasSetup: "setupCommand" in receipt, before, after: await countTasks() };
  }

  const readyReceipt = z.object({ ok: z.literal(true), status: z.literal("ready"), taskId: z.string().regex(/^[\w-]+$/),
    repository: z.literal(checkoutRepository), baseBranch: z.literal("main"), workFolder: z.string(),
    setupCommand: z.string(), instructions: z.string(), expiresInMinutes: z.literal(60) });

  async function startTask() {
    const sessionsBefore = runtime.sessions.length;
    const computersBefore = runtime.sandboxes.length;
    const result = await executeStart(proofHeaders);
    const parsed = readyReceipt.safeParse(result);
    if (!parsed.success) throw new Error(`Cloud coding did not return a ready task: ${typeof result.error === "string" ? result.error : "invalid receipt"}.`);
    const { taskId, status, workFolder, setupCommand } = parsed.data;
    const root = `${cloudTaskPrefix}${sha(originSessionId).slice(0, 16)}/${taskId}`;
    const helperUrl = `${den.ref.apiUrl}${cloudCodingPath}/gateway/helper.mjs`;
    // Validate without logging the one-time code, then execute the returned command verbatim apart from the root mapping.
    const code = /--code "(occ_setup_[\w-]+)"/.exec(setupCommand)?.[1];
    if (!code || workFolder !== `${root}/storefront` || setupCommand !==
      `mkdir -p "${root}" && curl -fsSL "${helperUrl}" -o "${root}/openwork-code.mjs" && node "${root}/openwork-code.mjs" setup --api "${den.ref.apiUrl}" --code "${code}" --root "${root}"`) {
      throw new Error("Den did not return the expected per-chat checkout folder and setup command.");
    }
    const localize = (value: string) => value.replaceAll(cloudTaskPrefix, `${scratch}/openwork-cloud-coding/`);
    const taskFolder = localize(root);
    const helper = join(taskFolder, "openwork-code.mjs");
    const home = join(scratch, "agent-home");
    return {
      status, workFolder, hasSeparateSession: "sessionId" in result,
      sessionsBefore, sessionsAfter: runtime.sessions.length, computersBefore, computersAfter: runtime.sandboxes.length,
      async requestPush(branch: string) {
        await mkdir(home, { recursive: true });
        const launch = await run("sh", ["-c", localize(setupCommand)], scratch, home);
        if (launch.code !== 0) throw new Error(`Checkout setup failed (${launch.code}): ${launch.output.replaceAll(code, "[redacted]")}`);
        const checkout = localize(workFolder);
        const file = join(checkout, "src", "total.js");
        const before = await readFile(file, "utf8");
        if (!before.includes("Math.floor")) throw new Error("The cloned fixture did not have the rounding bug.");
        await writeFile(file, before.replace("Math.floor", "Math.round"));
        const tests = await run("npm", ["test"], checkout, home);
        if (tests.code !== 0 || !/^ℹ pass 1$|^# pass 1$/m.test(tests.output)) throw new Error(`The checkout test did not pass: ${tests.output}`);
        const bodyFile = join(taskFolder, "pull-request.md");
        await writeFile(bodyFile, "Round the checkout total to the nearest cent instead of always rounding down.\n");
        const request = await run(process.execPath, [helper, "request-push", "--root", taskFolder, "--branch", branch, "--title", checkoutTitle,
          "--body-file", bodyFile, "--tests", "passed", "--test-command", "npm test", "--test-summary", "1 passed", "--wait-seconds", "1"], checkout, home);
        return { ...request, folderExists: () => folderExists(taskFolder), wait: () => run(process.execPath, [helper, "wait", "--root", taskFolder], scratch, home) };
      },
    };
  }

  const resources = setup.move();
  return { app, dashboard, maya, git, mainSha: main.sha, startTask, startWithoutWorkerProof, [Symbol.asyncDispose]: () => resources.disposeAsync() };
}
