import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { denFetch, engineSessionProbe } from "@openwork/behaviors";
import { eventually, resolveEvalEngine, type Place, type Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { SandboxError, withBlocks, type SandboxHandle } from "@openwork/sandbox";
import { computerInventoryDetailResponseSchema } from "@openwork/types/den/computer-inventory";
import { computerListResponseSchema } from "@openwork/types/den/computers";
import { remoteDeviceListResponseSchema, remoteDeviceResponseSchema } from "@openwork/types/den/remote-devices";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export const travelName = "Travel MacBook";
export const cloudFolder = "/tmp/ow-proof";
export const cloudNames = { daytona: "Build box", freestyle: "Preview box", other: "Archive box" };
type LiveProvider = "daytona" | "freestyle";
const opts = { timeoutMs: 60_000 };

async function bounded<T>(timeoutMs: number, operation: () => Promise<T>) {
  const timer = new AbortController();
  try {
    return await Promise.race([operation(), delay(timeoutMs, undefined, { signal: timer.signal }).then(() => { throw new Error("Provider request timed out."); })]);
  } finally { timer.abort(); }
}

export function assertNoProviderKeys(...texts: string[]) {
  for (const value of [process.env.DAYTONA_API_KEY, process.env.FREESTYLE_API_KEY]) {
    const key = value?.trim();
    if (key && texts.some(text => text.includes(key))) throw new Error("A provider credential was found in proof text; it will not be recorded.");
  }
}

async function provision(kind: LiveProvider, stack: AsyncDisposableStack) {
  const title = kind === "daytona" ? "Daytona sandbox" : "Freestyle VM";
  const slug = `ow-computers-proof-${randomUUID()}`;
  const snapshot = process.env.SANDBOX_TEST_SNAPSHOT;
  let phase = "initializing the adapter";
  try {
    // Keep the provider options and create spec in sync with their live block conformance tests.
    const provider = kind === "daytona" ? await import("@openwork/sandbox-daytona").then(({ createDaytonaProvider }) => {
      const apiKey = process.env.DAYTONA_API_KEY?.trim();
      if (!apiKey) throw new Error("DAYTONA_API_KEY is required.");
      return createDaytonaProvider({
        apiKey, apiUrl: process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api", target: process.env.DAYTONA_TARGET,
        snapshot: snapshot ?? "openwork-0.18.55", image: "node:24.22.1-bookworm",
        resources: { cpu: 1, memoryGb: 1, diskGb: 4 }, pollIntervalMs: 100, helperCreateTimeoutMs: 60_000,
        platform: { os: "linux", isolation: "container" },
      });
    }) : await import("@openwork/sandbox-freestyle").then(({ createFreestyleProvider }) => {
      const apiKey = process.env.FREESTYLE_API_KEY?.trim();
      if (!apiKey) throw new Error("FREESTYLE_API_KEY is required.");
      return createFreestyleProvider({ apiKey, snapshot: snapshot ?? "freestyle/ubuntu-sm", firewall: { rules: [] } });
    });
    const { run, files } = withBlocks(provider, ["run", "files"]);
    let created: SandboxHandle | undefined;
    // Register cleanup before create: if the acknowledgement is lost, look up this run's unique slug.
    stack.defer(async () => {
      try {
        let handle = created;
        if (!handle) {
          let sawAbsent = false;
          handle = (await eventually(async () => {
            const found = await bounded(10_000, () => provider.find({ idempotencyKey: slug }));
            sawAbsent = found === null;
            return found;
          }, { within: 20_000, label: "find this proof's cloud computer for cleanup" }).catch(() => {
            if (sawAbsent) return null;
            throw new Error("The provider did not confirm whether the computer exists.");
          })) ?? undefined;
        }
        if (handle) {
          const found = handle;
          await bounded(70_000, () => provider.destroy(found, opts));
          process.stderr.write(`[cloud computers] destroyed ${title}\n`);
        }
      } catch (error) {
        if (error instanceof SandboxError && error.code === "not_found") return;
        throw new Error(`${title}: cleanup failed for ${slug}.`);
      }
    });
    phase = "creating the cloud computer";
    process.stderr.write(`[cloud computers] creating ${title}\n`);
    const handle = created = await provider.create({
      workerId: "", idempotencyKey: slug, image: provider.currentImage(), env: {},
      labels: { "openwork.sandbox.scope": slug }, storage: [], exposePorts: [],
    }, { timeoutMs: 180_000 });
    process.stderr.write(`[cloud computers] created ${title}\n`);
    const externalId = kind === "daytona" ? handle.ref.ref.sandboxId : handle.ref.ref.vmId;
    if (!externalId) throw new Error("The provider did not return its computer id.");
    phase = "waiting for the cloud computer to run";
    const ready = await eventually(() => bounded(15_000, () => provider.inspect(handle)), { within: 120_000, label: title, until: value => !["starting", "creating"].includes(value.state) });
    if (ready.state !== "running") throw new Error("The computer did not start.");
    phase = "seeding the working folder and nonce";
    const nonce = `Cloud proof nonce ${randomUUID()}`;
    const nonceFile = `${cloudFolder}/nonce.txt`, draftFile = `${cloudFolder}/draft.txt`, markerFile = `${cloudFolder}/revoked.txt`;
    const draft = `Cloud draft ${randomUUID()}\n`;
    const result = await run(ready, { ...opts, command: `mkdir -p ${cloudFolder}`, cwd: "/tmp" });
    if (result.exitCode !== 0) throw new Error("The working folder could not be created.");
    await files.write(ready, nonceFile, Buffer.from(nonce), opts);
    process.stderr.write(`[cloud computers] seeded ${title} working folder\n`);
    return { externalId, nonce, nonceFile, draft, draftFile, markerFile,
      async fileExists(path: string) {
        try { return (await files.stat(ready, path, opts)) !== null; }
        catch { throw new Error(`${title}: checking the witness file failed.`); }
      },
      async draftMatches() {
        try { return Buffer.from(await files.read(ready, draftFile, opts)).equals(Buffer.from(draft)); }
        catch { throw new Error(`${title}: reading back the draft failed.`); }
      },
    };
  } catch (error) {
    // SDK failures can hold request headers. Keep only the typed, non-secret error code.
    throw new Error(`${title}: failed while ${phase}${error instanceof SandboxError ? ` (${error.code})` : ""}.`);
  }
}

export async function computersCloudComputers(seed: Seed, { place }: { place: Place }, kind?: LiveProvider) {
  if (place.kind !== "local" || resolveEvalEngine() !== "v2") throw new Error("Run locally with --engine v2 for the real desktop runner.");
  const surfaces = process.env.OPENWORK_EVAL_SURFACES_DIR;
  if (surfaces !== "/private/tmp/ow-c2a-surfaces") throw new Error("Set OPENWORK_EVAL_SURFACES_DIR=/private/tmp/ow-c2a-surfaces to keep personal paths out of the proof.");
  const stack = new AsyncDisposableStack();
  let phase = "starting Den";
  try {
    const den = await seed.den({ web: true, org: {
      name: "Northwind Studio", admin: { name: "Platform operator" }, members: { maya: { name: "Maya Okafor" } },
    } });
    const { maya } = den.members;
    if (!maya) throw new Error("The proof needs its invented member account.");
    const orgId = await enableOrganizationCapabilities(seed, den.admin, { computers: true });
    const request = (path: string, method = "GET", body?: unknown) => denFetch(maya, path, {
      method, headers: { authorization: `Bearer ${maya.token}`, "x-openwork-org-id": orgId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    async function register(provider: keyof typeof cloudNames, externalId: string) {
      const result = await request("/v1/remote-devices", "POST", { provider, label: cloudNames[provider], platform: "linux", externalId, shared: false });
      if (result.response.status !== 201) throw new Error(`Registering the cloud computer failed: HTTP ${result.response.status}`);
      return remoteDeviceResponseSchema.parse(result.body).device;
    }
    phase = "preparing the registered cloud computer";
    const cloud = kind ? await provision(kind, stack) : null;
    const target = kind && cloud ? await register(kind, cloud.externalId) : await register("daytona", `missing-key-${randomUUID()}`);
    const unsupported = kind ? null : await register("other", `unsupported-${randomUUID()}`);

    phase = "starting the desktop and scripted model";
    // Open Chrome before making the caller-owned Electron profile under the shared surfaces root.
    const ownerWeb = await seed.web({ den, startPath: "/dashboard/my-computers", headless: true, viewport: { width: 1440, height: 1050 }, signedInAs: maya });
    await mkdir("/private/tmp/ow-c2a", { recursive: true });
    await mkdir(surfaces, { recursive: true });
    const root = await mkdtemp("/private/tmp/ow-c2a/cloud-");
    stack.defer(() => rm(root, { recursive: true, force: true }));
    const profile = await mkdtemp(join(surfaces, "cloud-"));
    stack.defer(() => rm(profile, { recursive: true, force: true }));
    const workspace = join(root, "travel-macbook", "work");
    await mkdir(workspace, { recursive: true });
    const mock = (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
    stack.defer(() => mock.stop());
    const provider = { model: "computer-proof/witness", permission: { read: "ask", edit: "ask", shell: "ask" }, provider: { "computer-proof": {
      npm: "@ai-sdk/openai-compatible", name: "Computer proof witness",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-isolated-proof-only" },
      models: { witness: { name: "Computer proof witness", tool_call: true } },
    } } };
    await writeFile(join(workspace, "opencode.json"), JSON.stringify(provider));
    const env = {
      OPENWORK_AUTOMATION_RUNNER: "on", OPENWORK_ENGINE_V2_PREVIEW: "1",
      // Empty overrides keep the missing-key test honest even in a keyed run: Electron otherwise inherits the parent env.
      DAYTONA_API_KEY: kind ? process.env.DAYTONA_API_KEY ?? "" : "",
      FREESTYLE_API_KEY: kind ? process.env.FREESTYLE_API_KEY ?? "" : "",
    };
    const travel = await seed.desktop({ den, as: "maya", workspacePath: workspace, profileDir: profile, env });
    stack.defer(() => travel.stop());
    phase = "renaming the source desktop in Den";
    const desktop = await eventually(async () => {
      const result = await request("/v1/remote-devices");
      return remoteDeviceListResponseSchema.parse(result.body).devices.find(item => item.kind === "desktop");
    }, { within: 60_000, label: "the real desktop registers with Den" });
    if (!desktop) throw new Error("The desktop did not register.");
    const renamed = await request(`/v1/remote-devices/${desktop.id}`, "PATCH", { label: travelName });
    if (!renamed.response.ok || remoteDeviceResponseSchema.parse(renamed.body).device.label !== travelName) throw new Error(`Renaming the source desktop failed: HTTP ${renamed.response.status}`);
    phase = "opening the desktop chat";
    // After sign-in, the local server briefly fences config writes while the organization policy settles.
    await eventually(async () => {
      try {
        await configureProvider(seed, travel, travel.workspaceId, "computer-proof", "witness", provider, "v2");
        return true;
      } catch (error) {
        if (error instanceof Error && error.message.includes('"code":"sandbox_only"')) return false;
        return { failure: error };
      }
    }, { within: 40_000, intervalMs: 1_000, label: "the organization policy settles before setting up the scripted model" }).then(result => {
      if (typeof result === "object") throw result.failure;
    });
    const session = await seed.session(travel, { title: `${target.label} cloud work` });
    const native = engineSessionProbe({ engine: "v2", surface: travel, workspaceId: travel.workspaceId });
    return { travel, ownerWeb, session, target, unsupported, cloud,
      async targetAccess() {
        const result = await request("/v1/computers");
        return computerListResponseSchema.parse(result.body).computers.find(item => item.id === target.id)?.access;
      },
      async acceptedWorkCount(id = target.id) {
        const result = await request(`/v1/computers/inventory/${id}`);
        return computerInventoryDetailResponseSchema.parse(result.body).activity.filter(event => event.type === "computer_work_accepted").length;
      },
      async prepareTurn(promptMarker: string, steps: MockAgentToolStep[]) {
        const response = await fetch(`${mock.url}/admin/agent-workloads`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply: "No tool result was returned.", finalReplyFrom: "last-tool-text", steps }] }),
        });
        if (!response.ok) throw new Error(`Preparing the scripted turn failed: HTTP ${response.status}`);
      },
      async toolCall(tool: string, args: Record<string, unknown>) {
        const snapshot = await native.snapshot(session.sessionId);
        return snapshot.data?.messages.flatMap(message => message.parts).findLast(part => part.tool === tool && ["completed", "error"].includes(part.status) && Object.entries(args).every(([key, value]) => part.input[key] === value)) ?? null;
      },
      async offeredSelection(promptMarker: string) {
        const requests = await mock.agentRequests({ promptMarker, atLeast: 1, timeoutMs: 30_000 });
        return requests.some(entry => entry.advertisedToolNames?.includes("runs_on"));
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    const failure = error instanceof Error ? error.message : "Unknown error";
    let cleanupFailure = "";
    try { await stack.disposeAsync(); }
    catch (cleanup) { cleanupFailure = cleanup instanceof Error ? ` Cleanup failed: ${cleanup.message}` : " Cleanup failed."; }
    assertNoProviderKeys(failure, cleanupFailure);
    throw new Error(`Cloud computers setup failed while ${phase}: ${failure}${cleanupFailure}`);
  }
}
