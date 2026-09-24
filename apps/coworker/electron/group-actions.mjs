import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { z } from "zod";
import { assertEventHumanOrigin } from "./events.mjs";
import { changeGroupMembers, createGroup, getGroup, normalizeParticipantSlugs } from "./groups.mjs";

export const groupActionSchema = z.object({
  action: z.enum(["add", "remove", "start_parallel"]),
  participantSlugs: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).min(1).max(20),
  title: z.string().trim().min(1).max(80).optional(),
}).strict();

export function assertGroupActionToolContext({ slug, context, name, args, entry, snapshot, workspaceId, active }) {
  if (name !== "coworker_group_manage") throw new Error("Unknown group action.");
  groupActionSchema.parse(args);
  assertEventHumanOrigin(entry);
  const message = snapshot.messages.find((item) => item.id === context.messageID && item.role === "assistant");
  const part = message?.parts.find((item) => item.type === "tool" && item.callId === context.callID);
  const parent = snapshot.messages.find((item) => item.id === entry.messageId && item.role === "user");
  if (!active || entry.state !== "running" || !entry.sentAt || entry.owner.kind !== "group" || !entry.owner.groupId
    || entry.owner.conversationId !== entry.owner.groupId
    || entry.owner.slug !== slug || entry.owner.threadId !== context.sessionID || entry.workspaceId !== workspaceId
    || snapshot.threadId !== context.sessionID || !context.directory || !snapshot.directory
    || path.resolve(context.directory) !== path.resolve(snapshot.directory)
    || !parent?.parts.some((item) => item.type === "text" && item.text && !item.synthetic && !item.ignored)
    || message?.parentId !== entry.messageId || message.completedAt != null || message.error
    || part?.tool !== name || part.toolStatus !== "running" || !isDeepStrictEqual(part.toolInput, args)) {
    throw new Error("Group changes require this exact direct request in its group chat.");
  }
}

export function createGroupActions({ coworkersDir, coworkers, resolveContext }) {
  const attempts = new Map();
  return {
    async executeNative(slug, { args, context }, signal) {
      const nativeArguments = structuredClone(args);
      args = groupActionSchema.parse(nativeArguments);
      if (args.action !== "start_parallel" && args.title) throw new Error("A title is only for a new group chat.");
      signal?.throwIfAborted();
      const native = { sessionID: context?.sessionID, messageID: context?.messageID, callID: context?.callID, directory: context?.directory };
      const trusted = await resolveContext(slug, native, { name: "coworker_group_manage", args: nativeArguments });
      trusted.assertActive();
      const source = await getGroup(coworkersDir, trusted.entry.owner.groupId);
      if (source.archivedAt || !source.participantSlugs.includes(slug)) throw new Error("The originating group chat is no longer active.");
      const roster = await coworkers();
      const known = new Set(roster.map((member) => member.slug));
      if (args.participantSlugs.some((member) => !known.has(member))) throw new Error("Choose coworkers from the current team roster.");
      const participantSlugs = normalizeParticipantSlugs(args.participantSlugs, 1);
      const key = JSON.stringify([trusted.entry.id, native.callID]);
      if (attempts.has(key)) return attempts.get(key);
      if (attempts.size >= 4096) throw new Error("This app launch reached its group action receipt limit.");
      const operation = (async () => {
        signal?.throwIfAborted();
        trusted.assertActive();
        if (args.action === "start_parallel") {
          const currentSource = await getGroup(coworkersDir, source.id);
          if (currentSource.archivedAt || !currentSource.participantSlugs.includes(slug)) throw new Error("The originating group chat is no longer active.");
          const selected = normalizeParticipantSlugs(participantSlugs).sort();
          if (!selected.includes(slug)) throw new Error("Include the coworker starting this group chat.");
          const title = args.title ?? "Group chat";
          // A collective request may reach several speakers. Their identical
          // action opens one chat, including after a lost acknowledgement.
          const id = `grp_${createHash("sha256").update(JSON.stringify([source.id, trusted.entry.groupRequestId ?? trusted.entry.id, selected, title])).digest("hex").slice(0, 24)}`;
          const group = await createGroup(coworkersDir, { id, name: title, participantSlugs: selected });
          if (group.eventId || group.name !== title || !isDeepStrictEqual(group.participantSlugs, selected)) throw new Error("This group action ID already belongs to a different chat.");
          return { id: group.id, name: group.name, participantSlugs: group.participantSlugs, action: args.action };
        }
        const group = await changeGroupMembers(coworkersDir, source.id, args.action, participantSlugs, { actorSlug: slug });
        return { id: group.id, name: group.name, participantSlugs: group.participantSlugs, action: args.action };
      })();
      attempts.set(key, operation);
      return operation;
    },
  };
}
