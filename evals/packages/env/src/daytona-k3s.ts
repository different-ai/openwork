import { checkedExec, defaultDaytonaExec, deleteSandboxes } from "@openwork/hosts";
import type { DaytonaExec, DaytonaExecResult } from "@openwork/hosts";
import { placementHasCapability } from "./network-world.ts";
import type { Placement } from "./network-world.ts";

const PLACEMENT_ID = /^[a-z][a-z0-9-]{0,62}$/;
const SANDBOX_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const KUBERNETES_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HELM_RELEASE = /^[a-z0-9](?:[a-z0-9-]{0,51}[a-z0-9])?$/;
const RUNTIME_BASE = "/tmp/openwork-world-k3s";
const MAX_PREVIEW_EXPIRY_SECONDS = 86_400;
const TOOL_TIMEOUT_MS = 120_000;
const DEFAULT_DAYTONA_K3S_SNAPSHOT: DaytonaK3sSnapshot = "daytona-large";
const DEFAULT_DAYTONA_K3S_VERSION: SupportedDaytonaK3sVersion = "v1.31.6+k3s1";
const ownershipBrand = Symbol("DaytonaK3sSandboxOwnership");

export type DaytonaK3sSnapshot = "daytona-large";
export type SupportedDaytonaK3sVersion = "v1.31.6+k3s1";

interface K3sBinaryDescriptor {
  readonly version: SupportedDaytonaK3sVersion;
  readonly url: "https://github.com/k3s-io/k3s/releases/download/v1.31.6%2Bk3s1/k3s";
  readonly sha256: "9f82f06b4cf318fcf4eeda3f4fedaa10c0cebc418b1a047e72b104f5ea7874c5";
}

const K3S_BINARIES: Readonly<Record<SupportedDaytonaK3sVersion, K3sBinaryDescriptor>> = {
  "v1.31.6+k3s1": {
    version: "v1.31.6+k3s1",
    url: "https://github.com/k3s-io/k3s/releases/download/v1.31.6%2Bk3s1/k3s",
    sha256: "9f82f06b4cf318fcf4eeda3f4fedaa10c0cebc418b1a047e72b104f5ea7874c5",
  },
};

/** Opaque proof that this module provisioned and exclusively owns a sandbox. */
export interface DaytonaK3sSandboxOwnership {
  readonly [ownershipBrand]: true;
}

export interface ProvisionDaytonaK3sSandboxInput {
  name: string;
  snapshot?: DaytonaK3sSnapshot;
  exec?: DaytonaExec;
  log?: (message: string) => void;
}

export interface CreateDaytonaK3sClusterInput {
  placement: Placement;
  ownership: DaytonaK3sSandboxOwnership;
  version?: SupportedDaytonaK3sVersion;
}

export interface DaytonaK3sRuntimePaths {
  readonly root: string;
  readonly binary: string;
  readonly download: string;
  readonly dataDir: string;
  readonly kubeconfig: string;
  readonly serverLog: string;
}

/** Owns a dedicated sandbox that stop or AsyncDispose WILL DELETE in full. */
export interface DaytonaK3sClusterHandle extends AsyncDisposable {
  readonly placement: Placement;
  readonly ownedSandboxId: string;
  readonly version: SupportedDaytonaK3sVersion;
  readonly paths: DaytonaK3sRuntimePaths;
  /** Deletes the entire dedicated sandbox, including every listener and preview. */
  stop(): Promise<void>;
  kubectl(args: readonly string[]): Promise<DaytonaExecResult>;
  helm(args: readonly string[]): Promise<DaytonaExecResult>;
}

export interface InstallK3sHelmReleaseInput {
  release: string;
  namespace: string;
  chart: string;
}

export interface ExposeK3sServiceInput {
  namespace: string;
  service: string;
  localPort: number;
  servicePort: number;
  expiresInSeconds: number;
}

/** A signed URL valid only until its expiry or deletion of the owning cluster. */
export interface DaytonaK3sServiceExposure {
  readonly placementId: string;
  readonly ownedSandboxId: string;
  readonly namespace: string;
  readonly service: string;
  readonly localPort: number;
  readonly servicePort: number;
  readonly url: string;
  readonly expiresAt: string;
  readonly expiresInSeconds: number;
  readonly ephemeral: true;
  readonly persistableInDesktopConfig: false;
  readonly validUntil: "cluster-disposal-or-expiry";
}

type PrivilegeMode = "root" | "sudo";

interface ClusterRuntime {
  exec: DaytonaExec;
  ownedSandboxId: string;
  paths: DaytonaK3sRuntimePaths;
  privilege: PrivilegeMode;
  reservedPorts: Set<number>;
  assertActive(): void;
  dispose(): Promise<void>;
}

const clusterRuntimes = new WeakMap<DaytonaK3sClusterHandle, ClusterRuntime>();
const sandboxOwnership = new WeakMap<DaytonaK3sSandboxOwnership, {
  ownedSandboxId: string;
  exec: DaytonaExec;
  log: (message: string) => void;
}>();

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function privilegedCommand(mode: PrivilegeMode, command: string, args: readonly string[]): string {
  return mode === "root"
    ? shellCommand(command, args)
    : shellCommand("sudo", ["-n", command, ...args]);
}

function requirePlacement(placement: Placement): void {
  if (!PLACEMENT_ID.test(placement.id)) {
    throw new Error(`Daytona k3s placement id ${JSON.stringify(placement.id)} must match ${PLACEMENT_ID.source}.`);
  }
  if (placement.provider !== "daytona-k3s") {
    throw new Error(`Daytona k3s requires placement provider "daytona-k3s"; received ${JSON.stringify(placement.provider)}.`);
  }
  if (!placementHasCapability(placement, "kubernetes:k3s")) {
    throw new Error(`Daytona k3s placement ${JSON.stringify(placement.id)} is missing capability kubernetes:k3s.`);
  }
}

function requireSandboxName(value: string): string {
  if (!SANDBOX_NAME.test(value)) {
    throw new Error(`Daytona k3s sandbox name ${JSON.stringify(value)} must match ${SANDBOX_NAME.source}.`);
  }
  return value;
}

function requireSnapshot(value: DaytonaK3sSnapshot | undefined): DaytonaK3sSnapshot {
  const snapshot = value ?? DEFAULT_DAYTONA_K3S_SNAPSHOT;
  if (snapshot !== "daytona-large") {
    throw new Error(`Daytona k3s snapshot ${JSON.stringify(snapshot)} is not allowlisted.`);
  }
  return snapshot;
}

function requireBinary(version: SupportedDaytonaK3sVersion | undefined): K3sBinaryDescriptor {
  const selected = version ?? DEFAULT_DAYTONA_K3S_VERSION;
  if (selected !== "v1.31.6+k3s1") {
    throw new Error(`Daytona k3s version ${JSON.stringify(selected)} is not supported.`);
  }
  return K3S_BINARIES[selected];
}

function requireKubernetesName(kind: string, value: string): string {
  if (!KUBERNETES_NAME.test(value)) throw new Error(`${kind} ${JSON.stringify(value)} must be a Kubernetes DNS label.`);
  return value;
}

function requireHelmRelease(value: string): string {
  if (!HELM_RELEASE.test(value)) {
    throw new Error(`Helm release ${JSON.stringify(value)} must be a lowercase DNS label of at most 53 characters.`);
  }
  return value;
}

function requireChart(value: string): string {
  if (value.length === 0 || value.length > 512 || value.trim() !== value || value.startsWith("-") || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new Error("Helm chart must be a non-empty chart reference without whitespace, control characters, or a leading dash.");
  }
  return value;
}

function requirePort(kind: string, value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${kind} must be an integer between 1 and 65535.`);
  }
  return value;
}

function requireExpiry(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PREVIEW_EXPIRY_SECONDS) {
    throw new Error(`Daytona preview expiry must be between 1 and ${MAX_PREVIEW_EXPIRY_SECONDS} seconds.`);
  }
  return value;
}

function requireToolArguments(tool: string, args: readonly string[]): string[] {
  return args.map((argument, index) => {
    if (argument.length === 0 || /[\u0000-\u001f\u007f]/.test(argument)) {
      throw new Error(`${tool} argument ${index + 1} must be non-empty and contain no control characters.`);
    }
    return argument;
  });
}

/** Daytona CLI v0.173 joins post-`--` tokens, so bash and its script are one argument. */
function daytonaK3sExecArgv(ownedSandboxId: string, script: string): string[] {
  const sandbox = requireSandboxName(ownedSandboxId);
  if (!script.trim() || /\u0000/.test(script)) throw new Error("Daytona k3s shell script must be non-empty and contain no NUL bytes.");
  return ["exec", sandbox, "--", `bash -lc ${shellQuote(script)}`];
}

function daytonaK3sPreviewArgv(ownedSandboxId: string, port: number, expiresInSeconds: number): string[] {
  return [
    "preview-url",
    requireSandboxName(ownedSandboxId),
    "-p",
    String(requirePort("Daytona preview port", port)),
    "--expires",
    String(requireExpiry(expiresInSeconds)),
  ];
}

export function parseDaytonaK3sPreviewUrl(stdout: string): string {
  for (const match of stdout.matchAll(/https:\/\/[^\s"'<>]+/g)) {
    let end = match[0].length;
    while (end > 0 && ".,;:".includes(match[0][end - 1] ?? "")) end -= 1;
    const candidate = match[0].slice(0, end);
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "https:" && parsed.hostname) return candidate;
    } catch {
      // Continue to the next explicit HTTPS token in stdout.
    }
  }
  throw new Error("Daytona preview-url stdout did not contain a valid HTTPS URL.");
}

function runtimePaths(placementId: string): DaytonaK3sRuntimePaths {
  const root = `${RUNTIME_BASE}/${placementId}`;
  return {
    root,
    binary: `${root}/bin/k3s`,
    download: `${root}/download/k3s`,
    dataDir: `${root}/data`,
    kubeconfig: `${root}/kubeconfig.yaml`,
    serverLog: `${root}/server.log`,
  };
}

async function remoteExec(
  exec: DaytonaExec,
  ownedSandboxId: string,
  script: string,
  context: string,
  timeoutMs: number,
): Promise<DaytonaExecResult> {
  return checkedExec(exec, daytonaK3sExecArgv(ownedSandboxId, script), context, { timeoutMs });
}

async function deleteProvisioningFailure(
  ownedSandboxId: string,
  exec: DaytonaExec,
  log: (message: string) => void,
  error: unknown,
): Promise<never> {
  try {
    await deleteSandboxes([ownedSandboxId], { exec, log });
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "Daytona k3s sandbox provisioning failed and its sandbox could not be deleted.");
  }
  throw error;
}

/** Creates the dedicated sandbox whose whole-sandbox deletion owns all cleanup. */
export async function provisionDaytonaK3sSandbox(
  input: ProvisionDaytonaK3sSandboxInput,
): Promise<DaytonaK3sSandboxOwnership> {
  const ownedSandboxId = requireSandboxName(input.name);
  const snapshot = requireSnapshot(input.snapshot);
  const exec = input.exec ?? defaultDaytonaExec;
  const log = input.log ?? (() => undefined);
  try {
    await checkedExec(
      exec,
      [
        "create",
        "--name", ownedSandboxId,
        "--snapshot", snapshot,
        "--auto-delete", "0",
        "--target", "us",
      ],
      `create dedicated Daytona k3s sandbox ${ownedSandboxId}`,
      { timeoutMs: 300_000 },
    );
    await remoteExec(exec, ownedSandboxId, shellCommand("true", []), `wait for Daytona k3s sandbox ${ownedSandboxId} exec readiness`, 60_000);
  } catch (error) {
    return deleteProvisioningFailure(ownedSandboxId, exec, log, error);
  }

  const ownership: DaytonaK3sSandboxOwnership = { [ownershipBrand]: true };
  sandboxOwnership.set(ownership, { ownedSandboxId, exec, log });
  log(`Daytona k3s sandbox ${ownedSandboxId} is exec-ready and exclusively owned.`);
  return ownership;
}

function claimSandboxOwnership(ownership: DaytonaK3sSandboxOwnership): {
  ownedSandboxId: string;
  exec: DaytonaExec;
  log: (message: string) => void;
} {
  const owned = sandboxOwnership.get(ownership);
  if (!owned) {
    throw new Error("createDaytonaK3sCluster requires an unused ownership receipt returned by provisionDaytonaK3sSandbox.");
  }
  sandboxOwnership.delete(ownership);
  return owned;
}

function binaryInstallScript(paths: DaytonaK3sRuntimePaths, binary: K3sBinaryDescriptor): string {
  const installedChecksum = `${binary.sha256}  ${paths.binary}`;
  const downloadChecksum = `${binary.sha256}  ${paths.download}`;
  return [
    shellCommand("set", ["-eu"]),
    shellCommand("set", ["-o", "pipefail"]),
    shellCommand("mkdir", ["-p", `${paths.root}/bin`, `${paths.root}/download`, paths.dataDir]),
    `if ${shellCommand("test", ["-x", paths.binary])} && ${shellCommand("printf", ["%s\\n", installedChecksum])} | ${shellCommand("sha256sum", ["--check", "--status", "-"])}; then ${shellCommand("exit", ["0"])}; fi`,
    shellCommand("rm", ["-f", paths.download]),
    shellCommand("curl", ["--fail", "--silent", "--show-error", "--location", binary.url, "--output", paths.download]),
    `${shellCommand("printf", ["%s\\n", downloadChecksum])} | ${shellCommand("sha256sum", ["--check", "--status", "-"])}`,
    shellCommand("chmod", ["0755", paths.download]),
    shellCommand("mv", ["-f", paths.download, paths.binary]),
  ].join("\n");
}

async function selectPrivilege(exec: DaytonaExec, ownedSandboxId: string): Promise<PrivilegeMode> {
  const result = await remoteExec(exec, ownedSandboxId, shellCommand("id", ["-u"]), "probe Daytona k3s privilege", 30_000);
  const uid = result.stdout.trim();
  if (!/^[0-9]+$/.test(uid)) throw new Error(`Daytona k3s id -u returned invalid output ${JSON.stringify(uid)}.`);
  if (uid === "0") return "root";
  await remoteExec(exec, ownedSandboxId, shellCommand("sudo", ["-n", "true"]), "probe passwordless sudo for Daytona k3s", 30_000);
  return "sudo";
}

function serverArgs(paths: DaytonaK3sRuntimePaths, placementId: string): string[] {
  return [
    "server",
    "--data-dir", paths.dataDir,
    "--write-kubeconfig", paths.kubeconfig,
    "--write-kubeconfig-mode", "0600",
    "--node-name", `openwork-${placementId}`,
    "--snapshotter", "native",
  ];
}

function startServerScript(paths: DaytonaK3sRuntimePaths, placementId: string, privilege: PrivilegeMode): string {
  const args = serverArgs(paths, placementId);
  const launch = privilege === "root"
    ? [paths.binary, ...args]
    : ["sudo", "-n", paths.binary, ...args];
  return [
    shellCommand("set", ["-eu"]),
    shellCommand("mkdir", ["-p", paths.dataDir]),
    `${shellCommand("nohup", launch)} >${shellQuote(paths.serverLog)} 2>&1 &`,
  ].join("\n");
}

function readinessScript(paths: DaytonaK3sRuntimePaths, privilege: PrivilegeMode): string {
  const kubectl = privilegedCommand(privilege, paths.binary, ["kubectl", "--kubeconfig", paths.kubeconfig, "get", "--raw=/readyz"]);
  return [
    "attempt=0",
    "while 'test' \"$attempt\" '-lt' '120'; do",
    `  if ${kubectl} >${shellQuote("/dev/null")} 2>&1; then ${shellCommand("exit", ["0"])}; fi`,
    `  ${shellCommand("sleep", ["1"])}`,
    "  attempt=$((attempt + 1))",
    "done",
    `${shellCommand("tail", ["-n", "80", paths.serverLog])} >&2`,
    shellCommand("exit", ["1"]),
  ].join("\n");
}

function createRuntime(input: {
  exec: DaytonaExec;
  ownedSandboxId: string;
  paths: DaytonaK3sRuntimePaths;
  log: (message: string) => void;
}): ClusterRuntime {
  let active = true;
  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    active = false;
    disposal ??= deleteSandboxes([input.ownedSandboxId], { exec: input.exec, log: input.log });
    return disposal;
  };
  return {
    exec: input.exec,
    ownedSandboxId: input.ownedSandboxId,
    paths: input.paths,
    privilege: "root",
    reservedPorts: new Set<number>(),
    assertActive(): void {
      if (!active) throw new Error(`Daytona k3s owned sandbox ${JSON.stringify(input.ownedSandboxId)} is disposed.`);
    },
    dispose,
  };
}

async function deleteAfterFailure(runtime: ClusterRuntime, error: unknown, message: string): Promise<never> {
  try {
    await runtime.dispose();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], `${message} and its owned sandbox could not be deleted.`);
  }
  throw error;
}

function makeClusterHandle(
  placement: Placement,
  binary: K3sBinaryDescriptor,
  runtime: ClusterRuntime,
): DaytonaK3sClusterHandle {
  const runTool = async (tool: "kubectl" | "helm", args: readonly string[]): Promise<DaytonaExecResult> => {
    runtime.assertActive();
    const normalized = requireToolArguments(tool, args);
    const command = tool === "kubectl"
      ? privilegedCommand(runtime.privilege, runtime.paths.binary, ["kubectl", "--kubeconfig", runtime.paths.kubeconfig, ...normalized])
      : privilegedCommand(runtime.privilege, "helm", ["--kubeconfig", runtime.paths.kubeconfig, ...normalized]);
    return remoteExec(runtime.exec, runtime.ownedSandboxId, command, `run ${tool} in Daytona k3s placement ${placement.id}`, TOOL_TIMEOUT_MS);
  };
  const handle: DaytonaK3sClusterHandle = {
    placement,
    ownedSandboxId: runtime.ownedSandboxId,
    version: binary.version,
    paths: runtime.paths,
    stop: runtime.dispose,
    kubectl: (args) => runTool("kubectl", args),
    helm: (args) => runTool("helm", args),
    [Symbol.asyncDispose]: runtime.dispose,
  };
  clusterRuntimes.set(handle, runtime);
  return handle;
}

/** Consumes a genuine provisioning receipt and deletes its sandbox on every cleanup path. */
export async function createDaytonaK3sCluster(input: CreateDaytonaK3sClusterInput): Promise<DaytonaK3sClusterHandle> {
  requirePlacement(input.placement);
  const binary = requireBinary(input.version);
  const { ownedSandboxId, exec, log } = claimSandboxOwnership(input.ownership);
  const paths = runtimePaths(input.placement.id);
  const runtime = createRuntime({ exec, ownedSandboxId, paths, log });
  try {
    runtime.privilege = await selectPrivilege(exec, ownedSandboxId);
    await remoteExec(exec, ownedSandboxId, binaryInstallScript(paths, binary), `install pinned k3s ${binary.version}`, 180_000);
    await remoteExec(exec, ownedSandboxId, startServerScript(paths, input.placement.id, runtime.privilege), `start Daytona k3s placement ${input.placement.id}`, 30_000);
    await remoteExec(exec, ownedSandboxId, readinessScript(paths, runtime.privilege), `wait for Daytona k3s placement ${input.placement.id}`, 135_000);
    log(`Daytona k3s placement ${input.placement.id} is ready in exclusively owned sandbox ${ownedSandboxId}.`);
    return makeClusterHandle(input.placement, binary, runtime);
  } catch (error) {
    return deleteAfterFailure(runtime, error, `Daytona k3s placement ${input.placement.id} failed to start`);
  }
}

export function installK3sHelmRelease(
  handle: DaytonaK3sClusterHandle,
  input: InstallK3sHelmReleaseInput,
): Promise<DaytonaExecResult> {
  const release = requireHelmRelease(input.release);
  const namespace = requireKubernetesName("Helm namespace", input.namespace);
  const chart = requireChart(input.chart);
  return handle.helm(["upgrade", "--install", release, chart, "--namespace", namespace, "--create-namespace"]);
}

function portForwardArgs(paths: DaytonaK3sRuntimePaths, input: {
  namespace: string;
  service: string;
  localPort: number;
  servicePort: number;
}): string[] {
  return [
    "kubectl",
    "--kubeconfig", paths.kubeconfig,
    "port-forward",
    "--namespace", input.namespace,
    "--address", "0.0.0.0",
    `service/${input.service}`,
    `${input.localPort}:${input.servicePort}`,
  ];
}

function startPortForwardScript(runtime: ClusterRuntime, args: readonly string[], logFile: string): string {
  const launch = runtime.privilege === "root"
    ? [runtime.paths.binary, ...args]
    : ["sudo", "-n", runtime.paths.binary, ...args];
  return `${shellCommand("nohup", launch)} >${shellQuote(logFile)} 2>&1 &`;
}

function waitForPortScript(logFile: string, localPort: number): string {
  const socket = `/dev/tcp/127.0.0.1/${localPort}`;
  return [
    "attempt=0",
    "while 'test' \"$attempt\" '-lt' '100'; do",
    `  if ('exec' 3<>${shellQuote(socket)}) 2>${shellQuote("/dev/null")}; then ${shellCommand("exit", ["0"])}; fi`,
    `  ${shellCommand("sleep", ["0.2"])}`,
    "  attempt=$((attempt + 1))",
    "done",
    `${shellCommand("tail", ["-n", "80", logFile])} >&2`,
    shellCommand("exit", ["1"]),
  ].join("\n");
}

export async function exposeK3sService(
  handle: DaytonaK3sClusterHandle,
  input: ExposeK3sServiceInput,
): Promise<DaytonaK3sServiceExposure> {
  const namespace = requireKubernetesName("Kubernetes namespace", input.namespace);
  const service = requireKubernetesName("Kubernetes service", input.service);
  const localPort = requirePort("K3s local port", input.localPort);
  const servicePort = requirePort("K3s service port", input.servicePort);
  const expiresInSeconds = requireExpiry(input.expiresInSeconds);
  const runtime = clusterRuntimes.get(handle);
  if (!runtime) throw new Error("exposeK3sService requires a handle returned by createDaytonaK3sCluster.");
  runtime.assertActive();
  if (runtime.reservedPorts.has(localPort)) throw new Error(`K3s local port ${localPort} is already reserved by this cluster.`);
  runtime.reservedPorts.add(localPort);

  const args = portForwardArgs(runtime.paths, { namespace, service, localPort, servicePort });
  const logFile = `${runtime.paths.root}/port-forward-${localPort}.log`;
  try {
    await remoteExec(runtime.exec, runtime.ownedSandboxId, startPortForwardScript(runtime, args, logFile), `start Daytona k3s port-forward for ${namespace}/${service}`, 30_000);
    await remoteExec(runtime.exec, runtime.ownedSandboxId, waitForPortScript(logFile, localPort), `wait for Daytona k3s port ${localPort}`, 30_000);
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1_000).toISOString();
    const preview = await checkedExec(
      runtime.exec,
      daytonaK3sPreviewArgv(runtime.ownedSandboxId, localPort, expiresInSeconds),
      `resolve Daytona k3s preview URL for ${namespace}/${service}`,
      { timeoutMs: 30_000 },
    );
    return {
      placementId: handle.placement.id,
      ownedSandboxId: runtime.ownedSandboxId,
      namespace,
      service,
      localPort,
      servicePort,
      url: parseDaytonaK3sPreviewUrl(preview.stdout),
      expiresAt,
      expiresInSeconds,
      ephemeral: true,
      persistableInDesktopConfig: false,
      validUntil: "cluster-disposal-or-expiry",
    };
  } catch (error) {
    return deleteAfterFailure(runtime, error, `Daytona k3s service ${namespace}/${service} failed to expose`);
  }
}
