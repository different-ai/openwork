/**
 * Kubernetes Den-stack harness for eval environments.
 *
 * This is the kind-backed Den placement: the same eval scenarios target the
 * same OPENWORK_EVAL_DEN_* URLs, but the control plane runs through the Helm
 * chart in a local Kubernetes cluster. Endpoints are exposed with kubectl
 * port-forward instead of kind node port mappings so an existing warm cluster
 * can be reused across profiles without recreating the node config.
 */
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChromeBinary } from "@openwork/hosts";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(MODULE_DIR, "..", "..", "..", "..");
const DEFAULT_STATE_DIR = resolve(MODULE_DIR, "..", "..", "..", "results", ".kube-stack");
const DEFAULT_ELECTRON_USERDATA = process.env.OPENWORK_EVAL_KUBE_ELECTRON_USERDATA?.trim()
  || join(DEFAULT_STATE_DIR, "electron-user-data");

export const KUBE_CLUSTER_NAME = "openwork-kube-lab";
export const KUBE_CONTEXT = `kind-${KUBE_CLUSTER_NAME}`;
export const KUBE_RELEASE_NAME = "openwork-ee";
export const KUBE_NAMESPACE = "default";
export const KUBE_CHART_PATH = "packaging/helm/openwork-ee";
const KUBE_FIXTURE_DIR = "evals/fixtures/kube";
const KUBE_MYSQL_MANIFEST = `${KUBE_FIXTURE_DIR}/mysql.yaml`;
const KUBE_EGRESS_KIND_CONFIG = `${KUBE_FIXTURE_DIR}/kind-config-egress.yaml`;
const KUBE_NETPOL_DIR = `${KUBE_FIXTURE_DIR}/netpol`;
const KUBE_DEFAULT_DENY_EGRESS_MANIFEST = `${KUBE_NETPOL_DIR}/default-deny-egress.yaml`;
const KUBE_ALLOW_CORE_EGRESS_MANIFEST = `${KUBE_NETPOL_DIR}/allow-core.yaml`;
const KUBE_ALLOW_EXTERNAL_EGRESS_TEMPLATE = `${KUBE_NETPOL_DIR}/allow-external.template.yaml`;
const CALICO_MANIFEST_URL = "https://raw.githubusercontent.com/projectcalico/calico/v3.28.2/manifests/calico.yaml";
const DEN_API_SERVICE = `${KUBE_RELEASE_NAME}-den-api`;
const DEN_WEB_SERVICE = `${KUBE_RELEASE_NAME}-den-web`;
const MYSQL_DEPLOYMENT = "openwork-mysql";
const DEN_API_PORT = Number(process.env.OPENWORK_EVAL_DEN_PORT ?? 8790);
const DEN_WEB_PORT = Number(process.env.OPENWORK_EVAL_DEN_WEB_PORT ?? 3005);
const DEN_API_URL = `http://127.0.0.1:${DEN_API_PORT}`;
const DEN_WEB_URL = `http://127.0.0.1:${DEN_WEB_PORT}`;
const DEN_BASE_URL = `http://localhost:${DEN_API_PORT}`;
const DEMO_EMAIL = process.env.DEN_DEMO_OWNER_EMAIL ?? "alex@acme.test";
export const DEMO_PASSWORD = process.env.DEN_DEMO_OWNER_PASSWORD ?? "OpenWorkDemo123!";
const LOCAL_IMAGE_TAG = process.env.OPENWORK_EVAL_KUBE_LOCAL_IMAGE_TAG?.trim() || "kube-lab";
const PUBLISHED_IMAGE_TAG = process.env.OPENWORK_EVAL_KUBE_IMAGE_TAG?.trim() || "latest";
const PUBLISHED_DEN_API_REPOSITORY = "ghcr.io/different-ai/openwork-den-api";
const PUBLISHED_DEN_WEB_REPOSITORY = "ghcr.io/different-ai/openwork-den-web";
const LOCAL_DEN_API_REPOSITORY = "openwork-den-api";
const LOCAL_DEN_WEB_REPOSITORY = "openwork-den-web";

type DenOrgMode = "single_org" | "multi_org";
export type KubeProfile = "single-org" | "multi-org";
export type KubeImageMode = "published" | "local";
export type KubeEgressMode = "allowlist";

export interface KubeExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface KubeExecOptions {
  input?: string;
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type KubeExec = (
  command: string,
  args: string[],
  options?: KubeExecOptions,
) => Promise<KubeExecResult>;

export interface KubeSpawnOptions {
  logName: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stateDir: string;
}

export type KubeSpawnDetached = (
  command: string,
  args: string[],
  options: KubeSpawnOptions,
) => number;

export interface KubeProfileConfig {
  profile: KubeProfile;
  orgMode: DenOrgMode;
  valuesPath: string;
}

export interface KubeImagePlan {
  mode: KubeImageMode;
  denApiRepository: string;
  denWebRepository: string;
  tag: string;
  pullPolicy: string;
  reason: string;
}

interface KubePlatform {
  os: string;
  architecture: string;
}

interface KubeRuntime {
  run: KubeExec;
  spawnDetached: KubeSpawnDetached;
  stateDir: string;
  log(message: string): void;
  killProcess(pid: number, signal?: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

interface KubeLayerOptions {
  exec?: KubeExec;
  spawnDetached?: KubeSpawnDetached;
  stateDir?: string;
  log?: (message: string) => void;
  killProcess?: (pid: number, signal?: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface EnsureKubeStackOptions extends KubeLayerOptions {
  cdpCandidates: string[];
  skipApp?: boolean;
  profile?: KubeProfile;
  images?: KubeImageMode;
  egress?: KubeEgressMode;
}

export interface KubeStackDownOptions extends KubeLayerOptions {
  deleteCluster?: boolean;
}

export interface KindEndpoints {
  apiUrl: string;
  webUrl: string;
  token: string;
  adminEmail: string;
  stop(): Promise<void>;
}

function defaultExec(command: string, args: string[], options: KubeExecOptions = {}): Promise<KubeExecResult> {
  return new Promise((resolveExec, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? globalThis.setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs)
      : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolveExec({
        stdout,
        stderr: timedOut ? `${stderr}\nTimed out after ${options.timeoutMs}ms.` : stderr,
        code: timedOut ? 124 : code ?? 1,
      });
    });
    child.stdin.end(options.input ?? "");
  });
}

function defaultSpawnDetached(command: string, args: string[], options: KubeSpawnOptions): number {
  const logFd = openSync(join(options.stateDir, `${options.logName}.log`), "a");
  const child = spawn(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  if (!child.pid) throw new Error(`Could not spawn ${command}.`);
  return child.pid;
}

function createRuntime(options: KubeLayerOptions = {}): KubeRuntime {
  return {
    run: options.exec ?? defaultExec,
    spawnDetached: options.spawnDetached ?? defaultSpawnDetached,
    stateDir: options.stateDir ?? DEFAULT_STATE_DIR,
    log: options.log ?? (() => undefined),
    killProcess: options.killProcess ?? ((pid, signal) => process.kill(pid, signal)),
    sleep: options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

async function phase<T>(runtime: KubeRuntime, name: string, action: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  runtime.log(`kube:${name} starting`);
  try {
    const result = await action();
    runtime.log(`kube:${name} finished in ${formatDuration(Date.now() - startedAt)}`);
    return result;
  } catch (error) {
    runtime.log(`kube:${name} failed after ${formatDuration(Date.now() - startedAt)}`);
    throw error;
  }
}

async function checkedExec(runtime: KubeRuntime, command: string, args: string[], context: string, options: KubeExecOptions = {}): Promise<KubeExecResult> {
  const result = await runtime.run(command, args, options);
  if (result.code !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`${context} failed with exit ${result.code}${detail ? `:\n${detail}` : ""}`);
  }
  return result;
}

function pidStatePath(runtime: KubeRuntime, name: string): string {
  return join(runtime.stateDir, name);
}

async function writePidState(runtime: KubeRuntime, name: string, value: unknown): Promise<void> {
  await mkdir(runtime.stateDir, { recursive: true });
  await writeFile(pidStatePath(runtime, name), String(value));
}

async function readPidState(runtime: KubeRuntime, name: string): Promise<string | null> {
  try {
    return (await readFile(pidStatePath(runtime, name), "utf8")).trim();
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

async function waitForPidGone(pid: number, runtime: KubeRuntime, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!processIsAlive(pid)) return true;
    await runtime.sleep(250);
  }
  return !processIsAlive(pid);
}

async function stopProcess(runtime: KubeRuntime, pid: number, label: string): Promise<void> {
  try {
    runtime.killProcess(-pid, "SIGINT");
  } catch {
    // Process group may already be gone or unsupported.
  }
  try {
    runtime.killProcess(pid, "SIGINT");
    runtime.log(`Stopped ${label} (pid ${pid})`);
  } catch {
    // Already gone.
  }
  if (await waitForPidGone(pid, runtime, 5_000)) return;
  try {
    runtime.killProcess(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  try {
    runtime.killProcess(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  await waitForPidGone(pid, runtime, 1_000);
}

async function stopRecordedProcess(runtime: KubeRuntime, stateName: string, label: string): Promise<void> {
  const rawPid = await readPidState(runtime, stateName);
  if (!rawPid) return;
  const pid = Number(rawPid);
  if (!Number.isInteger(pid) || pid <= 0) return;
  await stopProcess(runtime, pid, label);
}

async function httpOk(url: string, timeoutMs = 2_500): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok;
  } catch {
    return false;
  }
}

async function demoOwnerTokenIsValid(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${DEN_API_URL}/v1/me`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function signInDemoOwner(runtime: KubeRuntime): Promise<{ token: string; email: string }> {
  const existingToken = await mysqlQuery(
    runtime,
    `SELECT s.token FROM \`session\` s JOIN \`user\` u ON u.id=s.user_id WHERE u.email='${DEMO_EMAIL.toLowerCase()}' AND s.expires_at > UTC_TIMESTAMP(3) ORDER BY s.expires_at DESC LIMIT 1;`,
  );
  if (existingToken && await demoOwnerTokenIsValid(existingToken)) {
    runtime.log(`Reusing a valid demo-owner session (${DEMO_EMAIL})`);
    return { token: existingToken, email: DEMO_EMAIL };
  }

  try {
    const response = await fetch(`${DEN_API_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: DEN_BASE_URL,
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || typeof payload.token !== "string" || !payload.token) {
      throw new Error("the response did not contain a session token");
    }
    return { token: payload.token, email: DEMO_EMAIL };
  } catch (error) {
    throw new Error(`Could not obtain a demo-owner session from the kube Den API: ${errorText(error)}`);
  }
}

export function kubeProfileConfig(profile: KubeProfile): KubeProfileConfig {
  if (profile === "single-org") {
    return {
      profile,
      orgMode: "single_org",
      valuesPath: `${KUBE_FIXTURE_DIR}/values/single-org.yaml`,
    };
  }
  return {
    profile,
    orgMode: "multi_org",
    valuesPath: `${KUBE_FIXTURE_DIR}/values/multi-org.yaml`,
  };
}

function parseImageMode(value: string | undefined): KubeImageMode | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (trimmed === "published" || trimmed === "local") return trimmed;
  throw new Error(`Unknown kube image mode: ${trimmed}. Supported: published, local.`);
}

function dockerArchitecture(): string {
  if (process.arch === "x64") return "amd64";
  return process.arch;
}

export function currentDockerPlatform(): KubePlatform {
  return { os: "linux", architecture: dockerArchitecture() };
}

export function manifestSupportsPlatform(manifest: unknown, platform: KubePlatform): boolean {
  if (!isRecord(manifest)) return false;
  if (typeof manifest.os === "string" && typeof manifest.architecture === "string") {
    return manifest.os === platform.os && manifest.architecture === platform.architecture;
  }
  if (!Array.isArray(manifest.manifests)) return false;
  return manifest.manifests.some((entry) => {
    if (!isRecord(entry) || !isRecord(entry.platform)) return false;
    return entry.platform.os === platform.os && entry.platform.architecture === platform.architecture;
  });
}

function publishedImagePlan(reason: string): KubeImagePlan {
  return {
    mode: "published",
    denApiRepository: PUBLISHED_DEN_API_REPOSITORY,
    denWebRepository: PUBLISHED_DEN_WEB_REPOSITORY,
    tag: PUBLISHED_IMAGE_TAG,
    pullPolicy: "IfNotPresent",
    reason,
  };
}

function localImagePlan(reason: string): KubeImagePlan {
  return {
    mode: "local",
    denApiRepository: LOCAL_DEN_API_REPOSITORY,
    denWebRepository: LOCAL_DEN_WEB_REPOSITORY,
    tag: LOCAL_IMAGE_TAG,
    pullPolicy: "IfNotPresent",
    reason,
  };
}

async function inspectManifest(runtime: KubeRuntime, image: string): Promise<unknown> {
  const result = await checkedExec(runtime, "docker", ["manifest", "inspect", image], `docker manifest inspect ${image}`, { timeoutMs: 120_000 });
  const parsed: unknown = JSON.parse(result.stdout);
  return parsed;
}

async function publishedImagesSupportPlatform(runtime: KubeRuntime, platform: KubePlatform): Promise<boolean> {
  const apiManifest = await inspectManifest(runtime, `${PUBLISHED_DEN_API_REPOSITORY}:${PUBLISHED_IMAGE_TAG}`);
  const webManifest = await inspectManifest(runtime, `${PUBLISHED_DEN_WEB_REPOSITORY}:${PUBLISHED_IMAGE_TAG}`);
  return manifestSupportsPlatform(apiManifest, platform) && manifestSupportsPlatform(webManifest, platform);
}

export async function resolveKubeImagePlan(options: { exec?: KubeExec; images?: KubeImageMode; log?: (message: string) => void } = {}): Promise<KubeImagePlan> {
  const runtime = createRuntime({ exec: options.exec, log: options.log });
  const envMode = parseImageMode(process.env.OPENWORK_EVAL_KUBE_IMAGES);
  const requested = options.images ?? envMode;
  const platform = currentDockerPlatform();
  if (requested === "local") {
    return localImagePlan("--images local selected; building and loading local images into kind");
  }
  if (requested === "published") {
    if (!(await publishedImagesSupportPlatform(runtime, platform))) {
      throw new Error(`Published Den images do not advertise ${platform.os}/${platform.architecture}; rerun with --images local.`);
    }
    return publishedImagePlan(`--images published selected; ghcr images support ${platform.os}/${platform.architecture}`);
  }

  try {
    if (await publishedImagesSupportPlatform(runtime, platform)) {
      return publishedImagePlan(`auto-selected published images; ghcr manifests include ${platform.os}/${platform.architecture}`);
    }
    return localImagePlan(`auto-selected local images; ghcr manifests do not include ${platform.os}/${platform.architecture}`);
  } catch (error) {
    runtime.log(`Could not inspect published image manifests; falling back to local images: ${errorText(error)}`);
    return localImagePlan("auto-selected local images because published manifest inspection failed");
  }
}

export function helmImageSetArgs(plan: KubeImagePlan): string[] {
  const args = [
    "--set", `image.tag=${plan.tag}`,
    "--set", `image.pullPolicy=${plan.pullPolicy}`,
  ];
  if (plan.mode === "local") {
    args.push(
      "--set", `denApi.image.repository=${plan.denApiRepository}`,
      "--set", `denWeb.image.repository=${plan.denWebRepository}`,
    );
  }
  return args;
}

export function helmUpgradeArgs(profile: KubeProfileConfig, plan: KubeImagePlan, egress?: KubeEgressMode): string[] {
  const args = [
    "upgrade",
    "--install",
    KUBE_RELEASE_NAME,
    KUBE_CHART_PATH,
    "-f",
    profile.valuesPath,
    ...helmImageSetArgs(plan),
    "--namespace",
    KUBE_NAMESPACE,
    "--create-namespace",
    "--kube-context",
    KUBE_CONTEXT,
    "--timeout",
    "10m",
  ];
  if (egress === "allowlist") {
    args.push(
      "--set", "config.openworkDevMode=0",
      "--set", "config.public.allowPrivateMcpUrls=1",
    );
  }
  return args;
}

export function helmTestArgs(): string[] {
  return ["test", KUBE_RELEASE_NAME, "--namespace", KUBE_NAMESPACE, "--kube-context", KUBE_CONTEXT, "--timeout", "5m"];
}

export function kubectlArgs(args: string[]): string[] {
  return ["--context", KUBE_CONTEXT, ...args];
}

export function rolloutStatusArgs(deployment: string, timeout: string): string[] {
  return kubectlArgs(["rollout", "status", `deployment/${deployment}`, `--timeout=${timeout}`]);
}

export function portForwardArgs(service: string, localPort: number, remotePort: number): string[] {
  return kubectlArgs(["port-forward", `service/${service}`, `${localPort}:${remotePort}`]);
}

async function collectTroubleshooting(runtime: KubeRuntime, labelSelector = `app.kubernetes.io/instance=${KUBE_RELEASE_NAME}`): Promise<string> {
  const probes = [
    { label: "pod status", args: kubectlArgs(["get", "pods", "-l", labelSelector, "-o", "wide"]) },
    { label: "pod descriptions", args: kubectlArgs(["describe", "pods", "-l", labelSelector]) },
    { label: "recent pod logs", args: kubectlArgs(["logs", "-l", labelSelector, "--all-containers", "--tail=160", "--prefix"]) },
  ];
  const sections: string[] = [];
  for (const probe of probes) {
    const result = await runtime.run("kubectl", probe.args, { timeoutMs: 90_000 });
    const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    sections.push(`## ${probe.label}\n$ kubectl ${probe.args.join(" ")}\n${body || `(exit ${result.code}, no output)`}`);
  }
  return sections.join("\n\n");
}

async function ensureRollout(runtime: KubeRuntime, deployment: string, timeout: string): Promise<void> {
  const args = rolloutStatusArgs(deployment, timeout);
  const result = await runtime.run("kubectl", args, { timeoutMs: 420_000 });
  if (result.code === 0) return;
  const diagnostics = await collectTroubleshooting(runtime);
  const detail = [result.stderr.trim(), result.stdout.trim(), diagnostics].filter(Boolean).join("\n\n");
  throw new Error(`kubectl rollout status deployment/${deployment} failed with exit ${result.code}:\n${detail}`);
}

async function waitForCalico(runtime: KubeRuntime): Promise<void> {
  await checkedExec(
    runtime,
    "kubectl",
    kubectlArgs(["rollout", "status", "daemonset/calico-node", "--namespace", "kube-system", "--timeout=300s"]),
    "waiting for calico-node DaemonSet",
    { timeoutMs: 360_000 },
  );
  await checkedExec(
    runtime,
    "kubectl",
    kubectlArgs(["wait", "--for=condition=Ready", "nodes", "--all", "--timeout=300s"]),
    "waiting for kind nodes to become Ready",
    { timeoutMs: 360_000 },
  );
}

async function kindClusterExists(runtime: KubeRuntime): Promise<boolean> {
  const clusters = await runtime.run("kind", ["get", "clusters"], { timeoutMs: 60_000 });
  return clusters.code === 0
    && clusters.stdout.split(/\r?\n/).map((line) => line.trim()).includes(KUBE_CLUSTER_NAME);
}

export async function ensureCluster(options: KubeLayerOptions & { egress?: KubeEgressMode } = {}): Promise<void> {
  const runtime = createRuntime(options);
  const exists = await kindClusterExists(runtime);
  if (exists) {
    if (options.egress === "allowlist") {
      const calico = await runtime.run(
        "kubectl",
        kubectlArgs(["get", "daemonset/calico-node", "--namespace", "kube-system"]),
        { timeoutMs: 60_000 },
      );
      if (calico.code !== 0) {
        throw new Error(
          `Existing kind cluster ${KUBE_CLUSTER_NAME} does not have Calico, so it cannot enforce --kube-egress allowlist. Run --stack-down --delete-cluster first.`,
        );
      }
    }
    runtime.log(`Reusing kind cluster ${KUBE_CLUSTER_NAME}`);
  } else {
    runtime.log(`Creating kind cluster ${KUBE_CLUSTER_NAME} (endpoints use kubectl port-forward)`);
    const args = ["create", "cluster", "--name", KUBE_CLUSTER_NAME];
    if (options.egress === "allowlist") args.push("--config", KUBE_EGRESS_KIND_CONFIG);
    await checkedExec(runtime, "kind", args, `kind create cluster --name ${KUBE_CLUSTER_NAME}`, { timeoutMs: 300_000 });
  }
  await checkedExec(runtime, "kubectl", kubectlArgs(["cluster-info"]), `kubectl cluster-info --context ${KUBE_CONTEXT}`, { timeoutMs: 60_000 });
  if (options.egress === "allowlist") {
    if (!exists) {
      runtime.log("Installing Calico v3.28.2");
      await checkedExec(
        runtime,
        "kubectl",
        kubectlArgs(["create", "-f", CALICO_MANIFEST_URL]),
        "installing Calico",
        { timeoutMs: 180_000 },
      );
    }
    await waitForCalico(runtime);
  }
}

const PREPARE_KIND_STACK_COMMAND = "ensureKubeStack({ cdpCandidates: [], skipApp: true })";

function missingKindStackError(subject: string): Error {
  return new Error(`${subject}. Prepare the shared kind stack first with ${PREPARE_KIND_STACK_COMMAND}.`);
}

async function requireKindStack(runtime: KubeRuntime): Promise<void> {
  if (!(await kindClusterExists(runtime))) {
    throw missingKindStackError(`Kind cluster ${KUBE_CLUSTER_NAME} is not running`);
  }
  const release = await runtime.run("helm", [
    "status",
    KUBE_RELEASE_NAME,
    "--namespace",
    KUBE_NAMESPACE,
    "--kube-context",
    KUBE_CONTEXT,
  ], { timeoutMs: 60_000 });
  if (release.code !== 0) {
    throw missingKindStackError(`Helm release ${KUBE_RELEASE_NAME} is not installed in ${KUBE_CONTEXT}`);
  }
}

export async function ensureImages(plan: KubeImagePlan, options: KubeLayerOptions = {}): Promise<void> {
  const runtime = createRuntime(options);
  runtime.log(`Image mode: ${plan.mode} (${plan.reason})`);
  if (plan.mode === "published") return;

  const apiImage = `${plan.denApiRepository}:${plan.tag}`;
  const webImage = `${plan.denWebRepository}:${plan.tag}`;
  await checkedExec(runtime, "docker", ["build", "-f", "packaging/docker/Dockerfile.den", "-t", apiImage, "."], `docker build ${apiImage}`, { timeoutMs: 20 * 60_000 });
  await checkedExec(runtime, "docker", ["build", "-f", "packaging/docker/Dockerfile.den-web", "-t", webImage, "."], `docker build ${webImage}`, { timeoutMs: 20 * 60_000 });
  await checkedExec(runtime, "kind", ["load", "docker-image", apiImage, "--name", KUBE_CLUSTER_NAME], `kind load docker-image ${apiImage}`, { timeoutMs: 300_000 });
  await checkedExec(runtime, "kind", ["load", "docker-image", webImage, "--name", KUBE_CLUSTER_NAME], `kind load docker-image ${webImage}`, { timeoutMs: 300_000 });
}

export async function ensureDatabase(options: KubeLayerOptions = {}): Promise<void> {
  const runtime = createRuntime(options);
  await checkedExec(runtime, "kubectl", kubectlArgs(["apply", "-f", KUBE_MYSQL_MANIFEST]), `kubectl apply -f ${KUBE_MYSQL_MANIFEST}`, { timeoutMs: 60_000 });
  await ensureRollout(runtime, MYSQL_DEPLOYMENT, "180s");
}

export async function ensureRelease(profile: KubeProfileConfig, plan: KubeImagePlan, options: KubeLayerOptions & { egress?: KubeEgressMode } = {}): Promise<void> {
  const runtime = createRuntime(options);
  const helmArgs = helmUpgradeArgs(profile, plan, options.egress);
  const result = await runtime.run("helm", helmArgs, { timeoutMs: 12 * 60_000 });
  if (result.code !== 0) {
    const diagnostics = await collectTroubleshooting(runtime);
    const detail = [result.stderr.trim(), result.stdout.trim(), diagnostics].filter(Boolean).join("\n\n");
    throw new Error(`helm ${helmArgs.join(" ")} failed with exit ${result.code}:\n${detail}`);
  }
  await ensureRollout(runtime, `${KUBE_RELEASE_NAME}-den-api`, "300s");
  await ensureRollout(runtime, `${KUBE_RELEASE_NAME}-den-web`, "300s");
}

function parseIpv4(output: string): string | null {
  for (const token of output.split(/\s+/)) {
    const parts = token.split(".");
    if (parts.length !== 4) continue;
    if (parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return token;
  }
  return null;
}

async function resolveAllowedHostIp(runtime: KubeRuntime): Promise<string> {
  const nodeLookup = await runtime.run("docker", [
    "exec",
    `${KUBE_CLUSTER_NAME}-control-plane`,
    "sh",
    "-lc",
    "getent hosts host.docker.internal | awk '{print $1}'",
  ], { timeoutMs: 30_000 });
  const nodeIp = nodeLookup.code === 0 ? parseIpv4(nodeLookup.stdout) : null;
  if (nodeIp) return nodeIp;

  const gateway = await checkedExec(
    runtime,
    "docker",
    ["network", "inspect", "kind", "--format", "{{range .IPAM.Config}}{{println .Gateway}}{{end}}"],
    "resolving the kind Docker network gateway",
    { timeoutMs: 30_000 },
  );
  const gatewayIp = parseIpv4(gateway.stdout);
  if (!gatewayIp) throw new Error(`Could not resolve an IPv4 host gateway for kind. docker network inspect returned: ${gateway.stdout.trim() || "(empty)"}`);
  return gatewayIp;
}

function mockPort(envName: string, defaultPort: number): number {
  const raw = process.env[envName]?.trim();
  if (!raw) return defaultPort;
  if (!/^\d+$/.test(raw)) throw new Error(`${envName} must be an integer port, got ${raw}.`);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${envName} must be between 1 and 65535, got ${raw}.`);
  return port;
}

async function ensureHostMockMasquerade(runtime: KubeRuntime, hostIp: string, port: number): Promise<void> {
  const rule = [
    "-t", "nat",
    "-C", "POSTROUTING",
    "-s", "192.168.0.0/16",
    "-d", `${hostIp}/32`,
    "-p", "tcp",
    "--dport", String(port),
    "-j", "MASQUERADE",
  ];
  const check = await runtime.run(
    "docker",
    ["exec", `${KUBE_CLUSTER_NAME}-control-plane`, "iptables", ...rule],
    { timeoutMs: 30_000 },
  );
  if (check.code === 0) return;
  rule[2] = "-I";
  rule.splice(4, 0, "1");
  await checkedExec(
    runtime,
    "docker",
    ["exec", `${KUBE_CLUSTER_NAME}-control-plane`, "iptables", ...rule],
    "installing kind host-mock masquerade rule",
    { timeoutMs: 30_000 },
  );
}

export async function ensureEgressAllowlist(options: KubeLayerOptions = {}): Promise<void> {
  const runtime = createRuntime(options);
  const allowedHostIp = await resolveAllowedHostIp(runtime);
  const allowedMockPort = mockPort("OPENWORK_EVAL_KUBE_ALLOWED_MOCK_PORT", 4791);
  const deniedMockPort = mockPort("OPENWORK_EVAL_KUBE_DENIED_MOCK_PORT", 4792);
  const template = await readFile(resolve(REPO_ROOT, KUBE_ALLOW_EXTERNAL_EGRESS_TEMPLATE), "utf8");
  const externalManifest = template
    .replaceAll("${OPENWORK_EVAL_KUBE_ALLOWED_HOST_IP}", allowedHostIp)
    .replaceAll("${OPENWORK_EVAL_KUBE_ALLOWED_MOCK_PORT}", String(allowedMockPort));
  if (externalManifest.includes("${OPENWORK_EVAL_")) {
    throw new Error(`Unresolved placeholder in ${KUBE_ALLOW_EXTERNAL_EGRESS_TEMPLATE}.`);
  }
  await ensureHostMockMasquerade(runtime, allowedHostIp, allowedMockPort);

  await checkedExec(
    runtime,
    "kubectl",
    kubectlArgs(["apply", "-f", KUBE_DEFAULT_DENY_EGRESS_MANIFEST]),
    `kubectl apply -f ${KUBE_DEFAULT_DENY_EGRESS_MANIFEST}`,
    { timeoutMs: 60_000 },
  );
  await checkedExec(
    runtime,
    "kubectl",
    kubectlArgs(["apply", "-f", KUBE_ALLOW_CORE_EGRESS_MANIFEST]),
    `kubectl apply -f ${KUBE_ALLOW_CORE_EGRESS_MANIFEST}`,
    { timeoutMs: 60_000 },
  );
  await checkedExec(
    runtime,
    "kubectl",
    kubectlArgs(["apply", "-f", "-"]),
    `rendering and applying ${KUBE_ALLOW_EXTERNAL_EGRESS_TEMPLATE}`,
    { input: externalManifest, timeoutMs: 60_000 },
  );

  process.env.OPENWORK_EVAL_KUBE_EGRESS_TEST = "1";
  process.env.OPENWORK_EVAL_KUBE_ALLOWED_HOST_IP = allowedHostIp;
  process.env.OPENWORK_EVAL_KUBE_ALLOWED_MOCK_PORT = String(allowedMockPort);
  process.env.OPENWORK_EVAL_KUBE_DENIED_MOCK_PORT = String(deniedMockPort);
  runtime.log("Kube egress allowlist enforced for den-api and den-web");
  runtime.log(`export OPENWORK_EVAL_KUBE_EGRESS_TEST=1 OPENWORK_EVAL_KUBE_ALLOWED_HOST_IP=${allowedHostIp} OPENWORK_EVAL_KUBE_ALLOWED_MOCK_PORT=${allowedMockPort} OPENWORK_EVAL_KUBE_DENIED_MOCK_PORT=${deniedMockPort}`);
}

export async function kubeStackTest(options: KubeLayerOptions = {}): Promise<void> {
  const runtime = createRuntime(options);
  const args = helmTestArgs();
  const result = await runtime.run("helm", args, { timeoutMs: 6 * 60_000 });
  if (result.code !== 0) {
    const logs = await runtime.run("kubectl", kubectlArgs(["logs", `job/${KUBE_RELEASE_NAME}-env-probe`, "--all-containers", "--tail=160"]), { timeoutMs: 60_000 });
    const detail = [result.stderr.trim(), result.stdout.trim(), logs.stdout.trim(), logs.stderr.trim()].filter(Boolean).join("\n");
    throw new Error(`helm ${args.join(" ")} failed with exit ${result.code}:\n${detail}`);
  }
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  if (output) runtime.log(output);
}

async function mysqlQuery(runtime: KubeRuntime, sql: string): Promise<string> {
  const result = await checkedExec(runtime, "kubectl", kubectlArgs([
    "exec",
    `deployment/${MYSQL_DEPLOYMENT}`,
    "--",
    "mysql",
    "-uopenwork",
    "-popenwork",
    "openwork_den",
    "-N",
    "-e",
    sql,
  ]), "kubectl exec mysql query", { timeoutMs: 60_000 });
  return result.stdout.trim();
}

export async function ensureSchema(options: KubeLayerOptions = {}): Promise<void> {
  const runtime = createRuntime(options);
  const schema = await mysqlQuery(runtime, "SHOW TABLES LIKE 'organization'; SHOW TABLES LIKE 'desktop_connect_grant'; SHOW TABLES LIKE 'scim_group'; SHOW COLUMNS FROM scim_provider LIKE 'group_mapping_mode';");
  if (
    schema.includes("organization")
    && schema.includes("desktop_connect_grant")
    && schema.includes("scim_group")
    && schema.includes("group_mapping_mode")
  ) {
    runtime.log("Schema present after Helm migration job");
    return;
  }
  throw new Error(`Helm migration did not leave the expected Den schema. mysql output:\n${schema}`);
}

export async function ensureSeed(options: KubeLayerOptions = {}): Promise<void> {
  const runtime = createRuntime(options);
  const existing = await mysqlQuery(runtime, `SELECT id FROM \`user\` WHERE email='${DEMO_EMAIL.toLowerCase()}' LIMIT 1;`);
  if (existing) {
    runtime.log(`Demo org present (${DEMO_EMAIL})`);
    return;
  }
  const result = await runtime.run("kubectl", kubectlArgs([
    "exec",
    `deployment/${KUBE_RELEASE_NAME}-den-api`,
    "--",
    "sh",
    "-lc",
    "cd /app/ee/apps/den-api && OPENWORK_DEV_MODE=1 DEN_DEMO_SEED_ALLOW_NONLOCAL=1 DEN_DEMO_SEED_FETCH_GITHUB=0 node --conditions=development --import tsx scripts/seed-demo-org.ts",
  ]), { timeoutMs: 10 * 60_000 });
  if (result.code !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`Demo seed failed with exit ${result.code}:\n${detail}`);
  }
  const seeded = await mysqlQuery(runtime, `SELECT id FROM \`user\` WHERE email='${DEMO_EMAIL.toLowerCase()}' LIMIT 1;`);
  if (!seeded) throw new Error("Seed completed but the demo owner was not found in MySQL.");
  runtime.log("Demo org seeded");
}

export async function ensureKindDenReady(options: KubeLayerOptions = {}): Promise<void> {
  const runtime = createRuntime(options);
  await phase(runtime, "existing-stack", () => requireKindStack(runtime));
  await phase(runtime, "den-api-rollout", () => ensureRollout(runtime, `${KUBE_RELEASE_NAME}-den-api`, "60s"));
  await phase(runtime, "den-web-rollout", () => ensureRollout(runtime, `${KUBE_RELEASE_NAME}-den-web`, "60s"));
  await phase(runtime, "schema", () => ensureSchema(options));
  await phase(runtime, "seed", () => ensureSeed(options));
}

async function portForwardHealthy(kind: "api" | "web"): Promise<boolean> {
  return kind === "api"
    ? await httpOk(`${DEN_API_URL}/health`)
    : await httpOk(`${DEN_WEB_URL}/api/ready`);
}

async function recordedLivePid(runtime: KubeRuntime, stateName: string): Promise<number | null> {
  const rawPid = await readPidState(runtime, stateName);
  if (!rawPid) return null;
  const pid = Number(rawPid);
  return Number.isInteger(pid) && pid > 0 && processIsAlive(pid) ? pid : null;
}

async function freeLocalPort(runtime: KubeRuntime, port: number): Promise<void> {
  const result = await runtime.run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeoutMs: 10_000 });
  if (result.code !== 0) return;
  const pids = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const rawPid of pids) {
    const pid = Number(rawPid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      runtime.killProcess(pid, "SIGKILL");
      runtime.log(`Cleared stale process ${pid} holding :${port}`);
    } catch {
      // Already gone.
    }
  }
}

async function ensurePortForward(runtime: KubeRuntime, kind: "api" | "web", service: string, localPort: number, remotePort: number): Promise<number> {
  const stateName = `${kind}-port-forward.pid`;
  const recordedPid = await recordedLivePid(runtime, stateName);
  if (recordedPid !== null && await portForwardHealthy(kind)) {
    runtime.log(`${kind} port-forward already healthy on :${localPort}`);
    return recordedPid;
  }
  if (await portForwardHealthy(kind)) {
    runtime.log(`${kind} endpoint on :${localPort} is healthy but not owned by this kube stack; replacing it with a tracked port-forward.`);
  }
  await stopRecordedProcess(runtime, stateName, `${kind} port-forward`);
  await freeLocalPort(runtime, localPort);
  const pid = runtime.spawnDetached("kubectl", portForwardArgs(service, localPort, remotePort), {
    stateDir: runtime.stateDir,
    logName: `${kind}-port-forward`,
  });
  await writePidState(runtime, stateName, pid);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await portForwardHealthy(kind)) {
      runtime.log(`${kind} port-forward healthy on :${localPort}`);
      return pid;
    }
    await runtime.sleep(1_000);
  }
  await stopProcess(runtime, pid, `${kind} port-forward`);
  await rm(pidStatePath(runtime, stateName), { force: true });
  throw new Error(`${kind} port-forward did not become healthy on :${localPort} within 60s.`);
}

async function stopEndpointForward(runtime: KubeRuntime, kind: "api" | "web", pid: number): Promise<void> {
  await stopProcess(runtime, pid, `${kind} port-forward`);
  await rm(pidStatePath(runtime, `${kind}-port-forward.pid`), { force: true });
}

export async function exposeEndpointHandles(profile: KubeProfileConfig, options: KubeLayerOptions = {}): Promise<KindEndpoints> {
  const runtime = createRuntime(options);
  await mkdir(runtime.stateDir, { recursive: true });
  let apiPid: number | undefined;
  let webPid: number | undefined;
  let owner: { token: string; email: string };
  try {
    apiPid = await ensurePortForward(runtime, "api", DEN_API_SERVICE, DEN_API_PORT, 8788);
    webPid = await ensurePortForward(runtime, "web", DEN_WEB_SERVICE, DEN_WEB_PORT, 3005);
    owner = await signInDemoOwner(runtime);
  } catch (error) {
    if (webPid !== undefined) await stopEndpointForward(runtime, "web", webPid);
    if (apiPid !== undefined) await stopEndpointForward(runtime, "api", apiPid);
    throw error;
  }
  let stopped = false;
  return {
    apiUrl: DEN_API_URL,
    webUrl: DEN_WEB_URL,
    token: owner.token,
    adminEmail: owner.email,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      await stopEndpointForward(runtime, "api", apiPid);
      await stopEndpointForward(runtime, "web", webPid);
    },
  };
}

export async function exposeEndpoints(profile: KubeProfileConfig, options: KubeLayerOptions = {}): Promise<void> {
  const runtime = createRuntime(options);
  const endpoints = await exposeEndpointHandles(profile, options);
  process.env.OPENWORK_EVAL_DEN_API_URL = DEN_API_URL;
  process.env.OPENWORK_EVAL_DEN_WEB_URL = DEN_WEB_URL;
  if (profile.orgMode === "multi_org") {
    process.env.OPENWORK_EVAL_DEN_MULTI_ORG = "1";
  } else {
    delete process.env.OPENWORK_EVAL_DEN_MULTI_ORG;
  }
  process.env.OPENWORK_EVAL_DEN_TOKEN = endpoints.token;
  runtime.log(`Kube Den endpoints exported: OPENWORK_EVAL_DEN_API_URL=${DEN_API_URL}, OPENWORK_EVAL_DEN_WEB_URL=${DEN_WEB_URL}${profile.orgMode === "multi_org" ? ", OPENWORK_EVAL_DEN_MULTI_ORG=1" : ""}`);
}

function appUserDataHome(): string {
  return DEFAULT_ELECTRON_USERDATA;
}

function appBootstrapPath(): string {
  return join(appUserDataHome(), "openwork-dev-data", "home", ".config", "openwork", "desktop-bootstrap.json");
}

async function hasCdpPageTarget(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/json/list`, { signal: AbortSignal.timeout(2_500) });
    if (!response.ok) return false;
    const targets: unknown = await response.json();
    return Array.isArray(targets)
      && targets.some((target) => isRecord(target) && target.type === "page" && typeof target.webSocketDebuggerUrl === "string");
  } catch {
    return false;
  }
}

async function freeStaleAppPorts(runtime: KubeRuntime): Promise<void> {
  for (const port of [9825, 9823, 5173]) {
    await freeLocalPort(runtime, port);
  }
  await runtime.sleep(1_500);
}

function chromeCdpPort(cdpCandidates: string[]): number {
  for (const candidate of cdpCandidates) {
    try {
      const url = new URL(candidate);
      if ((url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port) {
        const port = Number(url.port);
        if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return 9825;
}

async function ensureChromeApp(cdpCandidates: string[], options: KubeLayerOptions = {}): Promise<void> {
  const runtime = createRuntime(options);
  const cdpPort = chromeCdpPort(cdpCandidates);
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  if (await hasCdpPageTarget(cdpUrl)) {
    runtime.log(`Chrome CDP already reachable at ${cdpUrl}`);
    return;
  }
  await freeStaleAppPorts(runtime);
  await stopRecordedProcess(runtime, "chrome.pid", "Chrome CDP surface");
  const profileDir = join(runtime.stateDir, "chrome-user-data");
  await mkdir(profileDir, { recursive: true });
  const binary = resolveChromeBinary(process.env, process.platform);
  const pid = runtime.spawnDetached(binary, [
    "--headless=new",
    "--window-size=1280,900",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    DEN_WEB_URL,
  ], {
    stateDir: runtime.stateDir,
    logName: "chrome",
  });
  await writePidState(runtime, "chrome.pid", pid);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await hasCdpPageTarget(cdpUrl)) {
      runtime.log(`Chrome CDP up at ${cdpUrl}`);
      return;
    }
    await runtime.sleep(1_000);
  }
  throw new Error(`Chrome CDP page target did not come up at ${cdpUrl} within 60s.`);
}

async function ensureApp(cdpCandidates: string[], options: KubeLayerOptions = {}): Promise<void> {
  const runtime = createRuntime(options);
  for (const candidate of cdpCandidates) {
    if (await hasCdpPageTarget(candidate)) {
      runtime.log(`App CDP already reachable at ${candidate} — make sure it targets the kube Den endpoints if needed.`);
      return;
    }
  }

  if (process.env.OPENWORK_EVAL_KUBE_SURFACE?.trim() !== "electron") {
    runtime.log("Starting Chrome CDP surface for kube Den web evals (set OPENWORK_EVAL_KUBE_SURFACE=electron to force dev Electron).");
    await ensureChromeApp(cdpCandidates, options);
    return;
  }

  await freeStaleAppPorts(runtime);
  const bootstrapPath = appBootstrapPath();
  await mkdir(dirname(bootstrapPath), { recursive: true });
  await writeFile(
    bootstrapPath,
    `${JSON.stringify({ baseUrl: DEN_BASE_URL, requireSignin: false }, null, 2)}\n`,
  );
  await writePidState(runtime, "bootstrap.path", bootstrapPath);
  runtime.log(`Wrote desktop bootstrap -> ${DEN_BASE_URL}`);

  const pid = runtime.spawnDetached("pnpm", ["dev"], {
    stateDir: runtime.stateDir,
    logName: "app",
    env: { OPENWORK_ELECTRON_USERDATA: appUserDataHome() },
  });
  await writePidState(runtime, "app.pid", pid);
  for (let attempt = 0; attempt < 45; attempt += 1) {
    for (const candidate of cdpCandidates) {
      if (await hasCdpPageTarget(candidate)) {
        runtime.log(`App CDP up at ${candidate}`);
        await runtime.sleep(8_000);
        return;
      }
    }
    await runtime.sleep(4_000);
  }
  throw new Error("Dev Electron CDP page target did not come up within 3 minutes.");
}

export async function ensureKubeStack(options: EnsureKubeStackOptions): Promise<void> {
  const runtime = createRuntime(options);
  await mkdir(runtime.stateDir, { recursive: true });
  const profile = kubeProfileConfig(options.profile ?? "single-org");
  await writePidState(runtime, "profile", profile.profile);

  await phase(runtime, "cluster", () => ensureCluster(options));
  const imagePlan = await phase(runtime, "images", async () => {
    const plan = await resolveKubeImagePlan({ exec: options.exec, images: options.images, log: runtime.log });
    await ensureImages(plan, options);
    await writePidState(runtime, "images", plan.mode);
    return plan;
  });
  await phase(runtime, "database", () => ensureDatabase(options));
  await phase(runtime, "release", () => ensureRelease(profile, imagePlan, options));
  if (options.egress === "allowlist") {
    await phase(runtime, "egress-allowlist", () => ensureEgressAllowlist(options));
  }
  await phase(runtime, "schema", () => ensureSchema(options));
  await phase(runtime, "helm-test", () => kubeStackTest(options));
  await phase(runtime, "seed", () => ensureSeed(options));
  await phase(runtime, "port-forward", () => exposeEndpoints(profile, options));
  if (options.skipApp) {
    runtime.log("Skipping dev Electron startup — selected eval flow is app-less");
  } else {
    await phase(runtime, "app", () => ensureApp(options.cdpCandidates, options));
  }
}

export async function kubeStackDown(options: KubeStackDownOptions = {}): Promise<void> {
  const runtime = createRuntime(options);
  try {
    await access(runtime.stateDir);
  } catch {
    if (options.deleteCluster) {
      await checkedExec(runtime, "kind", ["delete", "cluster", "--name", KUBE_CLUSTER_NAME], `kind delete cluster --name ${KUBE_CLUSTER_NAME}`, { timeoutMs: 180_000 });
    }
    return;
  }
  await stopRecordedProcess(runtime, "api-port-forward.pid", "api port-forward");
  await stopRecordedProcess(runtime, "web-port-forward.pid", "web port-forward");
  await stopRecordedProcess(runtime, "chrome.pid", "Chrome CDP surface");
  await stopRecordedProcess(runtime, "app.pid", "dev app");
  const bootstrapPath = await readPidState(runtime, "bootstrap.path");
  if (bootstrapPath) {
    await rm(bootstrapPath, { force: true });
    runtime.log("Removed kube desktop bootstrap override");
  }
  const uninstall = await runtime.run("helm", ["uninstall", KUBE_RELEASE_NAME, "--namespace", KUBE_NAMESPACE, "--kube-context", KUBE_CONTEXT], { timeoutMs: 180_000 });
  if (uninstall.code === 0) {
    runtime.log(`Helm release ${KUBE_RELEASE_NAME} uninstalled (kind cluster and MySQL kept)`);
  } else {
    runtime.log(`Helm uninstall skipped or failed: ${(uninstall.stderr || uninstall.stdout).trim()}`);
  }
  const hookCleanup = await runtime.run("kubectl", kubectlArgs(["delete", "job", `${KUBE_RELEASE_NAME}-env-probe`, `${KUBE_RELEASE_NAME}-migrate`, "--ignore-not-found"]), { timeoutMs: 60_000 });
  if (hookCleanup.code === 0) runtime.log("Removed Helm hook jobs");
  if (options.deleteCluster) {
    await checkedExec(runtime, "kind", ["delete", "cluster", "--name", KUBE_CLUSTER_NAME], `kind delete cluster --name ${KUBE_CLUSTER_NAME}`, { timeoutMs: 180_000 });
    runtime.log(`Deleted kind cluster ${KUBE_CLUSTER_NAME}`);
  }
  await rm(runtime.stateDir, { recursive: true, force: true });
}
