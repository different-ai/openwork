import { z } from "zod";
import { automationScheduleSchema } from "@openwork/types/automations";

/** Events reference the existing document owners; a reference grants no access. */
export const eventArtifactSchema = z.object({
  owner: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("coworker"), slug: z.string().min(1), createdAt: z.string().min(1) }),
    z.object({ kind: z.literal("group"), groupId: z.string().min(1) }),
  ]),
  documentId: z.string().min(1),
  title: z.string(),
  revision: z.number().int().positive(),
  relation: z.enum(["used", "created", "modified"]),
  contributorSlug: z.string(),
});

export const eventInputSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4000).default(""),
  objective: z.string().trim().min(1).max(4000),
  template: z.enum(["working-session", "all-hands"]).default("working-session"),
  leadSlug: z.string().min(1),
  participantSlugs: z.array(z.string().min(1)).min(1).max(20),
  startsAt: z.number().int().nonnegative(),
  schedule: automationScheduleSchema,
  /** Last permitted occurrence start (inclusive); absent/null means until paused. */
  repeatUntil: z.number().int().nonnegative().nullable().optional(),
  durationMinutes: z.number().int().min(5).max(240).nullable().default(30),
  maxReplies: z.number().int().min(2).max(40).default(12),
  state: z.enum(["active", "paused", "archived"]).default("active"),
  artifacts: z.array(eventArtifactSchema).max(30).default([]),
}).superRefine((event, context) => {
  if (!event.participantSlugs.includes(event.leadSlug)) context.addIssue({ code: "custom", path: ["leadSlug"], message: "The lead must be a participant." });
  if (new Set(event.participantSlugs).size !== event.participantSlugs.length) context.addIssue({ code: "custom", path: ["participantSlugs"], message: "Choose each coworker once." });
  if (event.maxReplies < event.participantSlugs.length + 1) context.addIssue({ code: "custom", path: ["maxReplies"], message: "Allow one contribution per participant and a lead conclusion." });
  if (event.schedule.kind === "once" && event.schedule.at !== event.startsAt) context.addIssue({ code: "custom", path: ["startsAt"], message: "The event start must match its scheduled time." });
  if (event.repeatUntil != null && (event.schedule.kind === "once" || event.repeatUntil < event.startsAt)) context.addIssue({ code: "custom", path: ["repeatUntil"], message: "A repeating event's end must be on or after its first start." });
});

export const eventOutcomeSchema = z.object({
  summary: z.string().max(6000),
  decisions: z.array(z.string().max(1200)).max(20),
  accomplishments: z.array(z.string().max(1200)).max(20),
  openQuestions: z.array(z.string().max(1200)).max(20),
  followUps: z.array(z.string().max(1200)).max(20),
});

export type EventInput = z.infer<typeof eventInputSchema>;
export type EventArtifact = z.infer<typeof eventArtifactSchema>;
export type EventOutcome = z.infer<typeof eventOutcomeSchema>;
/** Frozen prior-session context, never a new permission or a mutable outcome. */
export type EventContinuity = {
  sourceRunId: string | null;
  summary: string;
  openQuestions: string[];
  followUps: string[];
  previousRunId: string | null;
  previousStatus: string;
  note: string;
};
export type WorkplaceEvent = EventInput & {
  id: string;
  revision: number;
  groupId: string;
  nextDueAt: number | null;
  createdAt: number;
  updatedAt: number;
};
export type EventRun = {
  id: string;
  eventId: string;
  /** Accepted definition: later edits never rewrite workplace history. */
  event: WorkplaceEvent;
  scheduledFor: number;
  trigger: "scheduled" | "manual" | "recovery";
  startedAt: number | null;
  finishedAt: number | null;
  status: "queued" | "running" | "waiting" | "succeeded" | "partial" | "failed" | "cancelled";
  phase: "contributions" | "waiting" | "conclusion" | "finished";
  outcome: EventOutcome | null;
  outcomeStatus?: "provisional" | "delivered" | null;
  continuity?: EventContinuity | null;
  artifacts: EventArtifact[];
  contributorSlugs: string[];
  error: string;
};
export type EventDetail = { event: WorkplaceEvent; runs: EventRun[]; continuity?: EventContinuity | null };

export function eventRunIsLive(run: EventRun): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "waiting";
}
