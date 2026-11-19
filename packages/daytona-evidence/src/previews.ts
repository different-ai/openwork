import { randomBytes, randomUUID } from "node:crypto";
import type { BuildProgress, PreviewSession, PreviewWorld, ReviewPreviewProvider } from "@openwork/evidence-provider/review";
import { readAsset } from "@openwork/freestyle/assets";
import { checkoutRecipe, compiledRecipe, dependencyRecipe, toolsRecipe } from "@openwork/freestyle/build-recipes";
import { digest, sourceTree } from "@openwork/freestyle/cache";
import { DaytonaApi, daytonaConfig, type Sandbox } from "./api.ts";
import { DAYTONA_BASE_SNAPSHOT, ensureBase, ensureLayer, runScript, type DaytonaBuildOptions } from "./builder.ts";

/** These are fresh direct app previews, not saved evidence-browser viewers. */
import { DAYTONA_PREVIEW_WORLDS } from "./credentials.ts";
export { DAYTONA_PREVIEW_WORLDS } from "./credentials.ts";
export { PREVIEW_KIND } from "./kinds.ts";
import { PREVIEW_KIND } from "./kinds.ts";
export const PREVIEW_SNAPSHOT_PREFIX = "ow-dy-review-v1-";
export const PREVIEW_TOOLS_PREFIX = "ow-dy-review-tools-v1-";
const ROOT = "/opt/openwork-preview";
const ACCESS_DIR = `${ROOT}/private`;
const ACCESS_FILE = `${ACCESS_DIR}/access.json`;
const APP_USER = "openwork-preview";
const APP_HOME = "/home/openwork-preview";
const APP_BUILD = `${APP_HOME}/build`;
const APP_PATH = `${ROOT}/tools/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
// Bump the immutable world key: v1 worlds ran report code as root and are unsafe.
const SECURITY_VERSION = 2;
const LIFETIME_SECONDS = 2 * 3600;
const BUILDER_KIND = "openwork-daytona-builder-v1";
const RUNTIME_ISOLATION = `User=${APP_USER}
Group=${APP_USER}
NoNewPrivileges=yes
CapabilityBoundingSet=`;
const BUILD_ISOLATION = "setpriv --reuid=openwork-preview --regid=openwork-preview --init-groups --no-new-privs --bounding-set=-all";

function validate(sha: string, world: PreviewWorld) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("A full pushed source SHA is required");
  if (!DAYTONA_PREVIEW_WORLDS.includes(world)) throw new Error("Daytona fresh previews currently support OpenWork web only");
}

/** Signed per-port hosts, never an unsigned sandbox host or a query-token URL. */
export function previewOrigin(value: string): { origin: string; suffix: string } {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || url.pathname !== "/" || !/^8080-[a-z0-9]+\.daytonaproxy\d{2}\.(?:net|eu)$/.test(url.hostname)) {
    throw new Error("Daytona did not issue a supported signed preview host");
  }
  return { origin: url.origin, suffix: url.hostname.slice(url.hostname.indexOf(".")) };
}

// Keep the shared app runtime; adapt only its provider-specific browser domain.
// A checked replacement fails closed if the shared asset changes shape.
function daytonaRuntime(source: string): string {
  const original = 'browserHostSuffix: ".preview.openwork.software"';
  if (source.split(original).length !== 2) throw new Error("Shared app preview runtime has changed");
  return source.replace(original, "browserHostSuffix: process.env.OPENWORK_DAYTONA_PREVIEW_HOST_SUFFIX")
    .replaceAll('"/opt/openwork-preview/services.json"', '"/opt/openwork-preview/state/services.json"')
    .replaceAll('"/opt/openwork-preview/outputs.json"', '"/opt/openwork-preview/state/outputs.json"');
}

function unprivilegedCommand(command: string): string {
  return `${BUILD_ISOLATION} env -i HOME=${APP_HOME} USER=${APP_USER} LOGNAME=${APP_USER} PATH=${APP_PATH} /bin/bash -c '${command.replaceAll("'", "'\\''")}'`;
}

/** These paths are created before report code runs. Never make ROOT app-writable. */
const APP_SETUP = `id -u ${APP_USER} >/dev/null 2>&1 || useradd --system --user-group --create-home --home-dir ${APP_HOME} --shell /usr/sbin/nologin ${APP_USER}
test "$(id -u ${APP_USER})" -ne 0
install -d -o root -g root -m 0755 ${ROOT}
install -d -o ${APP_USER} -g ${APP_USER} -m 0700 ${APP_HOME} ${APP_BUILD} /workspace ${ROOT}/state
install -d -o root -g root -m 0700 ${ACCESS_DIR}
install -o root -g root -m 0600 /dev/null ${ACCESS_FILE}`;

function runtimeUnit(suffix: string): string {
  return `[Unit]
Description=OpenWork fresh web preview
[Service]
Type=oneshot
RemainAfterExit=yes
${RUNTIME_ISOLATION}
RestrictSUIDSGID=yes
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
PrivateTmp=yes
UMask=0077
ReadWritePaths=/workspace ${APP_HOME} ${ROOT}/state
InaccessiblePaths=${ACCESS_DIR} /root
WorkingDirectory=/workspace
Environment=HOME=${APP_HOME} USER=${APP_USER} LOGNAME=${APP_USER}
Environment=PATH=${APP_PATH}
Environment=OPENWORK_DAYTONA_PREVIEW_HOST_SUFFIX=${suffix}
ExecStart=/usr/bin/env node ${ROOT}/runtime.mjs
`;
}

function unprivilegedCompile(source: string): string {
  for (const { name, count } of [{ name: "compiled-files", count: 2 }, { name: "compiled.tar", count: 1 }]) {
    const original = `${ROOT}/${name}`;
    if (source.split(original).length !== count + 1) throw new Error("Shared compile recipe has changed");
    source = source.replaceAll(original, `${APP_BUILD}/${name}`);
  }
  return source;
}

/** systemd retains the root listener even across a gateway restart: no port-squatting race. */
function socketActivatedGateway(source: string): string {
  const original = 'server.listen(Number(process.env.OPENWORK_PREVIEW_GATEWAY_PORT ?? 8080), "0.0.0.0");';
  if (source.split(original).length !== 2) throw new Error("Shared preview gateway has changed");
  return source.replace(original, 'if (Number(process.env.LISTEN_FDS) !== 1 || Number(process.env.LISTEN_PID) !== process.pid) throw new Error("Root-owned gateway socket required");\nserver.listen({ fd: 3 });');
}

const GATEWAY_SOCKET = `[Unit]
Description=Root-owned private OpenWork review listener
[Socket]
ListenStream=8080
BindIPv6Only=both
Accept=no
Service=openwork-review-gateway.service
`;
const GATEWAY_SERVICE = `[Unit]
Description=Private OpenWork review gateway
Requires=openwork-review-gateway.socket
After=openwork-review-gateway.socket
[Service]
User=root
Group=root
NoNewPrivileges=yes
Sockets=openwork-review-gateway.socket
Environment=OPENWORK_PREVIEW_ACCESS_FILE=${ACCESS_FILE}
ExecStart=/usr/bin/env node ${ROOT}/gateway.mjs
Restart=on-failure
`;
// No imports from the checkout. Prove the root systemd MainPID owns the kernel
// listening socket, not merely that something answers on the advertised port.
const GATEWAY_OWNER = `import { readFile, readdir, readlink } from "node:fs/promises";
const pid = process.argv[2];
if (!/^[1-9][0-9]*$/.test(pid ?? "")) throw new Error("Missing gateway MainPID");
const status = await readFile("/proc/" + pid + "/status", "utf8");
if (!/^Uid:\\s+0\\s+0\\s+0\\s+0$/m.test(status)) throw new Error("Gateway is not root-owned");
const command = (await readFile("/proc/" + pid + "/cmdline", "utf8")).split("\\0");
if (!command.includes("${ROOT}/gateway.mjs")) throw new Error("Unexpected gateway controller");
const handles = await readdir("/proc/" + pid + "/fd");
const sockets = new Set(await Promise.all(handles.map((fd) => readlink("/proc/" + pid + "/fd/" + fd).catch(() => ""))));
let owned = false;
for (const table of ["tcp", "tcp6"]) {
  const content = await readFile("/proc/net/" + table, "utf8").catch((error) => {
    // IPv4-only kernels omit tcp6. Other missing/unreadable observations fail closed.
    if (table === "tcp6" && error?.code === "ENOENT") return "";
    throw error;
  });
  const lines = content.trim().split("\\n").slice(1);
  for (const line of lines) {
    const fields = line.trim().split(/\\s+/);
    if (fields[1]?.split(":").at(-1) !== "1F90" || fields[3] !== "0A") continue;
    if (fields[7] !== "0" || !sockets.has("socket:[" + fields[9] + "]")) throw new Error("Preview port is not owned by the trusted gateway");
    owned = true;
  }
}
if (!owned) throw new Error("Trusted gateway is not listening");
`;
const VERIFY_GATEWAY = `systemctl is-active --quiet openwork-review-gateway.socket openwork-review-gateway.service
node ${ROOT}/gateway-owner.mjs "$(systemctl show --property=MainPID --value openwork-review-gateway.service)"`;

export async function previewDescriptor(sha: string, world: PreviewWorld) {
  validate(sha, world);
  const [runtime, gateway, origins, health] = await Promise.all([
    readAsset("runtime.mjs"), readAsset("gateway.mjs"), readAsset("origins.mjs"), readAsset("health.mjs"),
  ]);
  const scripts = { runtime: daytonaRuntime(runtime), gateway: socketActivatedGateway(gateway), origins,
    health: health.replaceAll('"/opt/openwork-preview/services.json"', '"/opt/openwork-preview/state/services.json"')
      .replaceAll('"/opt/openwork-preview/outputs.json"', '"/opt/openwork-preview/state/outputs.json"'), "gateway-owner": GATEWAY_OWNER };
  const tools = toolsRecipe(world);
  const dependencies = dependencyRecipe(world);
  const compile = unprivilegedCompile(compiledRecipe(world));
  const controllerHash = digest(JSON.stringify({ version: SECURITY_VERSION, base: DAYTONA_BASE_SNAPSHOT, scripts, tools, dependencies, compile,
    isolation: { setup: APP_SETUP, runtime: runtimeUnit(".daytonaproxy00.net"), build: unprivilegedCommand(`/bin/bash ${ROOT}/review-app-build.sh`), socket: GATEWAY_SOCKET, gateway: GATEWAY_SERVICE, verify: VERIFY_GATEWAY } }));
  return { name: `${PREVIEW_SNAPSHOT_PREFIX}${digest(`${sha}\n${world}\n${controllerHash}`)}`,
    toolsName: `${PREVIEW_TOOLS_PREFIX}${digest(DAYTONA_BASE_SNAPSHOT + tools)}`, controllerHash, scripts, tools, dependencies, compile };
}

export async function hasDaytonaPreview(sha: string, world: PreviewWorld, api = reviewDaytonaApi()): Promise<boolean> {
  const descriptor = await previewDescriptor(sha, world);
  return (await api.getSnapshot(descriptor.name))?.state === "active";
}

/** Uses the same private layer locks and guest runner as Daytona evidence preparation. */
export async function buildDaytonaPreview(sha: string, world: PreviewWorld, api = reviewDaytonaApi(), options: DaytonaBuildOptions = {}) {
  const descriptor = await previewDescriptor(sha, world);
  if ((await api.getSnapshot(descriptor.name))?.state === "active") return descriptor;
  // Metadata only on the credentialed host. Public PR code executes solely in its guest.
  await sourceTree(sha, options.sourceFetch);
  const observe = options.observe ?? (() => {});
  await ensureLayer(api, { name: descriptor.name, stage: "review-world", withMemory: true, observe,
    labels: { sourceSha: sha, world, reviewBuild: `${world}-${sha}` },
    parent: () => ensureLayer(api, { name: descriptor.toolsName, stage: "review-tools", withMemory: false, observe,
      parent: () => ensureBase(api, options),
      prepare: (sandbox) => runScript(api, sandbox, "review-tools", descriptor.tools, options),
    }),
    prepare: async (sandbox) => {
      // Daytona rewrites Host. The one port-bound gateway forwards only to app-web;
      // Vite's same-origin engine proxy uses the provider's browser-domain suffix.
      const route = await api.signedPreviewUrl(sandbox.id, 8080, 60);
      const { suffix } = previewOrigin(route);
      for (const [name, source] of Object.entries(descriptor.scripts)) {
        // Only the runtime entry point must be readable by the app UID. The
        // gateway, health controller and its imports remain root-only.
        await api.writeFile(sandbox, `${ROOT}/${name}.mjs`, source, name === "runtime" ? 0o644 : 0o600);
      }
      // Report checkout, installation and builds execute only behind the same
      // unprivileged boundary; the controller and reserved gateway stay root-owned.
      await api.writeFile(sandbox, `${ROOT}/review-app-build.sh`, `#!/bin/bash\nset -euo pipefail\n${checkoutRecipe(sha)}\n${descriptor.dependencies}\n${descriptor.compile}\n`, 0o644);
      await api.writeFile(sandbox, "/etc/systemd/system/openwork-review-runtime.service", runtimeUnit(suffix), 0o600);
      await api.writeFile(sandbox, "/etc/systemd/system/openwork-review-gateway.service", GATEWAY_SERVICE, 0o600);
      await api.writeFile(sandbox, "/etc/systemd/system/openwork-review-gateway.socket", GATEWAY_SOCKET, 0o600);
      await runScript(api, sandbox, "review-world", `${APP_SETUP}
systemctl daemon-reload
systemctl start openwork-review-gateway.socket
systemctl start openwork-review-gateway.service
${VERIFY_GATEWAY}
${unprivilegedCommand(`/bin/bash ${ROOT}/review-app-build.sh`)}
systemctl start openwork-review-runtime
node ${ROOT}/health.mjs
curl --retry 60 --retry-delay 1 --retry-max-time 120 --retry-all-errors -fsS http://127.0.0.1:5178/ >/dev/null
printf %s ${sha} > ${ROOT}/source-sha
printf %s ${descriptor.controllerHash} > ${ROOT}/review-controller
${VERIFY_GATEWAY}`, options);
    },
  });
  return descriptor;
}

export async function daytonaPreviewProgress(sha: string, world: PreviewWorld, api = reviewDaytonaApi()): Promise<BuildProgress> {
  const descriptor = await previewDescriptor(sha, world);
  for (const [name, layer] of [[descriptor.name, "running-template"], [descriptor.toolsName, "tools"], [DAYTONA_BASE_SNAPSHOT, "tools"]]) {
    const sandbox = await api.getSandbox(`ow-dy-build-${digest(name).slice(0, 24)}`);
    if (sandbox?.labels.kind === BUILDER_KIND && !["error", "build_failed", "stopped", "archived", "destroyed"].includes(sandbox.state)) {
      return { building: true, layer, since: sandbox.createdAt, steps: [] };
    }
  }
  return { building: false, steps: [] };
}

export class DaytonaPreviewLaunchError extends Error {
  readonly stage: string;
  readonly sandboxId: string;
  constructor(stage: string, sandboxId: string) {
    super("Daytona preview could not be reached");
    this.name = "DaytonaPreviewLaunchError";
    this.stage = stage;
    this.sandboxId = sandboxId;
  }
}

/** A full authorized page and same-origin backend must answer, not just the launch gateway. */
export async function verifyDaytonaPreview(url: string, token: string, probe: typeof fetch = fetch): Promise<void> {
  const headers = { "x-daytona-skip-preview-warning": "true" };
  const launch = await probe(url, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  const cookie = launch.headers.get("set-cookie")?.split(";", 1)[0];
  await launch.body?.cancel();
  if (launch.status !== 303 || cookie !== `__Host-openwork-preview=${token}`) throw new Error("Private preview handshake failed");
  const origin = new URL(url).origin;
  for (const path of ["/", "/api/openwork/health"]) {
    const response = await probe(`${origin}${path}`, { headers: { ...headers, cookie }, redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Fresh preview service is not ready"); }
    if (path === "/") {
      if (!(await response.text()).includes("/@vite/client")) throw new Error("Fresh preview did not serve the app");
    } else {
      if (!response.headers.get("content-type")?.includes("application/json")) { await response.body?.cancel(); throw new Error("Fresh preview backend did not answer"); }
      await response.json();
    }
  }
}

export async function launchDaytonaPreview(input: { gitSha: string; reportId: string; world: PreviewWorld }, api = reviewDaytonaApi(), probe: typeof fetch = fetch): Promise<PreviewSession> {
  const descriptor = await previewDescriptor(input.gitSha, input.world);
  if (!/^[a-f0-9]{32}$/.test(input.reportId)) throw new Error("Invalid report ID");
  if ((await api.getSnapshot(descriptor.name))?.state !== "active") throw new Error("This commit has no ready Daytona preview");
  const expiresAt = new Date(Date.now() + LIFETIME_SECONDS * 1000).toISOString();
  const created = await api.createSandbox({ name: `ow-dy-review-${randomUUID().replaceAll("-", "")}`, snapshot: descriptor.name,
    labels: { kind: PREVIEW_KIND, sourceSha: input.gitSha, reportId: input.reportId, world: input.world, expiresAt },
    autoStopMinutes: 30, autoDeleteMinutes: 0 });
  let stage = "restore";
  let owned = created.labels.kind === PREVIEW_KIND && created.labels.sourceSha === input.gitSha
    && created.labels.world === input.world && created.labels.reportId === input.reportId && created.labels.expiresAt === expiresAt;
  try {
    if (!owned) throw new Error("Preview creation ownership mismatch");
    if (created.public !== false) throw new Error("Provider did not confirm a private preview");
    const sandbox: Sandbox = await api.waitForSandbox(created.id, ["started"]);
    if (sandbox.id !== created.id || sandbox.labels.kind !== PREVIEW_KIND || sandbox.labels.sourceSha !== input.gitSha
      || sandbox.labels.world !== input.world || sandbox.labels.reportId !== input.reportId || sandbox.labels.expiresAt !== expiresAt) {
      owned = false;
      throw new Error("Preview ownership mismatch");
    }
    if (sandbox.public !== false) throw new Error("Restored preview is not private");
    stage = "verify-source";
    const [source, controller, head] = await Promise.all([
      api.readFile(sandbox, `${ROOT}/source-sha`), api.readFile(sandbox, `${ROOT}/review-controller`),
      api.execChecked(sandbox, unprivilegedCommand("cd /workspace && /usr/bin/git rev-parse HEAD"), 30),
    ]);
    if (source?.trim() !== input.gitSha || head.trim() !== input.gitSha || controller?.trim() !== descriptor.controllerHash) throw new Error("Preview source mismatch");
    stage = "deadline";
    // This runs in the clone, never the reusable snapshot. The guest shuts down
    // even if the review function dies; provider auto-delete reclaims stopped VMs.
    const remaining = Math.floor((Date.parse(expiresAt) - Date.now()) / 1000);
    if (remaining <= 0) throw new Error("Preview expired during restore");
    await api.execChecked(sandbox, `systemd-run --unit=openwork-review-expiry --on-active=${remaining}s /usr/sbin/poweroff`, 30);
    stage = "gateway-owner";
    await api.execChecked(sandbox, VERIFY_GATEWAY, 30);
    await api.execChecked(sandbox, unprivilegedCommand(`test "$(id -u)" -ne 0 && test ! -r ${ACCESS_FILE}`), 30);
    stage = "assign-access";
    const { origin } = previewOrigin(await api.signedPreviewUrl(sandbox.id, 8080, remaining));
    const token = randomBytes(32).toString("base64url");
    await api.writeFile(sandbox, ACCESS_FILE, JSON.stringify({ sandboxId: sandbox.id, sourceSha: input.gitSha, token, expiresAt, allowedOrigins: [origin] }), 0o600);
    stage = "guest-health";
    await api.execChecked(sandbox, `node ${ROOT}/health.mjs`, 75);
    const url = `${origin}/__openwork_launch?token=${token}`;
    stage = "gateway-owner";
    await api.execChecked(sandbox, VERIFY_GATEWAY, 30);
    stage = "private-access";
    await verifyDaytonaPreview(url, token, probe);
    if (Date.parse(expiresAt) <= Date.now()) throw new Error("Preview expired during readiness");
    return { id: sandbox.id, gitSha: input.gitSha, world: input.world, url, expiresAt,
      outputs: { webUrl: { value: url, secret: true, group: "Services", note: "Private fresh OpenWork web preview" }, sourceSha: { value: input.gitSha, group: "World" } } };
  } catch {
    if (owned) await api.deleteSandbox(created.id).catch(() => undefined);
    throw new DaytonaPreviewLaunchError(stage, created.id);
  }
}

function reviewDaytonaApi(): DaytonaApi {
  const config = daytonaConfig();
  const url = new URL(config.apiUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("The review Daytona API requires HTTPS without credentials, query or fragment");
  }
  return new DaytonaApi(config);
}

/** Injectable transport for unit witnesses; the production credential boundary requires HTTPS. */
export function daytonaFreshPreviewMethods(api: () => DaytonaApi = reviewDaytonaApi): Pick<ReviewPreviewProvider, "hasSnapshot" | "buildSnapshot" | "buildProgress" | "launchPreview" | "launchFailureDetails"> {
  return {
    hasSnapshot: (sha, world) => hasDaytonaPreview(sha, world, api()),
    buildSnapshot: (sha, world) => buildDaytonaPreview(sha, world, api()),
    buildProgress: (sha, world) => daytonaPreviewProgress(sha, world, api()),
    launchPreview: (input) => launchDaytonaPreview(input, api()),
    launchFailureDetails: (error) => error instanceof DaytonaPreviewLaunchError ? {
      stage: error.stage,
      ...(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(error.sandboxId) ? { vmId: error.sandboxId } : {}),
    } : {},
  };
}

