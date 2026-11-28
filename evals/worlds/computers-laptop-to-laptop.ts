import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { denFetch, engineSessionProbe } from "@openwork/behaviors";
import { browserScript } from "@openwork/cdp";
import { eventually, queryDenDatabase, resolveEvalEngine, type Place, type Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { computerListResponseSchema } from "@openwork/types/den/computers";
import { remoteDeviceListResponseSchema, remoteDeviceResponseSchema } from "@openwork/types/den/remote-devices";
import { z } from "zod";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

export const travelName = "Travel MacBook";
export const studioName = "Studio Mac";

export async function computersLaptopToLaptop(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local" || resolveEvalEngine() !== "v2") throw new Error("Run locally with --engine v2 for the real desktop runners and microVM.");
  const surfaces = process.env.OPENWORK_EVAL_SURFACES_DIR;
  if (surfaces !== "/private/tmp/ow-c2a-surfaces") throw new Error("Set OPENWORK_EVAL_SURFACES_DIR=/private/tmp/ow-c2a-surfaces to keep personal paths out of the proof.");
  const stack = new AsyncDisposableStack();
  try {
    const den = await seed.den({ web: true, org: {
      name: "Northwind Studio", admin: { name: "Platform operator" },
      members: { maya: { name: "Maya Okafor" }, priya: { name: "Priya Nair" } },
    } });
    const { maya, priya } = den.members;
    if (!maya || !priya) throw new Error("The proof needs its two invented member accounts.");
    const database = den.database?.url;
    if (!database || !new URL(database).pathname.startsWith("/openwork_eval_")) throw new Error("The proof needs a disposable Den database.");
    const orgId = await enableOrganizationCapabilities(seed, den.admin, { computers: true });
    const request = (member: typeof maya, path: string, method = "GET", body?: unknown) => denFetch(member, path, {
      method, headers: { authorization: `Bearer ${member.token}`, "x-openwork-org-id": orgId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    async function renameNewDesktop(label: string, existingId?: string) {
      const device = await eventually(async () => {
        const result = await request(maya, "/v1/remote-devices");
        return remoteDeviceListResponseSchema.parse(result.body).devices.find(item => item.kind === "desktop" && item.id !== existingId);
      }, { within: 60_000, label: "the real desktop registers with Den" });
      if (!device) throw new Error("No new desktop registered.");
      const result = await request(maya, `/v1/remote-devices/${device.id}`, "PATCH", { label });
      if (!result.response.ok) throw new Error(`Renaming to ${label} failed: HTTP ${result.response.status}`);
      return remoteDeviceResponseSchema.parse(result.body).device;
    }

    // The local Chrome launcher prunes orphan profiles. Open both web pages
    // before creating the caller-owned Electron profiles under the same root.
    const webOptions = { den, startPath: "/dashboard/my-computers", headless: true, viewport: { width: 1440, height: 1050 } };
    const ownerWeb = await seed.web({ ...webOptions, signedInAs: maya });
    const otherWeb = await seed.web({ ...webOptions, signedInAs: priya });
    await mkdir("/private/tmp/ow-c2a", { recursive: true });
    await mkdir(surfaces, { recursive: true });
    const root = await mkdtemp("/private/tmp/ow-c2a/run-");
    stack.defer(() => rm(root, { recursive: true, force: true }));
    const profile = await mkdtemp(join(surfaces, "run-"));
    stack.defer(() => rm(profile, { recursive: true, force: true }));
    const sandboxHome = await mkdtemp("/private/tmp/c2a-");
    stack.defer(() => rm(sandboxHome, { recursive: true, force: true }));
    const travelWorkspace = join(root, "travel-macbook", "work");
    const studioWorkspace = join(root, "studio-mac", "work");
    const website = join(root, "studio-mac", "website");
    const drafts = join(root, "studio-mac", "drafts");
    const privateDir = join(root, "studio-mac", "private");
    await Promise.all([travelWorkspace, studioWorkspace, website, drafts, privateDir].map(path => mkdir(path, { recursive: true })));
    const websiteFile = join(website, "brief.txt"), draftFile = join(drafts, "draft.txt"), privateFile = join(privateDir, "secret.txt");
    const websiteText = `Website brief ${randomUUID()}`, draftText = `New draft ${randomUUID()}`, privateText = `Private fixture ${randomUUID()}`;
    await writeFile(websiteFile, websiteText);
    await writeFile(privateFile, privateText);
    const privateStat = await stat(privateFile);
    const mock = (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
    stack.defer(() => mock.stop());
    const provider = { model: "computer-proof/witness", permission: { read: "ask", edit: "ask", shell: "ask" }, provider: { "computer-proof": {
      npm: "@ai-sdk/openai-compatible", name: "Computer proof witness",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-isolated-proof-only" },
      models: { witness: { name: "Computer proof witness", tool_call: true } },
    } } };
    await writeFile(join(travelWorkspace, "opencode.json"), JSON.stringify(provider));
    const env = { OPENWORK_AUTOMATION_RUNNER: "on", OPENWORK_ENGINE_V2_PREVIEW: "1" };
    const travel = await seed.desktop({ den, as: "maya", workspacePath: travelWorkspace, profileDir: join(profile, "travel"), env });
    stack.defer(() => travel.stop());
    const source = await renameNewDesktop(travelName);
    const studio = await seed.desktop({ den, as: "maya", workspacePath: studioWorkspace, profileDir: join(profile, "studio"), env: { ...env, MSB_HOME: sandboxHome } });
    stack.defer(() => studio.stop());
    const target = await renameNewDesktop(studioName, source.id);

    // CDP cannot drive the native directory picker. Seed only its two paths,
    // through the owner API the picker uses. Sharing, edit and allow stay off.
    // The native bridge supplies the host credential without exposing it to the proof.
    const seeded = await seed.evalIn(studio, browserScript(async (paths) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      const response = await fetch(`${String(info.baseUrl).replace(/\/+$/, "")}/computers/sharing`, {
        method: "PUT", headers: { authorization: `Bearer ${info.ownerToken ?? ""}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, sources: [], folders: paths.map(path => ({ path, access: "read" })) }),
      });
      return response.status;
    }, [[website, drafts]]), { awaitPromise: true });
    if (seeded !== 200) throw new Error(`Arranging the two folder picker selections failed: HTTP ${seeded}`);
    await configureProvider(seed, travel, travel.workspaceId, "computer-proof", "witness", provider, "v2");
    const session = await seed.session(travel, { title: "Website and drafts" });
    const native = engineSessionProbe({ engine: "v2", surface: travel, workspaceId: travel.workspaceId });
    const readDraft = () => readFile(draftFile, "utf8").catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    return { travel, studio, ownerWeb, otherWeb, session, source, target, website, drafts,
      websiteFile, websiteText, draftFile, draftText, privateFile, privateText,
      async prepareTurn(promptMarker: string, finalReply: string, steps: MockAgentToolStep[], echoResult = false) {
        const response = await fetch(`${mock.url}/admin/agent-workloads`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply, steps, ...(echoResult ? { finalReplyFrom: "last-tool-text" } : {}) }] }),
        });
        if (!response.ok) throw new Error(`Preparing the scripted turn failed: HTTP ${response.status}`);
      },
      async toolCall(tool: string, matches: (input: Record<string, unknown>) => boolean) {
        const snapshot = await native.snapshot(session.sessionId);
        return snapshot.data?.messages.flatMap(message => message.parts).findLast(part => part.tool === tool && ["completed", "error"].includes(part.status) && matches(part.input)) ?? null;
      },
      async offeredTools(promptMarker: string) {
        const requests = await mock.agentRequests({ promptMarker, atLeast: 1, timeoutMs: 30_000 });
        return [...new Set(requests.flatMap(entry => entry.advertisedToolNames ?? []))].sort();
      },
      async commandCount() {
        // Read-only queue witness: an output check alone cannot prove a call never left the source.
        return (await queryDenDatabase(database, "SELECT id FROM computer_command WHERE target_device_id = ?", [target.id])).length;
      },
      async privateUntouched() {
        const current = await stat(privateFile);
        return current.atimeMs === privateStat.atimeMs && current.mtimeMs === privateStat.mtimeMs;
      },
      async fileSnapshot() { return [await readFile(websiteFile, "utf8"), await readDraft()]; },
      async otherMemberCheck() {
        const list = computerListResponseSchema.parse((await request(priya, "/v1/computers")).body);
        const authorize = (id: string) => request(priya, `/v1/computers/${id}/authorize`, "POST", { action: { type: "read", path: websiteFile } });
        const hidden = await authorize(target.id);
        const unknown = await authorize(`rdv_${"0".repeat(26)}`);
        return { visible: list.computers.some(computer => computer.id === target.id), hidden: hidden.response.status, unknown: unknown.response.status, same: JSON.stringify(hidden.body) === JSON.stringify(unknown.body) };
      },
      async turnOffComputers() {
        const result = await request(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, "PUT", { capabilities: { computers: false } });
        if (!result.response.ok) throw new Error(`Turning off Computers failed: HTTP ${result.response.status}`);
      },
      async stopStudio() {
        await studio.stop();
        const stopped = await fetch(`${studio.handle.cdpUrl}/json/version`, { signal: AbortSignal.timeout(2_000) }).then(() => false, () => true);
        if (!stopped) throw new Error("Studio Mac's Electron process is still reachable after stopping it.");
      },
      async targetListening() {
        // Compare on the DB clock, not a MySQL timestamp decoded in the Mac's time zone.
        const rows = await queryDenDatabase(database, "SELECT TIMESTAMPDIFF(MICROSECOND, last_seen_at, UTC_TIMESTAMP(3)) / 1000 AS age FROM remote_device WHERE id = ?", [target.id]);
        const [{ age }] = z.array(z.object({ age: z.coerce.number().nullable() })).parse(rows);
        return age !== null && age < 45_000;
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
