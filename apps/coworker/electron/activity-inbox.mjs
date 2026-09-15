import { marked } from "marked";
import { assertEventIdentity } from "./event-execution.mjs";

export const MAX_ACTIVITY_ITEMS = 300;
export const EVENT_REMINDER_LEAD_MS = 10 * 60_000;

/** Inspect prose, not Markdown source URLs, quoted people, or code examples. */
export function mentionsYou(value) {
  const standalone = /(?<![\p{L}\p{N}\p{M}_@./\\%+~=\uFFFC-])@you(?![\p{L}\p{N}\p{M}_@/\\%+~=\uFFFC-]|\.[\p{L}\p{N}])/iu;
  function prose(tokens) {
    return tokens.map((token) => {
      if (["code", "codespan", "blockquote", "html", "image", "escape"].includes(token.type)) return "\uFFFC";
      if (token.type === "link" && (token.text === token.href || token.href === `mailto:${token.text}`)) return "\uFFFC";
      if (token.tokens) {
        const content = prose(token.tokens);
        return ["paragraph", "heading", "text"].includes(token.type) ? `\n${content}\n` : content;
      }
      if (token.items) return `\n${prose(token.items)}\n`;
      if (token.type === "table") return `\n${[...token.header, ...token.rows.flat()].map((cell) => prose(cell.tokens)).join("\n")}\n`;
      return token.type === "text" ? token.text : "\n";
    }).join("");
  }
  try {
    return typeof value === "string" && standalone.test(prose(marked.lexer(value)).replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|mailto:|www\.)[^\s<>]+/giu, "\uFFFC"));
  } catch { return false; } // Unusual Markdown is an ordinary reply, never failed work.
}

/** Called only within collaboration.change, alongside the source's durable
 * completion/publication receipt. Keep the source marker when the row is pruned. */
export function recordActivity(state, entry, input) {
  // This optional projection must not roll back the source's successful native
  // transition. Construct the bounded replacement before changing the index.
  try { captureActivity(state, entry, input); } catch { /* No raw reply logging. */ }
}

function captureActivity(state, entry, { event, text, at }) {
  const task = entry && state.tasks[entry.taskId];
  if (!entry || entry.activityRecorded || entry.state !== "succeeded" || task?.activityEligible !== true || !entry.workspaceId || typeof entry.coworkerCreatedAt !== "string" || !entry.coworkerCreatedAt.trim()) return;
  const owner = entry.owner;
  let target;
  if (owner.kind === "private") {
    if (event || task.state !== "succeeded" || task.executionId !== entry.id) return;
    target = { kind: "private", threadId: owner.threadId };
  } else if (["group", "consultation"].includes(owner.kind)) {
    if (!event || !event.id || event.kind !== "coworker" || event.status === "passed" || event.slug !== owner.slug || event.threadId !== owner.threadId || event.executionId !== entry.id || !owner.groupId || owner.conversationId !== owner.groupId) return;
    target = { kind: "group", groupId: owner.groupId, eventId: event.id };
    const run = owner.eventRunId && state.workplaceEvents?.runs[owner.eventRunId];
    const identity = run?.identities?.[owner.slug];
    if (run?.event.groupId === owner.groupId && run.event.participantSlugs.includes(owner.slug) && identity?.createdAt === entry.coworkerCreatedAt && (!identity.workspaceId || identity.workspaceId === entry.workspaceId)) {
      Object.assign(target, { workplaceEventId: run.eventId, runId: run.id, scheduledFor: run.scheduledFor });
    }
    text = event.text;
    at = event.at;
  } else return;
  const preview = typeof text === "string" ? text.trim().replace(/\s+/g, " ").slice(0, 400) : "";
  if (preview) {
    const item = { id: `activity_${entry.id}`, kind: mentionsYou(text) ? "mention" : "reply", at, slug: owner.slug, workspaceId: entry.workspaceId, coworkerCreatedAt: entry.coworkerCreatedAt, preview, readAt: null, target };
    state.activity = [item, ...state.activity].sort((a, b) => b.at - a.at).slice(0, MAX_ACTIVITY_ITEMS);
  }
  entry.activityRecorded = true;
}

function reminderDue(state, event, at) {
  const due = event?.nextDueAt;
  return event?.state === "active" && !event.manualOnly && Number.isSafeInteger(due) && due > at && due - EVENT_REMINDER_LEAD_MS <= at
    && due >= event.startsAt && (event.repeatUntil == null || due <= event.repeatUntil)
    && !Object.values(state.workplaceEvents.runs).some((run) => run.eventId === event.id && run.trigger !== "manual" && run.scheduledFor === due);
}

function currentReminder(state, item, at) {
  const event = state.workplaceEvents?.definitions[item.target.eventId];
  return event?.activityReminder?.id === item.id && event.activityReminder.scheduledFor === item.target.scheduledFor
    && event.groupId === item.target.groupId && event.nextDueAt === item.target.scheduledFor && reminderDue(state, event, at);
}

function reminderCopy(event) {
  const title = event.title.trim().replace(/\s+/g, " ").slice(0, 160);
  return { title, preview: `${title} starts soon. Open the Event in Calendar.` };
}

export function eventRemindersNeeded(state, at) {
  try {
    return state.activity.some((item) => item.kind === "event-reminder" && !currentReminder(state, item, at))
      || Object.values(state.workplaceEvents?.definitions ?? {}).some((event) => event.activityReminder?.scheduledFor !== event.nextDueAt && reminderDue(state, event, at));
  } catch { return false; }
}

export function reconcileEventReminders(state, at) {
  try {
    const items = state.activity.filter((item) => item.kind !== "event-reminder" || currentReminder(state, item, at));
    const receipts = [];
    for (const event of Object.values(state.workplaceEvents?.definitions ?? {})) {
      if (event.activityReminder?.scheduledFor === event.nextDueAt || !reminderDue(state, event, at)) continue;
      const generation = event.activityReminder?.generation ?? 0;
      const id = `activity_reminder_${event.id}_${generation}_${event.nextDueAt}`;
      const identities = Object.fromEntries(event.participantSlugs.map((slug) => [slug, structuredClone(event.identities[slug])]));
      items.push({ id, kind: "event-reminder", at, readAt: null, ...reminderCopy(event),
        target: { kind: "event", eventId: event.id, groupId: event.groupId, scheduledFor: event.nextDueAt }, identities });
      receipts.push([event, { generation, id, scheduledFor: event.nextDueAt }]);
    }
    const bounded = items.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, MAX_ACTIVITY_ITEMS);
    state.activity = bounded;
    for (const [event, receipt] of receipts) event.activityReminder = receipt;
  } catch {}
}

export function updateEventReminder(state, previous, event, at, reset) {
  try {
    const items = state.activity.flatMap((item) => {
      if (item.kind !== "event-reminder" || item.target.eventId !== event.id) return [item];
      return !reset && currentReminder(state, item, at) ? [{ ...item, ...reminderCopy(event) }] : [];
    });
    const receipt = reset ? { generation: (previous.activityReminder?.generation ?? 0) + 1, id: null, scheduledFor: null } : event.activityReminder;
    state.activity = items;
    if (receipt) event.activityReminder = receipt;
  } catch {}
}

export function activityReadIds(ids, read) {
  if (!Array.isArray(ids) || ids.length > MAX_ACTIVITY_ITEMS || ids.some((id) => typeof id !== "string" || !id.trim() || id.length > 240) || typeof read !== "boolean") throw new Error("Choose up to 300 Activity IDs and a read or unread state.");
  return new Set(ids);
}

/** Main-process projection. A recycled slug is not the original actor. Reads
 * never prepare a workspace, inspect native history, or expose coworker tools. */
export function createActivityInbox({ collaboration, coworkers, groups, now = Date.now }) {
  async function list() {
    const [actors, memberships] = await Promise.all([coworkers(), groups()]);
    return collaboration.read((state) => {
      const at = now();
      return state.activity.flatMap((item) => {
        if (item.kind === "event-reminder") {
          try {
            if (!currentReminder(state, item, at)) return [];
            const group = memberships.find((group) => group.id === item.target.groupId && group.archivedAt === null);
            const identities = Object.entries(item.identities);
            if (!group?.eventId || !identities.length || group.participantSlugs.length !== identities.length) return [];
            for (const [slug, identity] of identities) {
              if (!group.participantSlugs.includes(slug)) return [];
              assertEventIdentity(identity, actors.find((actor) => actor.slug === slug));
            }
            return [{ id: item.id, kind: item.kind, at: item.at, readAt: item.readAt, title: item.title, preview: item.preview, target: item.target }];
          } catch { return []; }
        }
        return typeof item.coworkerCreatedAt === "string" && item.coworkerCreatedAt.trim() && actors.some((actor) => actor.slug === item.slug && actor.workspaceId && actor.workspaceId === item.workspaceId && actor.createdAt === item.coworkerCreatedAt)
          && (item.target.kind === "private" || memberships.some((group) => group.id === item.target.groupId && group.archivedAt === null && group.participantSlugs.includes(item.slug))) ? [item] : [];
      });
    });
  }
  return {
    list,
    async markRead(ids, read = true) {
      const requested = activityReadIds(ids, read);
      const visible = await list();
      await collaboration.markActivityRead(visible.filter((item) => requested.has(item.id)).map((item) => item.id), read);
      return list();
    },
  };
}
