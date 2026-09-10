import { z } from "zod";
import type { AttentionTarget, QuestionReplyProposal, ReviewOrigin } from "./session-attention";

export const QUESTION_REPLY_RECEIPTS_KEY = "openwork.question-reply-receipts.v1";
export const MAX_QUESTION_REPLY_RECEIPTS = 128;
const identity = z.object({ workspaceId: z.string(), sessionId: z.string() }).strict();
const receiptSchema = z.object({
  reviewId: z.string(),
  target: identity.extend({ ownerId: z.string(), runtimeWorkspaceId: z.string() }).strict(),
  origin: identity,
  requestId: z.string(), fingerprint: z.string(),
  status: z.enum(["loading", "pending_review", "sending", "accepted", "cancelled", "rejected", "unknown"]),
  attempted: z.boolean(), createdAt: z.number(), updatedAt: z.number(),
}).strict();
const storedSchema = z.object({ version: z.literal(1), receipts: z.array(receiptSchema).max(MAX_QUESTION_REPLY_RECEIPTS) }).strict();
export type QuestionReplyReceipt = z.infer<typeof receiptSchema>;
export type QuestionReplyStatus = QuestionReplyReceipt["status"];
export type QuestionReplyReceiptStorage = Pick<Storage, "getItem" | "setItem">;

export function questionReplyOwnerKey(target: Pick<AttentionTarget, "endpoint">) {
  // Directory spellings are not identity. The authenticated server mount owns it.
  const url = new URL(target.endpoint.baseUrl);
  return JSON.stringify([url.origin, url.pathname.replace(/\/+$/, ""), target.endpoint.workspaceId]);
}

async function ownerId(target: AttentionTarget) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(questionReplyOwnerKey(target)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** One registry per renderer lifetime. Only redacted receipts cross reloads.
 * Submitted receipts are never evicted: when the bound is reached, fail closed.
 * sessionStorage deliberately scopes this guarantee to this browser/app session.
 */
export function createQuestionReplyRegistry(storage: () => QuestionReplyReceiptStorage) {
  const receipts = new Map<string, QuestionReplyReceipt>();
  let initialized = false;
  let healthy = true;
  let saved: string | null = null;
  function persist() {
    if (!healthy) return false;
    try {
      const store = storage();
      if (store.getItem(QUESTION_REPLY_RECEIPTS_KEY) !== saved) throw new Error("Receipt storage changed outside this registry.");
      const next = JSON.stringify({ version: 1, receipts: [...receipts.values()] });
      store.setItem(QUESTION_REPLY_RECEIPTS_KEY, next);
      if (store.getItem(QUESTION_REPLY_RECEIPTS_KEY) !== next) throw new Error("Receipt storage did not retain the write.");
      saved = next;
      return true;
    } catch {
      healthy = false;
      return false;
    }
  }
  function initialize() {
    if (initialized) return;
    initialized = true;
    try {
      saved = storage().getItem(QUESTION_REPLY_RECEIPTS_KEY);
      if (saved !== null) {
        for (const receipt of storedSchema.parse(JSON.parse(saved)).receipts) {
          if (receipts.has(receipt.reviewId)) throw new Error("Duplicate receipt.");
          // A reload cannot prove whether an in-flight POST reached the engine.
          if (["accepted", "unknown", "sending"].includes(receipt.status)) receipt.attempted = true;
          if (receipt.status === "sending") receipt.status = "unknown";
          if (receipt.status === "loading" || receipt.status === "pending_review") receipt.status = "cancelled";
          receipts.set(receipt.reviewId, receipt);
        }
      }
    } catch {
      healthy = false;
    }
  }
  function requireStorage() {
    initialize();
    if (!healthy) throw new Error("Question replies are blocked because durable receipt storage is unavailable or changed. No reply was sent.");
  }
  function get(reviewId: string) {
    initialize();
    const receipt = receipts.get(reviewId);
    if (!receipt) throw new Error("Review receipt is unavailable; do not infer a reply outcome.");
    return receipt;
  }
  function update(reviewId: string, status: QuestionReplyStatus, attempted = get(reviewId).attempted) {
    const next = { ...get(reviewId), status, attempted, updatedAt: Date.now() };
    receipts.set(reviewId, next);
    persist();
    return next;
  }
  function publicReceipt(receipt: QuestionReplyReceipt) {
    return {
      reviewId: receipt.reviewId, target: { ...receipt.target }, origin: { ...receipt.origin },
      requestId: receipt.requestId, fingerprint: receipt.fingerprint, status: receipt.status,
      sent: receipt.status === "accepted" ? true : receipt.status === "unknown" || receipt.status === "sending" ? null : false,
      acceptance: receipt.status === "accepted" ? "accepted" : receipt.status === "unknown" || receipt.status === "sending" ? "unknown" : "not_sent",
      durability: healthy ? "session" : "memory", createdAt: receipt.createdAt, updatedAt: receipt.updatedAt,
    };
  }
  return {
    async reserve(target: AttentionTarget, proposal: QuestionReplyProposal, origin: ReviewOrigin) {
      requireStorage();
      if (target.workspaceId !== proposal.workspaceId || target.sessionId !== proposal.sessionId) throw new Error("Question proposal owner mismatch.");
      const owner = await ownerId(target);
      requireStorage();
      if ([...receipts.values()].some(receipt => receipt.target.ownerId === owner && receipt.target.sessionId === target.sessionId
        && receipt.requestId === proposal.requestId && (receipt.attempted || ["loading", "pending_review", "sending"].includes(receipt.status)))) {
        throw new Error("This owner's question already has a review or submission receipt. Inspect its status; do not retry.");
      }
      if (receipts.size >= MAX_QUESTION_REPLY_RECEIPTS) {
        const expired = [...receipts.values()].find(receipt => !receipt.attempted && ["cancelled", "rejected"].includes(receipt.status));
        if (!expired) throw new Error("Question reply receipt capacity reached. Sending is blocked rather than forgetting prior attempts.");
        receipts.delete(expired.reviewId);
      }
      const receipt: QuestionReplyReceipt = {
        reviewId: crypto.randomUUID(), target: { workspaceId: proposal.workspaceId, sessionId: target.sessionId, runtimeWorkspaceId: target.endpoint.workspaceId, ownerId: owner },
        origin: { workspaceId: origin.workspaceId, sessionId: origin.sessionId }, requestId: proposal.requestId,
        fingerprint: proposal.fingerprint, status: "loading", attempted: false, createdAt: Date.now(), updatedAt: Date.now(),
      };
      receipts.set(receipt.reviewId, receipt);
      if (!persist()) throw new Error("Question review could not persist its receipt. Sending is blocked.");
      return publicReceipt(receipt);
    },
    ready(reviewId: string) {
      if (get(reviewId).status !== "loading") return false;
      update(reviewId, "pending_review");
      return true;
    },
    begin(reviewId: string) {
      requireStorage();
      if (get(reviewId).status !== "pending_review") return false;
      update(reviewId, "sending");
      requireStorage();
      return true;
    },
    submit(reviewId: string) {
      requireStorage();
      const receipt = get(reviewId);
      if (receipt.status !== "sending" || receipt.attempted) throw new Error("Reply already attempted or no longer under review.");
      update(reviewId, "sending", true);
      // This must succeed BEFORE the POST. Failed persistence never authorizes it.
      requireStorage();
    },
    finish(reviewId: string, status: "accepted" | "unknown" | "rejected") {
      const receipt = get(reviewId);
      if (["accepted", "unknown", "cancelled"].includes(receipt.status)) return;
      update(reviewId, status, status !== "rejected" || receipt.attempted);
    },
    cancel(reviewId: string) {
      if (["loading", "pending_review"].includes(get(reviewId).status)) update(reviewId, "cancelled");
    },
    receipt(reviewId: string) { return publicReceipt(get(reviewId)); },
    async status(args: { reviewId: string; workspaceId: string; sessionId: string }, target: AttentionTarget) {
      const receipt = get(args.reviewId);
      if (target.workspaceId !== args.workspaceId || target.sessionId !== args.sessionId
        || receipt.target.workspaceId !== args.workspaceId || receipt.target.sessionId !== args.sessionId
        || receipt.target.ownerId !== await ownerId(target)) throw new Error("Review receipt does not belong to this exact owner.");
      return publicReceipt(get(args.reviewId));
    },
  };
}

export type QuestionReplyRegistry = ReturnType<typeof createQuestionReplyRegistry>;
export const questionReplyRegistry = createQuestionReplyRegistry(() => window.sessionStorage);
