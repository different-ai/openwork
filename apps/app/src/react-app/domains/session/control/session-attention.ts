import type { QuestionRequest } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";
import { unwrap } from "@/app/lib/opencode";
import { isOpencodeV2Client, nativeQuestionFingerprintContent } from "@/app/lib/opencode-v2-adapter";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { createRouteSessionClient } from "@/react-app/shell/route-workspaces";
import { questionReplyOwnerKey, questionReplyRegistry, type QuestionReplyRegistry, type QuestionReplyStatus } from "./question-reply-registry";
import { isOrphanedInteraction, terminalToolCallIds } from "../sync/orphaned-interactions";

export const sessionAttentionArgs = z.object({
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
}).strict();

export const questionReplyProposalArgs = sessionAttentionArgs.extend({
  requestId: z.string().min(1),
  fingerprint: z.string().min(1),
  answers: z.array(z.array(z.string().min(1))).min(1),
});
export const questionReplyStatusArgs = sessionAttentionArgs.extend({ reviewId: z.string().min(1) });

export type AttentionTarget = {
  workspaceId: string;
  sessionId: string;
  directory: string;
  endpoint: ResolvedWorkspaceEndpoint;
};

export async function readSessionQuestions(target: AttentionTarget, includePermissions = false) {
  const client = await createRouteSessionClient(target.endpoint, target.directory);
  const session = unwrap(await client.session.get({ sessionID: target.sessionId, directory: target.directory }));
  // Both authenticated workspace mounts verify exact ownership on session.get,
  // including server-side realpath normalization. Never compare remote paths here.
  if (session.id !== target.sessionId) {
    throw new Error("The conversation's workspace could not be verified.");
  }
  const requests = unwrap(await client.question.list({ directory: target.directory }))
    .filter(request => request.sessionID === target.sessionId);
  const [scoped, legacy] = await Promise.all([
    includePermissions ? client.v2.session.permission.list({ sessionID: target.sessionId }).catch(() => null) : null,
    includePermissions && !isOpencodeV2Client(client) ? client.permission.list({ directory: target.directory }).catch(() => null) : null,
  ]);
  // Lists can retain aborted/superseded asks. Read the owner's transcript AFTER
  // the lists so a tool that ended during those reads cannot stay actionable.
  // No cache fallback: a failed transcript read must also block a reply.
  const messages = unwrap(await client.session.messages({ sessionID: target.sessionId, directory: target.directory }));
  const terminalIds = terminalToolCallIds(messages.filter(message => message.info.sessionID === target.sessionId));
  return { client, session, scoped, legacy, terminalIds,
    requests: requests.filter(request => !isOrphanedInteraction(request.tool, terminalIds)) };
}

// SHA-256 avoids returning question text as an opaque receipt/fingerprint.
export async function questionFingerprint(request: QuestionRequest): Promise<string> {
  const content = JSON.stringify({ id: request.id, sessionID: request.sessionID,
    questions: request.questions.map(question => ({
      header: question.header, question: question.question, options: question.options,
      multiple: question.multiple === true, custom: question.custom !== false,
    })), tool: request.tool ?? null, nativeFields: nativeQuestionFingerprintContent(request) });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function validateQuestionAnswers(request: QuestionRequest, answers: string[][]) {
  if (answers.length !== request.questions.length) throw new Error("Answer every question in this request.");
  request.questions.forEach((question, index) => {
    const answer = answers[index];
    if (!answer.length || (!question.multiple && answer.length !== 1)
      || new Set(answer).size !== answer.length || answer.some(value => !value.trim())) {
      throw new Error("Answer cardinality does not match the question.");
    }
    const labels = question.options.map(option => option.label);
    if (new Set(labels).size !== labels.length) throw new Error("Ambiguous option labels cannot be answered safely.");
    if (question.custom === false && answer.some(value => !labels.includes(value))) {
      throw new Error("This question only accepts its exact option labels.");
    }
  });
}

export async function readSessionAttention(target: AttentionTarget) {
  const { client, session, requests, scoped, legacy, terminalIds } = await readSessionQuestions(target, true);
  const questionsObservedAt = Date.now();
  const questions = await Promise.all(requests.map(async request => ({
    requestId: request.id, sessionId: request.sessionID,
    fingerprint: await questionFingerprint(request),
    questions: request.questions.map(question => ({
      header: question.header, question: question.question,
      multiple: question.multiple === true, custom: question.custom !== false,
      options: question.options.map(option => ({ label: option.label, description: option.description })),
    })),
  })));
  // No metadata, command bodies, resource patterns, credentials, or reply API.
  const nativeV2 = isOpencodeV2Client(client);
  const summaries = [
    // The adapter maps only a real native tool source. Unlinked permissions
    // remain listed; matching IDs/metadata are not evidence of a tool ending.
    ...(scoped?.data?.data ?? []).filter(request => request.sessionID === target.sessionId && !isOrphanedInteraction(request.source, terminalIds))
      .map(request => ({ requestId: request.id, permission: request.action })),
    ...(legacy?.data ?? []).filter(request => request.sessionID === target.sessionId && !isOrphanedInteraction(request.tool, terminalIds))
      .map(request => ({ requestId: request.id, permission: request.permission })),
  ];
  const permissions = summaries.filter((request, index) => summaries.findIndex(other => other.requestId === request.requestId) === index);
  const permissionReadComplete = (scoped?.data !== undefined || scoped?.response?.status === 404)
    && (nativeV2 || legacy?.data !== undefined || legacy?.response?.status === 404)
    && (scoped?.data !== undefined || legacy?.data !== undefined);
  return {
    workspaceId: target.workspaceId, sessionId: target.sessionId, title: session.title,
    questions: { freshness: "fresh", observedAt: questionsObservedAt, items: questions },
    permissions: { freshness: permissionReadComplete ? "fresh" : "unknown", observedAt: permissionReadComplete ? Date.now() : null, items: permissions },
  };
}

export type QuestionReplyProposal = z.infer<typeof questionReplyProposalArgs>;
export type ReviewOrigin = { workspaceId: string; sessionId: string; title: string };
export type QuestionReplyReview = {
  reviewId: string;
  status: QuestionReplyStatus;
  proposal: QuestionReplyProposal;
  origin: ReviewOrigin;
  targetTitle?: string;
  question?: QuestionRequest;
};

/** Private review content is ephemeral; the app-lifetime registry owns outcomes. */
export function createQuestionReplyReview(input: {
  resolveTarget: (args: { workspaceId: string; sessionId: string }) => AttentionTarget;
  changed: (review: QuestionReplyReview) => void;
  settled: (target: AttentionTarget, requestId: string) => void;
  registry?: QuestionReplyRegistry;
}) {
  const registry = input.registry ?? questionReplyRegistry;
  let review: QuestionReplyReview | null = null;
  let owner: string | null = null;
  let proposing = false;
  let disposed = false;
  const change = (next: QuestionReplyReview) => { review = next; input.changed(next); };
  const load = async (pending: QuestionReplyReview) => {
    try {
      const target = input.resolveTarget(pending.proposal);
      if (questionReplyOwnerKey(target) !== owner) throw new Error("Owner changed.");
      const fresh = await readSessionQuestions(target);
      const question = fresh.requests.find(request => request.id === pending.proposal.requestId);
      if (!question || await questionFingerprint(question) !== pending.proposal.fingerprint) throw new Error("Question changed.");
      validateQuestionAnswers(question, pending.proposal.answers);
      if (review !== pending) return;
      if (!registry.ready(pending.reviewId)) return;
      change({ ...pending, status: "pending_review", question, targetTitle: fresh.session.title });
    } catch {
      if (review === pending) {
        registry.finish(pending.reviewId, "rejected");
        change({ ...pending, status: "rejected" });
      }
    }
  };
  return {
    attach() { disposed = false; },
    async propose(args: unknown, origin: ReviewOrigin) {
      const proposal = questionReplyProposalArgs.parse(args);
      if (disposed || proposing || (review && ["loading", "pending_review", "sending"].includes(review.status))) throw new Error("A question review is already open or this surface is closed.");
      proposing = true;
      try {
        const target = input.resolveTarget(proposal);
        const receipt = await registry.reserve(target, proposal, origin);
        if (disposed) { registry.cancel(receipt.reviewId); return registry.receipt(receipt.reviewId); }
        owner = questionReplyOwnerKey(target);
        const pending: QuestionReplyReview = { reviewId: receipt.reviewId, status: "loading", proposal, origin };
        change(pending);
        void load(pending);
        return receipt;
      } finally {
        proposing = false;
      }
    },
    cancel() {
      if (!review) return;
      registry.cancel(review.reviewId);
      change({ ...review, status: registry.receipt(review.reviewId).status });
      review = null;
    },
    dispose() {
      disposed = true;
      if (review) registry.cancel(review.reviewId);
      review = null;
    },
    async confirm() {
      if (!review || review.status !== "pending_review") return;
      const pending = review;
      let submitted = false;
      try {
        if (!registry.begin(pending.reviewId)) return;
        change({ ...pending, status: "sending" });
        const target = input.resolveTarget(pending.proposal);
        if (questionReplyOwnerKey(target) !== owner) throw new Error("Owner changed.");
        const fresh = await readSessionQuestions(target);
        const question = fresh.requests.find(request => request.id === pending.proposal.requestId);
        if (!question || await questionFingerprint(question) !== pending.proposal.fingerprint) throw new Error("Question changed.");
        validateQuestionAnswers(question, pending.proposal.answers);
        // Resolve again after I/O so a removed or retargeted workspace cannot send.
        if (disposed || questionReplyOwnerKey(input.resolveTarget(pending.proposal)) !== owner) throw new Error("Owner changed or review surface closed.");
        registry.submit(pending.reviewId);
        submitted = true;
        unwrap(await fresh.client.question.reply({ requestID: question.id, answers: pending.proposal.answers, directory: target.directory }));
        registry.finish(pending.reviewId, "accepted");
        change({ ...pending, status: "accepted" });
        // Cache cleanup cannot change an engine-confirmed acceptance outcome.
        try { input.settled(target, question.id); } catch { /* Native events can reconcile the cache later. */ }
      } catch {
        // A failed write can have succeeded remotely. Never automatically retry.
        const status = submitted ? "unknown" : "rejected";
        registry.finish(pending.reviewId, status);
        change({ ...pending, status });
      }
    },
  };
}
