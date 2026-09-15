import { z } from "zod";
import { nativeV2SkillsSchema, type NativeV2Skill } from "@openwork/headless-threads/v2";

const scopeSchema = z.object({ baseUrl: z.string().min(1), orgId: z.string().min(1), accountId: z.string().min(1) }).strict();
export type SkillAccountScope = z.infer<typeof scopeSchema>;
const cloudSourceSchema = z.object({ type: z.literal("openwork-cloud"), uri: z.string().startsWith("skill://"), scope: z.string().min(1) }).strict();
const selectionSchema = z.object({
  id: z.string().min(1), label: z.string().min(1), workspaceId: z.string().min(1),
  source: cloudSourceSchema.optional(),
  account: scopeSchema.optional(),
}).strict().refine((skill) => Boolean(skill.source) === Boolean(skill.account), "Cloud skill selection needs its original account.");
export const skillSelectionsSchema = z.array(selectionSchema).max(32);
export type SelectedSkill = z.infer<typeof selectionSchema>;
export type SkillFields = { skills?: Array<{ id: string }>; skillSelections?: SelectedSkill[] };

export function selectionFields(selections: SelectedSkill[]): SkillFields {
  const skillSelections = skillSelectionsSchema.parse(selections);
  return { skills: nativeV2SkillsSchema.parse(skillSelections.map(({ id }) => ({ id }))), skillSelections };
}

export function mergeSkillSelections(current: SelectedSkill[], added: SelectedSkill[]): SelectedSkill[] {
  const merged = skillSelectionsSchema.parse(current);
  for (const skill of skillSelectionsSchema.parse(added)) {
    const existing = merged.find((item) => item.id === skill.id);
    if (existing && !sameSkillProvenance(existing, skill)) throw new Error("This skill has conflicting account, workspace, or source selections. Resolve the selected chip before editing the queued message; both drafts are kept.");
    if (!existing) merged.push(skill);
  }
  return skillSelectionsSchema.parse(merged);
}

function sameSkillProvenance(left: SelectedSkill, right: SelectedSkill): boolean {
  return left.workspaceId === right.workspaceId && left.source?.type === right.source?.type && left.source?.uri === right.source?.uri && left.source?.scope === right.source?.scope
    && left.account?.baseUrl === right.account?.baseUrl && left.account?.orgId === right.account?.orgId && left.account?.accountId === right.account?.accountId;
}

/** The opaque server receipt is selected once, never replaced with today's scope. */
export function selectedCloudSkillScope(fields: SkillFields): string | undefined {
  const scopes = new Set(skillSelectionsSchema.parse(fields.skillSelections ?? []).flatMap((skill) => skill.source ? [skill.source.scope] : []));
  if (scopes.size > 1) throw new Error("Selected Cloud skills belong to different source scopes. Resolve their chips before sending; your words are kept.");
  return [...scopes][0];
}

export function sameSkillFields(left: SkillFields, right: SkillFields): boolean {
  return JSON.stringify(nativeV2SkillsSchema.parse(left.skills ?? [])) === JSON.stringify(nativeV2SkillsSchema.parse(right.skills ?? []))
    && JSON.stringify(left.skillSelections ?? []) === JSON.stringify(right.skillSelections ?? []);
}

/** Exact native ID or Cloud source URI only. Titles and prose never select skills. */
export function selectCatalogSkill(catalog: NativeV2Skill[], request: { id?: string; uri?: string; label?: string }, workspaceId: string, account: SkillAccountScope | null): SelectedSkill {
  const matches = catalog.filter((skill) => request.uri ? skill.source?.type === "openwork-cloud" && skill.source.uri === request.uri : request.id === skill.id);
  if (matches.length !== 1) throw new Error("This skill is no longer available in this workspace. Refresh Apps & tools and select it again.");
  const skill = matches[0]!;
  if (skill.source && !account) throw new Error("Sign in to the original OpenWork account before selecting this skill.");
  if (skill.source && !cloudSourceSchema.safeParse(skill.source).success) throw new Error("This skill has no confirmed source scope. Refresh Apps & tools and select it again; your words are kept.");
  return selectionSchema.parse({ id: skill.id, label: request.label || skill.name, workspaceId, ...(skill.source ? { source: skill.source, account } : {}) });
}

/** Validate stored provenance before a NEW admission; never resolve old content on recovery. */
export function validateSkillSelections(fields: SkillFields, catalog: NativeV2Skill[], workspaceId: string, account: SkillAccountScope | null): void {
  const ids = nativeV2SkillsSchema.parse(fields.skills ?? []);
  const selections = skillSelectionsSchema.parse(fields.skillSelections ?? []);
  selectedCloudSkillScope(fields);
  if (ids.length !== selections.length || ids.some((skill, index) => skill.id !== selections[index]?.id)) throw new Error("The saved skill selection does not match this turn. Remove it and select the skill again; your words are kept.");
  for (const selected of selections) {
    if (selected.workspaceId !== workspaceId || (selected.account && JSON.stringify(selected.account) !== JSON.stringify(account))) throw new Error("The OpenWork account, organization, or workspace changed. Remove the selected skill and select it again; your words are kept.");
    const live = selectCatalogSkill(catalog, { id: selected.id }, workspaceId, account);
    if (JSON.stringify(live.source) !== JSON.stringify(selected.source)) throw new Error("The selected skill's source changed. Remove it and select it again; your words are kept.");
  }
}

export type ComposerDraft = { text: string; skills: SelectedSkill[] };
export function parseComposerDraft(value: string | null, legacyText = ""): ComposerDraft {
  if (value === null) return { text: legacyText, skills: [] };
  try {
    return z.object({ text: z.string(), skills: skillSelectionsSchema }).strict().parse(JSON.parse(value));
  } catch {
    // Preserve recoverable words even if a selection is malformed; never turn it into a sendable unselected draft.
    throw new Error("The saved skill draft is unreadable. Its original draft has been kept.");
  }
}
export function sameComposerDraft(left: ComposerDraft, right: ComposerDraft): boolean {
  return left.text === right.text && JSON.stringify(left.skills) === JSON.stringify(right.skills);
}

export type ComposerDraftSnapshot = { key: string; revision: number; value: ComposerDraft };
export type ComposerDraftSubmission = { messageId: string; snapshot: ComposerDraftSnapshot };

/** One authoritative revision per discussion, shared by mounts and all late callbacks. */
export function createComposerDraftStore(io: { read: (key: string) => ComposerDraft; write: (key: string, value: ComposerDraft) => void }) {
  const entries = new Map<string, ComposerDraftSnapshot>();
  const listeners = new Map<string, Set<() => void>>();
  const submissions = new Map<string, ComposerDraftSubmission>();
  const releasedDrafts = new Map<string, ComposerDraftSnapshot>();
  function read(key: string): ComposerDraftSnapshot {
    let entry = entries.get(key);
    if (!entry) { entry = { key, revision: 0, value: io.read(key) }; entries.set(key, entry); }
    return entry;
  }
  function update(key: string, change: ComposerDraft | ((current: ComposerDraft) => ComposerDraft), expectedRevision?: number, durable = false): ComposerDraftSnapshot | null {
    const current = read(key);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) return null;
    const value = typeof change === "function" ? change(current.value) : change;
    if (sameComposerDraft(current.value, value)) return current;
    try { io.write(key, value); } catch (cause) { if (durable) throw cause; }
    const next = { key, revision: current.revision + 1, value };
    entries.set(key, next);
    for (const listener of listeners.get(key) ?? []) listener();
    return next;
  }
  function clear(snapshot: ComposerDraftSnapshot): boolean {
    return update(snapshot.key, { text: "", skills: [] }, snapshot.revision) !== null;
  }
  function transfer(snapshot: ComposerDraftSnapshot, targetKey: string): ComposerDraftSnapshot {
    const target = read(targetKey);
    if (read(snapshot.key).revision !== snapshot.revision || target.revision !== 0 || target.value.text || target.value.skills.length) throw new Error("A discussion draft changed during transfer. Its words and skills are kept.");
    const transferred = update(targetKey, snapshot.value, target.revision, true);
    if (!transferred) throw new Error("The destination draft changed during transfer. Its words and skills are kept.");
    return transferred;
  }
  const submissionKey = (key: string, messageId: string) => JSON.stringify([key, messageId]);
  function bindSubmission(key: string, messageId: string, value: ComposerDraft): ComposerDraftSubmission {
    const id = submissionKey(key, messageId);
    const existing = submissions.get(id);
    if (existing) {
      if (!sameComposerDraft(existing.snapshot.value, value)) throw new Error("This message already owns a different draft.");
      return existing;
    }
    const current = read(key);
    // A newer draft may already occupy the transferred discussion. Its revision is never acknowledged by the old send.
    const snapshot = sameComposerDraft(current.value, value) ? current : { key, revision: -1, value };
    const submission = { messageId, snapshot };
    submissions.set(id, submission);
    return submission;
  }
  function beginSubmission(snapshot: ComposerDraftSnapshot, messageId: string): ComposerDraftSubmission | null {
    if (read(snapshot.key).revision !== snapshot.revision || [...submissions.values()].some((item) => item.snapshot.key === snapshot.key && item.snapshot.revision === snapshot.revision)) return null;
    return bindSubmission(snapshot.key, messageId, snapshot.value);
  }
  function releaseSubmission(submission: ComposerDraftSubmission): void {
    const id = submissionKey(submission.snapshot.key, submission.messageId);
    if (submissions.get(id) !== submission || releasedDrafts.has(id)) return;
    const cleared = update(submission.snapshot.key, { text: "", skills: [] }, submission.snapshot.revision, true);
    if (cleared) releasedDrafts.set(id, cleared);
  }
  function finishSubmission(submission: ComposerDraftSubmission, acknowledged: boolean | "uncertain"): void {
    const id = submissionKey(submission.snapshot.key, submission.messageId);
    if (submissions.get(id) !== submission) return;
    const released = releasedDrafts.get(id);
    if (acknowledged === true) clear(submission.snapshot);
    else if (acknowledged === false && released) update(released.key, submission.snapshot.value, released.revision, true);
    releasedDrafts.delete(id);
    submissions.delete(id);
  }
  return {
    read, update, clear, transfer, bindSubmission, beginSubmission, releaseSubmission, finishSubmission,
    hasOtherSubmission: (key: string, messageId?: string) => [...submissions.values()].some((item) => item.snapshot.key === key && item.messageId !== messageId),
    subscribe(key: string, listener: () => void) {
      let set = listeners.get(key);
      if (!set) { set = new Set(); listeners.set(key, set); }
      set.add(listener);
      return () => { set.delete(listener); };
    },
  };
}
