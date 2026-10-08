import type { GatewayAudience } from "@openwork/types/den/gateway";
import {
  gatewayUsageTimeframes,
  gatewayWinningPolicies,
  type GatewayUsageLimitPolicy,
  type GatewayUsageTimeframe,
} from "@openwork/types/den/gateway-usage-limits";
import type { DenOrgMember, DenOrgTeam } from "../../_lib/den-org";
import type { GatewayAccessProvider } from "./gateway-subject-access-data";
import { formatLimitMoney, timeframePeriods } from "./gateway-usage-limits-data";

export type DirectorySubject =
  | { type: "organization" }
  | { type: "team"; teamId: string }
  | { type: "member"; memberId: string; teamIds: string[] };

export type DirectorySource = { kind: "organization" } | { kind: "team"; teamId: string } | { kind: "member" };

export type DirectoryAccess = { provider: GatewayAccessProvider; sources: DirectorySource[] };

export type DirectoryLimit = {
  windows: { timeframe: GatewayUsageTimeframe; costLimitMicroUsd: number; policy: GatewayUsageLimitPolicy }[];
  sources: DirectorySource[];
};

type PolicyAssignment = GatewayUsageLimitPolicy["assignments"][number];

const SOURCE_RANK: Record<DirectorySource["kind"], number> = { member: 0, team: 1, organization: 2 };

export function memberSubject(member: DenOrgMember, teams: DenOrgTeam[]): DirectorySubject {
  return { type: "member", memberId: member.id, teamIds: teams.filter((team) => team.memberIds.includes(member.id)).map((team) => team.id) };
}

function isSource(source: DirectorySource | null): source is DirectorySource {
  return source !== null;
}

function sourceKey(source: DirectorySource) {
  return source.kind === "team" ? `team:${source.teamId}` : source.kind;
}

function uniqueSources(sources: DirectorySource[]) {
  const seen = new Map<string, DirectorySource>();
  for (const source of sources) seen.set(sourceKey(source), source);
  return [...seen.values()].sort((a, b) => SOURCE_RANK[a.kind] - SOURCE_RANK[b.kind]);
}

function audienceSource(subject: DirectorySubject, audience: GatewayAudience): DirectorySource | null {
  if (audience.type === "organization") return { kind: "organization" };
  if (audience.type === "team") {
    const inTeam = subject.type === "team" ? subject.teamId === audience.teamId : subject.type === "member" && subject.teamIds.includes(audience.teamId);
    return inTeam ? { kind: "team", teamId: audience.teamId } : null;
  }
  return subject.type === "member" && subject.memberId === audience.memberId ? { kind: "member" } : null;
}

function assignmentSource(subject: DirectorySubject, assignment: PolicyAssignment): DirectorySource | null {
  if (assignment.organization) return { kind: "organization" };
  if (assignment.teamId) return audienceSource(subject, { type: "team", teamId: assignment.teamId });
  if (assignment.memberId) return audienceSource(subject, { type: "member", memberId: assignment.memberId });
  return null;
}

function usableGrant(provider: GatewayAccessProvider, grant: GatewayAccessProvider["accessGrants"][number]) {
  const group = provider.modelGroups.find((item) => item.id === grant.modelGroupId);
  const credential = provider.credentialSets.find((item) => item.id === grant.credentialSetId);
  return provider.status !== "disabled" && group?.status !== "disabled" && credential?.status !== "disabled" && Boolean(group && credential);
}

/** Providers the subject can use today, with every rule that grants each one. */
export function directoryAccess(providers: GatewayAccessProvider[], subject: DirectorySubject): DirectoryAccess[] {
  return providers.flatMap((provider) => {
    const sources = provider.accessGrants
      .filter((grant) => usableGrant(provider, grant))
      .map((grant) => audienceSource(subject, grant.audience))
      .filter(isSource);
    return sources.length ? [{ provider, sources: uniqueSources(sources) }] : [];
  });
}

/** The allowance the gateway enforces for the subject: the highest limit per timeframe across every policy that applies. */
export function directoryLimit(policies: GatewayUsageLimitPolicy[], subject: DirectorySubject): DirectoryLimit {
  const applicable = policies.filter((policy) => !policy.archivedAt && policy.assignments.some((assignment) => assignmentSource(subject, assignment)));
  const winners = gatewayWinningPolicies(applicable);
  const sources = winners.flatMap(({ policy }) => {
    const [source] = uniqueSources(policy.assignments.map((assignment) => assignmentSource(subject, assignment)).filter(isSource));
    return source ? [source] : [];
  });
  return {
    windows: winners.map(({ policy, limit }) => ({ timeframe: limit.timeframe, costLimitMicroUsd: limit.costLimitMicroUsd, policy }))
      .sort((a, b) => gatewayUsageTimeframes.indexOf(a.timeframe) - gatewayUsageTimeframes.indexOf(b.timeframe)),
    sources: uniqueSources(sources),
  };
}

export function limitSummary(limit: DirectoryLimit, each: boolean) {
  if (!limit.windows.length) return "No limit";
  const text = limit.windows.map((window) => `${formatLimitMoney(window.costLimitMicroUsd)} ${timeframePeriods[window.timeframe]}`).join(", ");
  return each ? `${text} each` : text;
}

function teamName(teams: DenOrgTeam[], teamId: string) {
  return teams.find((team) => team.id === teamId)?.name ?? "a removed team";
}

function joinNames(names: string[]) {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Where the enforced allowance comes from, in the words an admin uses. */
export function limitSourceLabel(limit: DirectoryLimit, subject: DirectorySubject, teams: DenOrgTeam[]) {
  if (!limit.windows.length) return subject.type === "organization" ? "" : "Nothing pauses their models";
  const soft = limit.windows.every((window) => !window.policy.hardLimit) ? " · warns only" : "";
  if (subject.type === "organization") return soft.slice(3);
  if (subject.type === "team" && limit.sources.every((source) => source.kind === "team")) return `Team limit${soft}`;
  if (subject.type === "member" && limit.sources.every((source) => source.kind === "member")) return `Their own limit${soft}`;
  const names = limit.sources.map((source) => source.kind === "organization" ? "Everyone" : source.kind === "team" ? teamName(teams, source.teamId) : "their own limit");
  return `From ${joinNames(names)}${soft}`;
}

/** Why a member can use a provider, e.g. "Everyone has it" or "Through Design". */
export function accessReason(sources: DirectorySource[], teams: DenOrgTeam[]) {
  return sources.map((source) => source.kind === "organization" ? "Everyone has it"
    : source.kind === "team" ? `Through ${teamName(teams, source.teamId)}`
      : "Given to them directly").join(" · ");
}

/** Who a provider is limited to, for providers the member cannot use. */
export function providerAudienceLabel(provider: GatewayAccessProvider, teams: DenOrgTeam[], members: DenOrgMember[]) {
  const names = [...new Set(provider.accessGrants.filter((grant) => usableGrant(provider, grant)).map((grant) => grant.audience.type === "team"
    ? teamName(teams, grant.audience.teamId)
    : grant.audience.type === "member"
      ? members.find((member) => grant.audience.type === "member" && member.id === grant.audience.memberId)?.user.name ?? "one person"
      : "Everyone"))];
  if (!names.length) return "Nobody has it yet";
  return names.length > 2 ? `Only ${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : `Only ${joinNames(names)}`;
}
