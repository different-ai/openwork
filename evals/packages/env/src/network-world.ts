const PLACEMENT_ID = /^[a-z][a-z0-9-]{0,62}$/;
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,62}$/;

export type PlacementProvider =
  | "local"
  | "daytona-linux"
  | "daytona-k3s"
  | "daytona-windows"
  | "macos-runner";

export type PlacementOs = "linux" | "macos" | "windows";

export type PlacementCapability =
  | "command:bash"
  | "command:powershell"
  | "command:zsh"
  | "surface:chrome"
  | "surface:electron"
  | "kubernetes:k3s"
  | "port:localhost"
  | "port:daytona-preview"
  | "network:dns"
  | "network:firewall"
  | "network:mtu"
  | "network:routes"
  | "network:tls-intercept"
  | "trust:linux-ca"
  | "trust:macos-keychain"
  | "trust:windows-machine-ca";

export interface PlacementResources {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
}

export interface PlacementInput {
  id: string;
  provider: PlacementProvider;
  os?: PlacementOs;
  privileged?: boolean;
  resources?: PlacementResources;
}

export interface Placement {
  id: string;
  provider: PlacementProvider;
  os: PlacementOs;
  privileged: boolean;
  resources: PlacementResources;
  capabilities: readonly PlacementCapability[];
}

export interface PlacementCommandPlan {
  placementId: string;
  shell: "bash" | "powershell" | "zsh";
  command: string;
  argv: readonly string[];
}

export type PortExposureMode = "localhost" | "daytona-preview";

export interface PortExposurePlan {
  placementId: string;
  port: number;
  mode: PortExposureMode;
  url?: string;
  requiresRuntimeResolution: boolean;
}

export type NetworkEdgeKind =
  | "http-fault-proxy"
  | "dns-zone"
  | "tls-intercept-proxy"
  | "route-gateway";

export interface NetworkEdgeInput {
  id: string;
  placement: Placement;
  kind: NetworkEdgeKind;
  upstreamResourceId?: string;
}

export interface NetworkEdgeResource {
  id: string;
  placementId: string;
  kind: NetworkEdgeKind;
  upstreamResourceId?: string;
  requiredCapabilities: readonly PlacementCapability[];
}

export type FaultAction =
  | { kind: "latency"; target: string; milliseconds: number }
  | { kind: "drop"; target: string; every: number }
  | { kind: "dns-response"; target: string; response: "nxdomain" | "servfail" | "timeout" }
  | { kind: "tls-untrusted"; target: string }
  | { kind: "recover"; target: string };

export interface FaultPhase {
  id: string;
  actions: readonly FaultAction[];
}

export interface AppliedFaultPhase {
  id: string;
  actions: readonly FaultAction[];
  actionCount: number;
}

export interface CleanupStep {
  resourceId: string;
  action: string;
  command: PlacementCommandPlan;
}

export interface CleanupReceipt {
  worldId: string;
  steps: readonly CleanupStep[];
}

function requireIdentifier(kind: string, id: string, pattern: RegExp): string {
  const normalized = id.trim();
  if (!pattern.test(normalized)) {
    throw new Error(`${kind} id ${JSON.stringify(id)} must match ${pattern.source}.`);
  }
  return normalized;
}

function requirePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function inferredOs(provider: PlacementProvider): PlacementOs {
  if (provider === "daytona-windows") return "windows";
  if (provider === "macos-runner") return "macos";
  return "linux";
}

function normalizeResources(resources: PlacementResources): PlacementResources {
  return {
    ...(resources.cpu === undefined ? {} : { cpu: requirePositiveInteger("placement resources cpu", resources.cpu) }),
    ...(resources.memoryGb === undefined ? {} : { memoryGb: requirePositiveInteger("placement resources memoryGb", resources.memoryGb) }),
    ...(resources.diskGb === undefined ? {} : { diskGb: requirePositiveInteger("placement resources diskGb", resources.diskGb) }),
  };
}

function uniqueCapabilities(capabilities: readonly PlacementCapability[]): readonly PlacementCapability[] {
  return [...new Set(capabilities)].sort();
}

function placementCapabilities(provider: PlacementProvider, os: PlacementOs, privileged: boolean): readonly PlacementCapability[] {
  const shell: PlacementCapability = os === "windows"
    ? "command:powershell"
    : os === "macos"
      ? "command:zsh"
      : "command:bash";
  const port: PlacementCapability = provider.startsWith("daytona") ? "port:daytona-preview" : "port:localhost";
  const capabilities: PlacementCapability[] = [
    shell,
    port,
  ];
  if (provider !== "daytona-k3s") {
    capabilities.push("surface:chrome", "surface:electron");
  }
  if (provider === "daytona-k3s") {
    capabilities.push("kubernetes:k3s", "network:dns", "network:firewall");
  }
  if (privileged) {
    capabilities.push("network:mtu", "network:routes", "network:tls-intercept");
    if (os === "windows") {
      capabilities.push("trust:windows-machine-ca");
    } else if (os === "macos") {
      capabilities.push("trust:macos-keychain");
    } else {
      capabilities.push("trust:linux-ca");
    }
  }
  return uniqueCapabilities(capabilities);
}

function requireCompatibleOs(provider: PlacementProvider, os: PlacementOs): void {
  if (provider === "daytona-windows" && os !== "windows") {
    throw new Error('Placement provider "daytona-windows" requires os "windows".');
  }
  if (provider === "macos-runner" && os !== "macos") {
    throw new Error('Placement provider "macos-runner" requires os "macos".');
  }
  if ((provider === "daytona-linux" || provider === "daytona-k3s") && os !== "linux") {
    throw new Error(`Placement provider ${JSON.stringify(provider)} requires os "linux".`);
  }
}

export function createPlacement(input: PlacementInput): Placement {
  const os = input.os ?? inferredOs(input.provider);
  requireCompatibleOs(input.provider, os);
  const privileged = input.privileged === true;
  return {
    id: requireIdentifier("placement", input.id, PLACEMENT_ID),
    provider: input.provider,
    os,
    privileged,
    resources: normalizeResources(input.resources ?? {}),
    capabilities: placementCapabilities(input.provider, os, privileged),
  };
}

export function placementHasCapability(placement: Placement, capability: PlacementCapability): boolean {
  return placement.capabilities.includes(capability);
}

export function requirePlacementCapabilities(placement: Placement, capabilities: readonly PlacementCapability[]): void {
  const missing = capabilities.filter((capability) => !placementHasCapability(placement, capability));
  if (missing.length > 0) {
    throw new Error(`Placement ${JSON.stringify(placement.id)} is missing capabilities: ${missing.join(", ")}.`);
  }
}

export function runOnPlacement(placement: Placement, command: string): PlacementCommandPlan {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("runOnPlacement command must not be empty.");
  if (placement.os === "windows") {
    requirePlacementCapabilities(placement, ["command:powershell"]);
    return {
      placementId: placement.id,
      shell: "powershell",
      command: trimmed,
      argv: ["powershell", "-NoProfile", "-NonInteractive", "-Command", trimmed],
    };
  }
  if (placement.os === "macos") {
    requirePlacementCapabilities(placement, ["command:zsh"]);
    return {
      placementId: placement.id,
      shell: "zsh",
      command: trimmed,
      argv: ["zsh", "-lc", trimmed],
    };
  }
  requirePlacementCapabilities(placement, ["command:bash"]);
  return {
    placementId: placement.id,
    shell: "bash",
    command: trimmed,
    argv: ["bash", "-lc", trimmed],
  };
}

export function exposePort(placement: Placement, port: number): PortExposurePlan {
  const validPort = requirePositiveInteger("port", port);
  if (validPort > 65_535) throw new Error("port must be between 1 and 65535.");
  if (placementHasCapability(placement, "port:daytona-preview")) {
    return {
      placementId: placement.id,
      port: validPort,
      mode: "daytona-preview",
      requiresRuntimeResolution: true,
    };
  }
  requirePlacementCapabilities(placement, ["port:localhost"]);
  return {
    placementId: placement.id,
    port: validPort,
    mode: "localhost",
    url: `http://127.0.0.1:${validPort}`,
    requiresRuntimeResolution: false,
  };
}

function requiredCapabilitiesForEdge(kind: NetworkEdgeKind): readonly PlacementCapability[] {
  if (kind === "dns-zone") return ["network:dns"];
  if (kind === "tls-intercept-proxy") return ["network:tls-intercept"];
  if (kind === "route-gateway") return ["network:routes"];
  return [];
}

export function createNetworkEdge(input: NetworkEdgeInput): NetworkEdgeResource {
  const requiredCapabilities = requiredCapabilitiesForEdge(input.kind);
  requirePlacementCapabilities(input.placement, requiredCapabilities);
  return {
    id: requireIdentifier("network resource", input.id, RESOURCE_ID),
    placementId: input.placement.id,
    kind: input.kind,
    ...(input.upstreamResourceId === undefined ? {} : {
      upstreamResourceId: requireIdentifier("upstream resource", input.upstreamResourceId, RESOURCE_ID),
    }),
    requiredCapabilities,
  };
}

function normalizeFaultAction(action: FaultAction): FaultAction {
  const target = requireIdentifier("fault action target", action.target, RESOURCE_ID);
  if (action.kind === "latency") {
    return { kind: action.kind, target, milliseconds: requirePositiveInteger("latency milliseconds", action.milliseconds) };
  }
  if (action.kind === "drop") {
    return { kind: action.kind, target, every: requirePositiveInteger("drop every", action.every) };
  }
  if (action.kind === "dns-response") {
    return { kind: action.kind, target, response: action.response };
  }
  if (action.kind === "tls-untrusted") {
    return { kind: action.kind, target };
  }
  return { kind: action.kind, target };
}

export function selectFaultPhase(phases: readonly FaultPhase[], phaseId: string): AppliedFaultPhase {
  const id = requireIdentifier("fault phase", phaseId, RESOURCE_ID);
  const matches = phases.filter((phase) => phase.id === id);
  if (matches.length > 1) {
    throw new Error(`Fault phase ${JSON.stringify(id)} is ambiguous: duplicate ids are not allowed.`);
  }
  const found = matches[0];
  if (!found) {
    throw new Error(`Fault phase ${JSON.stringify(id)} does not exist.`);
  }
  const actions = found.actions.map(normalizeFaultAction);
  return { id, actions, actionCount: actions.length };
}

export function createCleanupPlan(worldId: string, steps: readonly CleanupStep[]): CleanupReceipt {
  const normalizedWorldId = requireIdentifier("world", worldId, RESOURCE_ID);
  const normalizedSteps: CleanupStep[] = [];
  for (const step of steps) {
    const resourceId = requireIdentifier("cleanup resource", step.resourceId, RESOURCE_ID);
    const action = step.action.trim();
    if (!action) throw new Error("cleanup action must not be empty.");
    if (!step.command.command.trim()) throw new Error("cleanup command must not be empty.");
    normalizedSteps.push({ resourceId, action, command: step.command });
  }
  return { worldId: normalizedWorldId, steps: normalizedSteps };
}
