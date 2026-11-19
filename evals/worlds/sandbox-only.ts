import { browserScript } from "@openwork/cdp";
import { engineSessionProbe, evalIn, go } from "@openwork/behaviors";
import { resolveEvalEngine, type Place, type Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configureProvider } from "./chat.ts";
import { isRecord, records } from "./library.ts";
import { enableOrganizationCapabilities, seededOrganizationId } from "./organization-capabilities.ts";

/** Only isolated, seeded Den data; never a member's production organization. */
async function organization(seed: Seed, enabled: boolean, web = true) {
  const den = await seed.den({ web, org: {
    name: `Sandbox tools proof ${Date.now()}`,
    admin: { name: "Avery Owner" },
    members: { riley: { name: "Riley Contractor" }, morgan: { name: "Morgan Staff" } },
  } });
  const organizationId = enabled
    ? await enableOrganizationCapabilities(seed, den.admin, { sandboxTools: true })
    : await seededOrganizationId(seed, den.admin);
  const riley = den.members.riley;
  const morgan = den.members.morgan;
  if (!riley || !morgan || !organizationId) throw new Error("The sandbox proof organization was not provisioned");
  const context = await seed.api(riley, "/v1/org");
  const membership = isRecord(context.body) && isRecord(context.body.currentMember) ? context.body.currentMember : null;
  if (typeof membership?.id !== "string") throw new Error("Riley's membership is missing");
  const team = await seed.api(den.admin, "/v1/teams", {
    method: "POST", body: JSON.stringify({ name: "Contractors", memberIds: [membership.id] }),
  });
  const teamId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
  if (!team.response.ok || typeof teamId !== "string") throw new Error(`Creating Contractors failed: ${team.text}`);
  const teamPath = `/v1/agent-permissions/teams/${encodeURIComponent(teamId)}`;
  return { den, organizationId, teamId, teamPath, riley, morgan };
}

async function controlsWorld(seed: Seed, enabled: boolean) {
  const world = await organization(seed, enabled);
  if (enabled) {
    const saved = await seed.api(world.den.admin, world.teamPath, {
      method: "PUT", headers: { "X-OpenWork-Sandbox-Only": "1" }, body: JSON.stringify({ settings: { hostExecution: { decision: "deny" } } }),
    });
    if (!saved.response.ok) throw new Error(`Arranging the team's existing restriction failed: ${saved.text}`);
  }
  const web = await seed.web({ den: world.den, signedInAs: world.den.admin,
    startPath: `/dashboard/members/teams/${world.teamId}?tab=agents`,
    headless: true, viewport: { width: 1440, height: 1200 },
  });
  return { ...world, web,
    everyoneUrl: `${world.den.ref.webUrl}/dashboard/members/teams/everyone?tab=agents`,
    teamUrl: `${world.den.ref.webUrl}/dashboard/members/teams/${world.teamId}?tab=agents`,
  };
}

/** Portable Den-only proof: it needs no /dev/kvm, host token or microVM. */
export const sandboxControls = (seed: Seed) => controlsWorld(seed, true);
export const sandboxControlsFlagOff = (seed: Seed) => controlsWorld(seed, false);

/** A signed-out person's real local settings, with no verified sandbox rollout. */
export async function sandboxSignedOutSettings(seed: Seed) {
  const workspacePath = seed.tmpPath("sandbox-signed-out");
  const app = await seed.appWeb({ workspacePath, engine: "v2", mouse: true });
  const workspace = await seed.workspace(app, workspacePath);
  // A saved stricter local preference must remain visible even after sign-out
  // removes rollout eligibility. Arrange that persisted preference through the
  // same public API as Settings, before the first user act.
  const prepared = await evalIn(app, browserScript(async (workspaceId) => {
    const base = localStorage.getItem("openwork.server.urlOverride") || `http://127.0.0.1:${localStorage.getItem("openwork.server.port")}`;
    const response = await fetch(`${base.replace(/\/+$/, "")}/workspace/${workspaceId}/sandbox-settings`, {
      method: "PUT", headers: { authorization: `Bearer ${localStorage.getItem("openwork.server.token")}`, "content-type": "application/json" },
      body: JSON.stringify({ allowHostExecution: false }),
    });
    return response.status;
  }, [workspace.workspaceId]), { awaitPromise: true });
  if (prepared !== 200) throw new Error(`Arranging the signed-out preference failed: HTTP ${prepared}`);
  await go(app, "/settings/permissions");
  return { app, workspace, settingsPath: `/workspace/${workspace.workspaceId}/sandbox-settings` };
}

/** Own exactly one short runtime home; never delete it while its app may use it. */
async function ownedSandboxHome(stack: AsyncDisposableStack) {
  const path = await realpath(await mkdtemp("/tmp/owp-"));
  let stopApp: (() => Promise<void>) | undefined;
  stack.defer(async () => {
    // stop() is idempotent, so testkit can also dispose its tracked surface.
    // If stopping fails, leave the home intact and propagate the cleanup error.
    await stopApp?.();
    await rm(path, { recursive: true, force: true });
  });
  return {
    path,
    attachApp(app: { stop(): Promise<void> }) { stopApp = () => app.stop(); },
  };
}

/**
 * LOCAL ONLY: a native Electron app forwards Riley's actual seeded Den session
 * to its embedded server. appWeb does not supply that native host-token bridge.
 * Tool implementations and the microVM are real; only the model is scripted.
 * The nonce file is deliberately a sibling of, not inside, either mount.
 */
async function desktopWorld(seed: Seed, place: Place, enabled: boolean, brokenRuntime = false) {
  if (place.kind !== "local") throw new Error("The live microVM proof must run locally; Daytona's default user cannot open /dev/kvm");
  if (resolveEvalEngine() !== "v2") throw new Error("Run this proof with --engine v2; sandbox tool replacement is a v2 plugin");
  const stack = new AsyncDisposableStack();
  try {
    // The native host handoff uses Den's web proxy as well as its API.
    const world = await organization(seed, enabled);
    const root = seed.tmpPath("sandbox-product");
    await mkdir(root, { recursive: true });
    const fixtureRoot = await realpath(root);
    const workspacePath = join(fixtureRoot, "work");
    const authorizedPath = join(fixtureRoot, "shared");
    const outsidePath = join(fixtureRoot, "private");
    await Promise.all([workspacePath, authorizedPath, outsidePath].map(path => mkdir(path, { recursive: true })));
    const nonce = `host-private-${randomUUID()}`;
    const privateFile = join(outsidePath, "nonce.txt");
    const sentinel = join(outsidePath, "host-fallback-ran.txt");
    const sharedFile = join(authorizedPath, "brief.txt");
    const initialText = `host-first-${randomUUID()}`;
    const updatedText = `host-second-${randomUUID()}`;
    const guestText = `guest-edit-${randomUUID()}`;
    await writeFile(privateFile, nonce);
    await writeFile(sharedFile, initialText);
    const mock = (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
    stack.defer(() => mock.stop());
    // The SDK's Unix sockets have macOS's 104-byte limit. Never inherit the
    // person's production MSB_HOME or put sockets under the long Electron HOME.
    const runtimeHome = await ownedSandboxHome(stack);
    const sandboxHome = runtimeHome.path;
    const env: Record<string, string> = { MSB_HOME: sandboxHome };
    if (brokenRuntime) {
      // A regular file cannot contain the SDK's sockets/database. This is a real
      // unavailable runtime, not a fake provider or simulated tool response.
      const unavailableHome = join(sandboxHome, "unavailable");
      await writeFile(unavailableHome, "This isolated proof intentionally makes the runtime unavailable.");
      env.MSB_HOME = unavailableHome;
    }
    const providerConfig = { provider: { "sandbox-proof": {
      npm: "@ai-sdk/openai-compatible", name: "Sandbox proof witness",
      options: { baseURL: `${mock.url}/v1`, apiKey: "sk-isolated-proof-only" },
      models: { witness: { name: "Sandbox proof witness", tool_call: true } },
    } } };
    // Make the witness available at the engine's first workspace boot, not only
    // after a config-reload race. The selected model is still verified in the UI.
    await writeFile(join(workspacePath, "opencode.json"), JSON.stringify(providerConfig));
    const app = await seed.desktop({ name: "sandbox-product", den: world.den, as: "riley", workspacePath, env });
    runtimeHome.attachApp(app);
    try {
      await configureProvider(seed, app, app.workspaceId, "sandbox-proof", "witness", providerConfig, "v2");
    } catch (error) {
      const diagnostic = await evalIn(app, browserScript(async () => {
        const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
        const response = await fetch(String(info.baseUrl).replace(/\/+$/, "") + "/experimental/engine-v2-preview/status", {
          headers: { authorization: `Bearer ${info.ownerToken ?? info.clientToken ?? ""}` },
        });
        const status = await response.json();
        return { enabled: status.enabled, chatRouting: status.chatRouting, running: status.running,
          lastError: status.lastError, lastWarning: status.lastWarning, page: document.body.innerText.slice(-1200) };
      }, []), { awaitPromise: true }).catch(() => null);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; native diagnostics: ${JSON.stringify(diagnostic)}`);
    }
    const session = await seed.session(app, { title: "Sandbox product proof" });
    const native = engineSessionProbe({ engine: "v2", surface: app, workspaceId: app.workspaceId });
    const appUrl = String(await evalIn(app, browserScript(() => location.href.split("#")[0], [])));
    return { ...world, app, appUrl, session, sandboxHome, workspacePath, authorizedPath, privateFile, sentinel, nonce,
      sharedFile, initialText, updatedText, guestText,
      settingsPath: `/workspace/${encodeURIComponent(app.workspaceId)}/sandbox-settings`,
      foldersPath: `/workspace/${encodeURIComponent(app.workspaceId)}/authorized-folders`,
      async prepareTurn(promptMarker: string, finalReply: string, steps: MockAgentToolStep[]) {
        const response = await fetch(`${mock.url}/admin/agent-workloads`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply, steps }] }),
        });
        if (!response.ok) throw new Error(`Preparing the witness turn failed: HTTP ${response.status}`);
      },
      async toolCall(tool: string, matches: (input: Record<string, unknown>) => boolean) {
        const snapshot = await native.snapshot(session.sessionId);
        if (!snapshot.ok || !snapshot.data) return null;
        return snapshot.data.messages.flatMap(message => message.parts)
          .find(part => part.tool === tool && ["completed", "error"].includes(part.status) && matches(part.input)) ?? null;
      },
      async offeredTools(promptMarker: string) {
        const requests = await mock.agentRequests({ promptMarker, atLeast: 1, timeoutMs: 30_000 });
        return [...new Set(requests.flatMap(request => request.advertisedToolNames ?? []))].sort();
      },
      // This is the other person editing a live mounted folder, not a product
      // setter. The spec compares the resulting tool output and disk bytes.
      hostEditsSharedFile: () => writeFile(sharedFile, updatedText),
      sharedBytes: () => readFile(sharedFile, "utf8"),
      privateBytes: () => readFile(privateFile, "utf8"),
      sentinelExists: () => access(sentinel).then(() => true, () => false),
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}

export const sandboxOnlyDesktop = (seed: Seed, { place }: { place: Place }) => desktopWorld(seed, place, true);
export const sandboxFlagOffDesktop = (seed: Seed, { place }: { place: Place }) => desktopWorld(seed, place, false);
export const sandboxUnavailableDesktop = (seed: Seed, { place }: { place: Place }) => desktopWorld(seed, place, true, true);
/** Managed Settings needs no inference provider or task: the policy itself is the subject. */
export async function sandboxManagedDesktop(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new Error("The managed native Settings proof requires local placement");
  const stack = new AsyncDisposableStack();
  try {
    const world = await organization(seed, true);
    const saved = await seed.api(world.den.admin, world.teamPath, {
      method: "PUT", headers: { "X-OpenWork-Sandbox-Only": "1" },
      body: JSON.stringify({ settings: { hostExecution: { decision: "deny" } } }),
    });
    if (!saved.response.ok) throw new Error(`Arranging the managed host restriction failed: ${saved.text}`);
    const workspacePath = join(seed.tmpPath("sandbox-managed-settings"), "work");
    await mkdir(workspacePath, { recursive: true });
    const runtimeHome = await ownedSandboxHome(stack);
    const app = await seed.desktop({ name: "sandbox-managed-settings", den: world.den, as: "riley", workspacePath, env: { MSB_HOME: runtimeHome.path } });
    runtimeHome.attachApp(app);
    return {
      ...world, app, settingsPath: `/workspace/${encodeURIComponent(app.workspaceId)}/sandbox-settings`,
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}

/** The public desktop-config response describes the permissions for that identity. */
export function hostRules(body: unknown): Record<string, unknown>[] {
  return isRecord(body) && isRecord(body.agentPermissions)
    ? records(body.agentPermissions.rules).filter(rule => rule.action === "host_execution") : [];
}
