import {
  COMPUTER_INVENTORY_STATE_LABELS, ORGANIZATION_COMPUTER_INVENTORY_TABS,
  type ComputerInventoryKind, type ComputerInventoryOwner, type ComputerInventoryRow, type ComputerInventoryState,
  type ComputerMergedSignIn, type ComputerRunCode, type ComputerRunCodeOffReason,
  type OrganizationComputerInventoryTab, type OrganizationComputerRules,
} from "@openwork/types/den/computer-inventory";
import { countLabel, relativeTime, type DeviceTone } from "./computers-format";

export const INVENTORY_TAB_LABELS: Record<OrganizationComputerInventoryTab, string> = {
  desktops: "Desktops", cloud: "Cloud", attention: "Needs attention", former: "Former members",
};

const EMPTY_TAB_LINES: Record<OrganizationComputerInventoryTab, string> = {
  desktops: "No desktops here yet. Sign in to OpenWork on a Mac or PC with this organization to add it.",
  cloud: "No cloud computers here yet. Add one in OpenWork under Settings › Devices.",
  attention: "No computers need attention. Use Desktops or Cloud to see the rest.",
  former: "No computers from former members here. Use Desktops or Cloud to see current computers.",
};

export const MY_INVENTORY_EMPTY = "No computers yet. Sign in to OpenWork on a computer with this organization and it appears here.";

export type InventoryFilters = {
  tab: OrganizationComputerInventoryTab;
  search: string;
  older: boolean;
  page: number;
  computer: string;
};

export function readInventoryFilters(params: { get: (name: string) => string | null }): InventoryFilters {
  const tab = params.get("tab");
  const page = params.get("page");
  return {
    tab: ORGANIZATION_COMPUTER_INVENTORY_TABS.find((entry) => entry === tab) ?? "desktops",
    search: (params.get("search") ?? "").slice(0, 160),
    older: params.get("older") === "include",
    page: page && /^[1-9]\d{0,8}$/.test(page) ? Number(page) : 1,
    computer: params.get("computer")?.trim() ?? "",
  };
}

export function writeInventoryFilters(params: URLSearchParams, filters: InventoryFilters) {
  params.set("tab", filters.tab);
  if (filters.search) params.set("search", filters.search);
  else params.delete("search");
  if (filters.older) params.set("older", "include");
  else params.delete("older");
  if (filters.page > 1) params.set("page", String(filters.page));
  else params.delete("page");
  if (filters.computer) params.set("computer", filters.computer);
  else params.delete("computer");
  return params;
}

export function inventoryEmptyLine(filters: InventoryFilters) {
  return filters.search.trim() ? "No computers match. Try another name or owner." : EMPTY_TAB_LINES[filters.tab];
}

const STATUS_TONES: Record<ComputerInventoryState, DeviceTone> = {
  online: "success", ready: "success", offline: "neutral", starts_when_needed: "neutral", has_a_problem: "warning",
};

export function inventoryReachableLine(computers: readonly ComputerInventoryRow[]) {
  if (!computers.length) return "No computers yet";
  const count = computers.filter(({ status }) => status.state === "online" || status.state === "ready").length;
  return `${count.toLocaleString()} of ${computers.length.toLocaleString()} reachable now`;
}

export function inventoryDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function lastSeenLine(iso: string | null, now: number) {
  return iso ? `Last seen ${relativeTime(iso, now).toLowerCase()}` : "Never seen";
}

export function inventoryStatus(status: ComputerInventoryRow["status"], now: number) {
  return {
    label: COMPUTER_INVENTORY_STATE_LABELS[status.state],
    tone: STATUS_TONES[status.state],
    detail: status.state === "offline" ? lastSeenLine(status.lastSeenAt, now) : null,
  };
}

const DEVICES_SETTING = "Settings > Devices on this computer";
const OWNER_CHOICE = `They choose in ${DEVICES_SETTING}.`;
const RUN_CODE_REASONS: Record<ComputerRunCodeOffReason, string> = {
  organization: "The organization turned it off.",
  owner: "Its owner turned it off.",
  not_chosen: "Its owner has not chosen yet.",
  revoked: "Access was revoked.",
  sandbox_unavailable: "This computer can't run the OpenWork sandbox.",
  nothing_shared: `Its owner hasn't shared a folder with another computer yet. ${OWNER_CHOICE}`,
};

export function inventoryRunCode(code: ComputerRunCode, kind: ComputerInventoryKind, callerIsOwner = false) {
  const desktop = kind === "desktop";
  const runCode: ComputerRunCode = desktop && code.value === "not_available"
    ? { value: "no", reason: "sandbox_unavailable" }
    : code;
  const off = runCode.value === "no" ? runCode.reason : null;
  const reason = desktop && off === "not_chosen" ? `Its owner hasn't turned this on. ${OWNER_CHOICE}`
    : off ? RUN_CODE_REASONS[off] : null;
  const setting = desktop && callerIsOwner && off === "owner" ? DEVICES_SETTING : null;
  const label = runCode.value === "no" ? "No"
    : runCode.value === "not_available" ? "Not available yet"
      : runCode.value === "sandbox" ? `In sandbox, ${runCode.folders ? countLabel(runCode.folders, "folder") : "no folders"}`
        : "Yes, whole computer";
  return { value: runCode.value, label, reason, setting, locked: Boolean(off) && (desktop || off === "organization") };
}

export function inventoryOwnerName(owner: ComputerInventoryOwner | null) {
  const email = owner?.email?.trim();
  return owner?.name?.trim() || (email && !email.toLowerCase().endsWith(".invalid") ? email : null);
}

export function mergedInventoryLine(count: number) {
  return count === 1 ? "1 older sign-in of these same computers is merged in." : `${countLabel(count, "older sign-in")} of these same computers are merged in.`;
}

export function removableMergedSignIns(signIns: readonly ComputerMergedSignIn[], computerId: string) {
  return signIns.filter((signIn) => signIn.computerId === computerId && signIn.canRemove);
}

export function onOff(value: boolean) {
  return value ? "On" : "Off";
}

const SESSION_RULE_LINES: Record<OrganizationComputerRules["sessions"], string> = {
  off: "Other devices can't start tasks or open sessions.",
  created: "Other devices can start tasks and open only the sessions they started.",
  all: "Other devices can start tasks and open sessions.",
};

export function computerRulesLine(rules: OrganizationComputerRules) {
  const sessions = SESSION_RULE_LINES[rules.sessions];
  const runCode = rules.runCode ? "Agents on other computers can run code" : "Agents on other computers can't run code";
  const sandbox = rules.requireSandboxOnPersonal ? "Personal computers require a sandbox for work from other computers." : "Personal computers don't require a sandbox for work from other computers.";
  if (rules.runCode && rules.requireSandboxOnPersonal) return `${sessions} ${runCode}; on personal computers only in the sandbox.`;
  return `${sessions} ${runCode}. ${sandbox}`;
}
