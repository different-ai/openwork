import type { AutomationRunStatus } from "@openwork/types/automations";
import type { PersonalAgentAdminItem, PersonalAgentEventDetail } from "@openwork/types/den/personal-agents";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatAgentMoney(micros: number) {
  return usd.format(micros / 1_000_000);
}

function roleLabel(role: string) {
  return role === "manager" ? "Manager" : role === "collaborator" ? "Collaborator" : "Member";
}

export const notSharedReason = "Only its owner can share it first.";

export function agentAccess(item: Pick<PersonalAgentAdminItem, "sharedWith" | "audience">, orgName: string) {
  const { sharedWith: people, audience: { organization, autoAddOrganization, teams } } = item;
  const notShared = !organization && teams.length === 0 && people.length === 0;
  const addedToSidebar = (organization && autoAddOrganization) || teams.some((team) => team.autoAdd);
  const text = organization ? `Everyone in ${orgName}` : notShared ? "Not shared"
    : teams.length + people.length > 3 ? [
      teams.length ? `${teams.length} ${teams.length === 1 ? "team" : "teams"}` : "",
      people.length ? `${people.length} ${people.length === 1 ? "person" : "people"}` : "",
    ].filter(Boolean).join(", ") : [
      ...teams.map(({ name }) => name || "Unnamed team"),
      ...people.map(({ name, role }) => `${name || "Unnamed member"} (${roleLabel(role)})`),
    ].join(", ");
  return { text, notShared, addedToSidebar };
}

export function writeAccessText({ allowed, ask, blocked }: PersonalAgentAdminItem["writeAccess"]) {
  return allowed || ask || blocked ? `${allowed} allowed · ${ask} ask · ${blocked} blocked` : "Asks first";
}

export function agentEventSentence(action: string, detail: PersonalAgentEventDetail, agentName: string | null) {
  const text = (key: string) => {
    const value = detail[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const agent = agentName || "an agent";
  const member = text("member") || text("memberName") || "a member";
  const role = roleLabel(text("role"));
  const tool = text("tool") || "a tool";
  const routine = text("routineName");
  const budget = typeof detail.monthlyBudgetMicros === "number" ? formatAgentMoney(detail.monthlyBudgetMicros) : null;
  switch (action) {
    case "agent.created": return `created ${agent}`;
    case "agent.updated": return detail.tools === true || detail.toolPolicy === true ? `changed the tools ${agent} may use` : `updated ${agent}`;
    case "agent.archived": return `archived ${agent}`;
    case "agent.paused": return `paused ${agent}`;
    case "agent.resumed": return `resumed ${agent}`;
    case "agent.transferred": return `moved ${agent} from ${text("from") || "the previous owner"} to ${text("to") || "another owner"}`;
    case "agent.budget_set": return budget ? `set ${agent}'s budget to ${budget} a month` : `removed ${agent}'s budget`;
    case "agent.tools_changed": return `changed the tools ${agent} may use`;
    case "share.added": return `shared ${agent} with ${member} as ${role}`;
    case "share.changed": {
      if (detail.what === "shared_login") {
        const connection = text("connection");
        const login = connection ? `${connection} login` : "login";
        return `${detail.on === true ? "shared" : "stopped sharing"} their ${login} with ${agent}`;
      }
      if ("organization" in detail || "teams" in detail) return `changed who can use ${agent}`;
      return `changed ${member}'s role on ${agent} to ${role}`;
    }
    case "share.removed": return `removed ${member}'s access to ${agent}`;
    case "routine.created": return `added ${routine || "a routine"} to ${agent}`;
    case "routine.changed": return `changed ${routine || "a routine"} on ${agent}`;
    case "request.asked": return detail.kind === "change" || !text("tool") ? `asked to change ${agent}` : `asked to let ${agent} use ${tool}`;
    case "request.denied": return text("tool") ? `denied ${agent} access to ${tool}` : `denied a request to change ${agent}`;
    case "request.allowed_once": return `let ${agent} use ${tool} once`;
    case "request.always_allowed": return `let ${agent} always use ${tool}`;
    case "request.approved": return `approved a change to ${agent}`;
    case "organization.sharing_changed":
    case "organization.shared_logins_changed":
    case "organization.rules_changed":
    case "organization.tools_changed": {
      const what = action === "organization.sharing_changed" ? "sharing"
        : action === "organization.shared_logins_changed" ? "shared_logins"
        : action === "organization.rules_changed" ? "rules" : detail.what;
      if (what === "sharing") return detail.shareMode === "admins" ? "limited sharing agents to admins" : "let everyone share agents";
      if (what === "shared_logins") return detail.on === true ? "allowed shared logins" : "turned shared logins off";
      if (what === "rules") return "changed the rules every agent follows";
      return "changed the tool rules for every agent";
    }
    case "organization.budget_set": return budget ? `set the spending limit for every agent to ${budget} a month` : "removed the spending limit for every agent";
    default: return `recorded ${action.replace(/[._-]+/g, " ").trim() || "a change"}`;
  }
}

export const runStatusText: Record<AutomationRunStatus, string> = {
  queued: "Waiting",
  claimed: "Starting",
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  cancelled: "Canceled",
  skipped: "Skipped",
};

export function latestAgentRun(routines: PersonalAgentAdminItem["routines"]) {
  return routines.reduce<PersonalAgentAdminItem["routines"][number]["latestRun"]>((latest, routine) => {
    const run = routine.latestRun;
    return run && (!latest || run.createdAt > latest.createdAt) ? run : latest;
  }, null);
}

const facePalette = [
  "bg-[#e5484d] text-white", "bg-[#0090ff] text-white", "bg-[#8e4ec6] text-white", "bg-[#f76b15] text-white",
  "bg-[#30a46c] text-white", "bg-[#d6409f] text-white", "bg-[#00a2c7] text-white", "bg-[#ffc53d] text-white",
  "bg-[#3e63dd] text-white", "bg-[#12a594] text-white", "bg-[#e93d82] text-white", "bg-[#6e56cf] text-white",
];

export function agentFaceColor(name: string) {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return facePalette[hash % facePalette.length];
}
