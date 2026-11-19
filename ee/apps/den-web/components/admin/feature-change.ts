/**
 * The latest change to a feature, as den-api returns it (`lastChange`), and the
 * one line /admin shows for it: "On for this organization by Omar · 26 Oct 2026, 14:03".
 */

export type AdminFeatureChange = {
  scope: "everyone" | "organization" | "member";
  action: "on" | "off" | "reset" | "killed" | "restored";
  at: string;
  by: { id: string; name: string; email: string } | null;
};

const SCOPES = ["everyone", "organization", "member"] as const;
const ACTIONS = ["on", "off", "reset", "killed", "restored"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseFeatureChange(value: unknown): AdminFeatureChange | null {
  if (!isRecord(value) || typeof value.at !== "string" || Number.isNaN(Date.parse(value.at))) return null;
  const scope = SCOPES.find((entry) => entry === value.scope);
  const action = ACTIONS.find((entry) => entry === value.action);
  if (!scope || !action) return null;
  const by = isRecord(value.by) && typeof value.by.id === "string" && typeof value.by.name === "string" && typeof value.by.email === "string"
    ? { id: value.by.id, name: value.by.name, email: value.by.email }
    : null;
  return { scope, action, at: value.at, by };
}

const SCOPE_WORDS: Record<AdminFeatureChange["scope"], string> = {
  everyone: "for everyone",
  organization: "for this organization",
  member: "for this member",
};

function actionWords(change: AdminFeatureChange, showScope: boolean): string {
  switch (change.action) {
    case "on": return showScope ? `On ${SCOPE_WORDS[change.scope]}` : "On";
    case "off": return showScope ? `Off ${SCOPE_WORDS[change.scope]}` : "Off";
    case "reset": return change.scope === "member" ? "Reset to the organization setting" : "Reset to everyone’s setting";
    case "killed": return "Turned off everywhere";
    case "restored": return "Restored";
  }
}

export function formatFeatureChangeTime(at: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(at));
}

/**
 * "On by Omar McAdam · 26 Oct 2026, 14:03". Pass `showScope` where changes from
 * more than one scope can appear (an organization's or member's Features list).
 */
export function describeFeatureChange(change: AdminFeatureChange, options: { showScope?: boolean; locale?: string } = {}): string {
  const who = change.by ? ` by ${change.by.name.trim() || change.by.email}` : "";
  return `${actionWords(change, options.showScope ?? false)}${who} · ${formatFeatureChangeTime(change.at, options.locale)}`;
}
