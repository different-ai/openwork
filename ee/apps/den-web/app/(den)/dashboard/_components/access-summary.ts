import type { DenOrgMember, DenOrgTeam } from "../../_lib/den-org";
import type { DenPlugin } from "./plugin-data";

/** Who can use a connector or plugin, as edited in the Who can use it block. */
export type AccessDraft = {
  orgWide: boolean;
  memberIds: string[];
  teamIds: string[];
};

export const EMPTY_ACCESS: AccessDraft = { orgWide: false, memberIds: [], teamIds: [] };

type Directory = {
  members: readonly Pick<DenOrgMember, "id" | "user">[];
  teams: readonly Pick<DenOrgTeam, "id" | "name" | "memberIds">[];
};

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

export function joinNames(names: readonly string[], max = 2): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length <= max) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const rest = names.length - max;
  return `${names.slice(0, max).join(", ")} and ${rest} more`;
}

/** Everyone the draft reaches besides the owner, counting each person once. */
export function accessPeopleIds(draft: AccessDraft, directory: Directory, ownerId: string | null): string[] {
  const ids = new Set<string>();
  if (draft.orgWide) {
    for (const member of directory.members) ids.add(member.id);
  } else {
    for (const id of draft.memberIds) ids.add(id);
    for (const teamId of draft.teamIds) {
      const team = directory.teams.find((entry) => entry.id === teamId);
      for (const id of team?.memberIds ?? []) ids.add(id);
    }
  }
  if (ownerId) ids.delete(ownerId);
  return [...ids];
}

export function peopleLabel(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

/** Names of the people and teams in a draft, people first, without the owner. */
export function accessNames(draft: AccessDraft, directory: Directory, ownerId: string | null): string[] {
  const people = draft.memberIds
    .filter((id) => id !== ownerId)
    .map((id) => directory.members.find((member) => member.id === id))
    .flatMap((member) => member ? [firstName(member.user.name || member.user.email)] : []);
  const teams = draft.teamIds
    .map((id) => directory.teams.find((team) => team.id === id)?.name)
    .flatMap((name) => name ? [name] : []);
  return [...people, ...teams];
}

/** The status lane text for something the viewer owns. */
export function ownedAccessStatus(draft: AccessDraft | null, directory: Directory, ownerId: string | null): string {
  if (!draft) return "Only you";
  if (draft.orgWide) return "Everyone";
  const names = accessNames(draft, directory, ownerId);
  return names.length === 0 ? "Only you" : `Shared with ${joinNames(names)}`;
}

/** Who-has-it text in Manage, where the admin is not the audience. */
export function managedAccessStatus(draft: AccessDraft | null, directory: Directory, ownerId: string | null): string {
  if (!draft) return "Only you";
  if (draft.orgWide) return "Everyone";
  const names = accessNames(draft, directory, ownerId);
  return names.length === 0 ? "Only you" : joinNames(names);
}

/** "Maya and Support will find it in My Library." */
export function shareConsequence(draft: AccessDraft, directory: Directory, ownerId: string | null): string {
  if (draft.orgWide) return "Everyone in the organization will find it in My Library.";
  const names = accessNames(draft, directory, ownerId);
  if (names.length === 0) return "Only you can use it.";
  return `${joinNames(names)} will find it in My Library.`;
}

export function sameAccess(left: AccessDraft, right: AccessDraft): boolean {
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id) => b.includes(id));
  return left.orgWide === right.orgWide && same(left.memberIds, right.memberIds) && same(left.teamIds, right.teamIds);
}

/** Toast body after sharing: "6 people can use it now." */
export function sharedToastDescription(draft: AccessDraft, org: Directory, ownerId: string | null): string {
  if (draft.orgWide) return "Everyone in the organization can use it now.";
  const count = accessPeopleIds(draft, org, ownerId).length;
  const onlyTeam = draft.memberIds.filter((id) => id !== ownerId).length === 0 && draft.teamIds.length === 1
    ? org.teams.find((team) => team.id === draft.teamIds[0])?.name
    : undefined;
  if (count === 0) return "Only you can use it now.";
  return onlyTeam ? `${peopleLabel(count)} in ${onlyTeam} can use it now.` : `${peopleLabel(count)} can use it now.`;
}

/** "They get the skill, the command and HubSpot. Each person uses their own HubSpot account." */
export function pluginShareSubtitle(plugin: Pick<DenPlugin, "skills" | "commands" | "mcps">): string {
  const parts = [
    ...(plugin.skills.length === 1 ? ["the skill"] : plugin.skills.length > 1 ? [`${plugin.skills.length} skills`] : []),
    ...(plugin.commands.length === 1 ? ["the command"] : plugin.commands.length > 1 ? [`${plugin.commands.length} commands`] : []),
    ...plugin.mcps.map((mcp) => mcp.name),
  ];
  if (parts.length === 0) return "They get everything inside it.";
  const connectors = plugin.mcps.map((mcp) => mcp.name);
  const accounts = connectors.length > 0 ? ` Each person uses their own ${joinNames(connectors)} account.` : "";
  return `They get ${joinNames(parts, parts.length)}.${accounts}`;
}

/** "Sales can use it now / 8 people will find it in My Library.", or null when nobody was added. */
export function accessAddedToast(previous: AccessDraft, next: AccessDraft, org: Directory, ownerId: string | null): { title: string; description: string } | null {
  const added: AccessDraft = {
    orgWide: next.orgWide && !previous.orgWide,
    memberIds: next.memberIds.filter((id) => !previous.memberIds.includes(id)),
    teamIds: next.teamIds.filter((id) => !previous.teamIds.includes(id)),
  };
  if (added.orgWide) return { title: "Everyone can use it now", description: "They will find it in My Library." };
  if (added.memberIds.length === 0 && added.teamIds.length === 0) return null;
  const names = accessNames(added, org, null);
  const reached = accessPeopleIds(added, org, ownerId).length;
  return {
    title: `${joinNames(names) || "They"} can use it now`,
    description: `${peopleLabel(reached)} will find it in My Library.`,
  };
}
