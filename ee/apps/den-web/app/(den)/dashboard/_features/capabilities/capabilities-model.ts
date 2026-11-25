import { CUSTOMER_CAPABILITY_IDS, capability, type CustomerCapabilityId } from "@openwork/managed-deployments/capabilities";
import { CAPABILITY_STATE_REASON_LABELS, type CapabilityState, type DeploymentCapabilityStatus } from "@openwork/managed-deployments/capability-state";


export const INFRASTRUCTURE_LABELS: Record<CapabilityState, string> = {
  on: "Installed",
  off: "Off",
  needs_infrastructure: "Needs installation",
  unsupported: "Not available",
};

export type MemberAccess =
  | { kind: "everyone"; detail?: string }
  | { kind: "selected"; of: "team" | "member"; count: number }
  | { kind: "off"; detail?: string }
  | { kind: "not_applicable" }
  | { kind: "loading" }
  | { kind: "locked"; reason: string }
  | { kind: "unknown"; reason: string };

export function memberAccessLabel(access: MemberAccess): string {
  switch (access.kind) {
    case "everyone": return "Everyone";
    case "selected": return access.of === "team" ? "Selected teams" : "Selected members";
    case "off": return "Off";
    case "not_applicable": return "Not applicable";
    case "loading": return "Checking";
    case "locked": return "Locked";
    case "unknown": return "Couldn't check";
  }
}

export function memberAccessDetail(access: MemberAccess): string | null {
  switch (access.kind) {
    case "everyone":
    case "off": return access.detail ?? null;
    case "selected": return count(access.count, access.of);
    case "locked":
    case "unknown": return access.reason;
    case "not_applicable":
    case "loading": return null;
  }
}

export type Loaded<T> =
  | { state: "loading" }
  | { state: "locked"; reason: string }
  | { state: "error"; reason: string }
  | { state: "ready"; data: T };

function pending<T>(source: Loaded<T>): MemberAccess | null {
  if (source.state === "loading") return { kind: "loading" };
  if (source.state === "locked") return { kind: "locked", reason: source.reason };
  if (source.state === "error") return { kind: "unknown", reason: source.reason };
  return null;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export type WorkbotAccessFacts = {
  organizationEnabled: boolean;
  teams: ReadonlyArray<{ enabled: { inherit: true } | { inherit: false; value: boolean } }>;
};

export function workbotMemberAccess(source: Loaded<WorkbotAccessFacts>): MemberAccess {
  const waiting = pending(source);
  if (waiting) return waiting;
  if (source.state !== "ready") return { kind: "loading" };
  const explicit = source.data.teams.flatMap((team) => team.enabled.inherit ? [] : [team.enabled.value]);
  const on = explicit.filter((value) => value).length;
  const off = explicit.length - on;
  if (source.data.organizationEnabled) return off > 0 ? { kind: "everyone", detail: `except ${count(off, "team")}` } : { kind: "everyone" };
  return on > 0 ? { kind: "selected", of: "team", count: on } : { kind: "off" };
}

export type SlackAccessFacts = {
  connector: { orgWide: boolean; teamCount: number; memberCount: number } | null;
  assistant: { installed: boolean; enabled: boolean } | null;
};

export function slackMemberAccess(source: Loaded<SlackAccessFacts>): MemberAccess {
  const waiting = pending(source);
  if (waiting) return waiting;
  if (source.state !== "ready") return { kind: "loading" };
  const { connector, assistant } = source.data;
  if (!connector) return { kind: "off", detail: "Slack is not connected" };
  if (!assistant?.installed) return { kind: "off", detail: "not installed in Slack" };
  if (!assistant.enabled) return { kind: "off", detail: "turned off" };
  if (connector.orgWide) return { kind: "everyone" };
  if (connector.teamCount > 0) return { kind: "selected", of: "team", count: connector.teamCount };
  if (connector.memberCount > 0) return { kind: "selected", of: "member", count: connector.memberCount };
  return { kind: "off", detail: "shared with nobody" };
}

export type AutomationAccessFacts = { desktop: boolean; cloud: boolean };

export function automationsMemberAccess(source: Loaded<AutomationAccessFacts>): MemberAccess {
  const waiting = pending(source);
  if (waiting) return waiting;
  if (source.state !== "ready") return { kind: "loading" };
  const { desktop, cloud } = source.data;
  if (desktop && cloud) return { kind: "everyone" };
  if (desktop) return { kind: "everyone", detail: "on desktop only" };
  if (cloud) return { kind: "everyone", detail: "in the cloud only" };
  return { kind: "off" };
}

export type GatewayAccessFacts = {
  grants: ReadonlyArray<{ audience: "organization" | "team" | "member"; subjectId: string | null }>;
};

export function gatewayMemberAccess(source: Loaded<GatewayAccessFacts>): MemberAccess {
  const waiting = pending(source);
  if (waiting) return waiting;
  if (source.state !== "ready") return { kind: "loading" };
  const { grants } = source.data;
  if (grants.some((grant) => grant.audience === "organization")) return { kind: "everyone" };
  const distinct = (audience: "team" | "member") => new Set(grants.flatMap((grant) => grant.audience === audience && grant.subjectId ? [grant.subjectId] : [])).size;
  const teams = distinct("team");
  if (teams > 0) return { kind: "selected", of: "team", count: teams };
  const members = distinct("member");
  if (members > 0) return { kind: "selected", of: "member", count: members };
  return { kind: "off", detail: "no models shared" };
}

export function cloudComputersMemberAccess(workbot: MemberAccess): MemberAccess {
  return workbot;
}

export type CapabilityRow = {
  id: CustomerCapabilityId;
  label: string;
  state: CapabilityState;
  infrastructure: string;
  reason: string;
  access: MemberAccess;
  live: boolean;
  installedButOff: boolean;
};

export function capabilityRows(
  statuses: readonly DeploymentCapabilityStatus[],
  access: Record<CustomerCapabilityId, MemberAccess>,
): CapabilityRow[] {
  return CUSTOMER_CAPABILITY_IDS.flatMap((id) => {
    const status = statuses.find((entry) => entry.id === id);
    if (!status) return [];
    const installable = status.state === "on" || status.state === "off";
    const memberAccess: MemberAccess = installable ? access[id] : { kind: "not_applicable" };
    const granted = memberAccess.kind === "everyone" || memberAccess.kind === "selected";
    return [{
      id,
      label: capability(id).label,
      state: status.state,
      infrastructure: INFRASTRUCTURE_LABELS[status.state],
      reason: CAPABILITY_STATE_REASON_LABELS[status.reason],
      access: memberAccess,
      live: status.state === "on" && granted,
      installedButOff: status.state === "on" && memberAccess.kind === "off",
    }];
  });
}
