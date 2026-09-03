/**
 * The team a new person meets during onboarding, before any coworker exists:
 * the intents they picked and the draft coworkers proposed from them, kept for
 * the session so Back, forward, and a crash mid-way lose nothing and create
 * nothing twice. Pure, so the rules are unit-tested; the screens only render
 * what these return.
 */
import type { TeamDraft, TeamRole } from "./bridge.ts";

export const ONBOARDING_DRAFT_KEY = "open-coworker.onboarding-team.v1";
export const MAX_TEAM_DRAFTS = 6;
const NAME_LIMIT = 40;

export type OnboardingDraft = {
  /** Stable for the whole onboarding, so a retry after a crash never creates a coworker twice. */
  draftId: string;
  intents: string[];
  drafts: TeamDraft[];
  /** Slugs created so far, so a retry skips them. */
  createdSlugs: string[];
};

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function newDraftId(): string {
  return `draft_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function emptyOnboardingDraft(): OnboardingDraft {
  return { draftId: newDraftId(), intents: [], drafts: [], createdSlugs: [] };
}

/** The saved draft, or a fresh one when nothing usable is stored. */
export function loadOnboardingDraft(storage: DraftStorage | null): OnboardingDraft {
  if (!storage) return emptyOnboardingDraft();
  try {
    const parsed: unknown = JSON.parse(storage.getItem(ONBOARDING_DRAFT_KEY) ?? "");
    if (!isRecord(parsed) || typeof parsed.draftId !== "string" || !parsed.draftId) return emptyOnboardingDraft();
    const drafts = Array.isArray(parsed.drafts) ? parsed.drafts.filter(isTeamDraft) : [];
    return { draftId: parsed.draftId, intents: strings(parsed.intents), drafts, createdSlugs: strings(parsed.createdSlugs) };
  } catch {
    return emptyOnboardingDraft();
  }
}

function isTeamDraft(value: unknown): value is TeamDraft {
  return isRecord(value) && typeof value.roleId === "string" && typeof value.name === "string" && typeof value.role === "string" && typeof value.mission === "string";
}

export function saveOnboardingDraft(storage: DraftStorage | null, draft: OnboardingDraft): void {
  try {
    storage?.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage full or unavailable: the screen still works for this visit.
  }
}

export function clearOnboardingDraft(storage: DraftStorage | null): void {
  try {
    storage?.removeItem(ONBOARDING_DRAFT_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** Toggle one intent, keeping the order the person picked them in. */
export function toggleIntent(intents: readonly string[], id: string): string[] {
  return intents.includes(id) ? intents.filter((intent) => intent !== id) : [...intents, id];
}

/** Mirrors the store's slug rule so a name is unique the way the store sees it. */
export function slugOfName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/['".]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "coworker";
}

/** Whether a name is free among the drafts (ignoring the draft at `except`). */
export function nameIsFree(drafts: readonly TeamDraft[], name: string, except = -1): boolean {
  const slug = slugOfName(name);
  return !drafts.some((draft, index) => index !== except && slugOfName(draft.name) === slug);
}

/** Rename one draft; an empty name restores the role's default, a taken name is refused (the drafts come back unchanged). */
export function renameDraft(drafts: readonly TeamDraft[], index: number, name: string, catalog: readonly TeamRole[]): TeamDraft[] {
  const draft = drafts[index];
  if (!draft) return [...drafts];
  const fallback = catalog.find((role) => role.id === draft.roleId)?.defaultName ?? draft.name;
  const next = name.trim().slice(0, NAME_LIMIT) || fallback;
  if (!nameIsFree(drafts, next, index)) return [...drafts];
  return drafts.map((item, position) => (position === index ? { ...item, name: next } : item));
}

/** Remove one draft; the last one stays (a team needs at least one coworker). */
export function removeDraft(drafts: readonly TeamDraft[], index: number): TeamDraft[] {
  if (drafts.length <= 1) return [...drafts];
  return drafts.filter((_, position) => position !== index);
}

/** The catalog roles not yet on the draft team, in catalog order. */
export function remainingRoles(catalog: readonly TeamRole[], drafts: readonly TeamDraft[]): TeamRole[] {
  return catalog.filter((role) => !drafts.some((draft) => draft.roleId === role.id));
}

/** A draft for one more role, named uniquely among the drafts. */
export function addDraft(drafts: readonly TeamDraft[], role: TeamRole): TeamDraft[] {
  if (drafts.length >= MAX_TEAM_DRAFTS || drafts.some((draft) => draft.roleId === role.id)) return [...drafts];
  let name = role.defaultName;
  for (let attempt = 2; !nameIsFree(drafts, name) && attempt < 100; attempt += 1) name = `${role.defaultName} ${attempt}`;
  return [...drafts, { roleId: role.id, name, role: role.role, mission: role.mission, avatarColor: role.avatarColor, avatarGlasses: role.avatarGlasses, personality: role.personality }];
}

/** "research and writing", "research, writing, and operations" — the intents as words. */
export function describeIntents(intents: readonly string[], catalog: readonly TeamRole[]): string {
  const words = intents
    .map((id) => catalog.find((role) => role.id === id)?.role.split(" and ")[0]?.toLowerCase() ?? "")
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0] ?? "";
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

/** The one line a coworker created at onboarding starts its working memory with. */
export function firstNoteFor(intents: readonly string[], catalog: readonly TeamRole[], now = Date.now()): string {
  const day = new Date(now).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const what = describeIntents(intents, catalog);
  return what ? `Joined the team on ${day} to help with ${what}.` : `Joined the team on ${day}.`;
}

/** The drafts still to create, given what an earlier attempt already made. */
export function draftsToCreate(drafts: readonly TeamDraft[], createdSlugs: readonly string[], existingSlugs: readonly string[]): TeamDraft[] {
  const done = new Set([...createdSlugs, ...existingSlugs]);
  return drafts.filter((draft) => !done.has(slugOfName(draft.name)));
}
