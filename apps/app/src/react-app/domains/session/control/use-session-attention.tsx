import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { OpenworkAffordanceOrigin } from "@openwork/types/openwork-affordance";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { workspaceServerId } from "@/app/lib/workspace-endpoint";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useControlAction } from "@/react-app/shell/control/control-provider";
import type { RouteWorkspace } from "@/react-app/shell/route-workspaces";
import { controlWorkspaceLabel, type ControlSessionLike } from "./list-control-sessions";
import { createQuestionReplyReview, readSessionAttention, sessionAttentionArgs, questionReplyStatusArgs, type QuestionReplyReview } from "./session-attention";
import { questionReplyRegistry } from "./question-reply-registry";
import { resolveSessionAttentionTarget, sessionAttentionCacheIds, settleSessionAttentionQuestion, useSessionAttentionOwners } from "./session-attention-owners";

export function useSessionAttention(input: {
  workspaces: RouteWorkspace[];
  sessionsByWorkspaceId: Record<string, ControlSessionLike[]>;
  endpointForWorkspace: (workspace: RouteWorkspace) => ResolvedWorkspaceEndpoint | null;
}) {
  const current = useRef(input);
  current.current = input;
  const mounted = useRef(true);
  const [review, setReview] = useState<QuestionReplyReview | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const cacheIds = useMemo(() => sessionAttentionCacheIds(input), [input.workspaces, input.endpointForWorkspace]);
  useLayoutEffect(() => {
    useSessionAttentionOwners.setState({ cacheIds });
    return () => { useSessionAttentionOwners.setState({ cacheIds: {} }); };
  }, [cacheIds]);
  useEffect(() => {
    mounted.current = true;
    controller.attach();
    return () => { mounted.current = false; controller.dispose(); };
  }, []);

  function resolveTarget(args: { workspaceId: string; sessionId: string }) {
    if (!mounted.current) throw new Error("The session surface is closed.");
    return resolveSessionAttentionTarget(current.current, args);
  }

  function resolveOrigin(origin: OpenworkAffordanceOrigin | undefined) {
    if (!origin) throw new Error("A server-stamped requesting conversation is required.");
    const owners = current.current.workspaces.filter(workspace =>
      (!origin.workspaceId || origin.workspaceId === workspace.id || origin.workspaceId === workspaceServerId(workspace))
      && current.current.sessionsByWorkspaceId[workspace.id]?.some(session => session.id === origin.sessionId));
    if (owners.length !== 1) throw new Error("The requesting conversation's owner could not be verified.");
    const workspace = owners[0];
    resolveTarget({ workspaceId: workspace.id, sessionId: origin.sessionId });
    const session = current.current.sessionsByWorkspaceId[workspace.id].find(session => session.id === origin.sessionId);
    return { workspaceId: workspace.id, sessionId: origin.sessionId, title: session?.title || origin.sessionId };
  }

  const [controller] = useState(() => createQuestionReplyReview({
    resolveTarget,
    changed: next => {
      if (!mounted.current) return;
      setReview(next);
      if (next.status === "loading") setReviewOpen(true);
    },
    settled: (target, requestId) => {
      if (mounted.current) settleSessionAttentionQuestion(current.current, target, requestId);
    },
  }));

  useControlAction({
    id: "session.attention", label: "Read pending session interactions",
    description: "Fresh navigation-free read for one exact workspaceId and sessionId. Returns that owner's question IDs, content, options and fingerprints, plus permission summaries without command bodies or metadata. Does not answer questions or grant permissions.",
    kind: "query", effects: { data: "read", ui: "none", external: false }, sideEffect: "none",
    args: [
      { name: "workspaceId", type: "string", required: true, description: "Exact workspaceId from session.list_sessions." },
      { name: "sessionId", type: "string", required: true, description: "Exact owner sessionId, not its parent." },
    ],
    execute: args => readSessionAttention(resolveTarget(sessionAttentionArgs.parse(args))),
  });

  useControlAction({
    id: "session.question.reply.status", label: "Read question reply receipt",
    description: "Read one exact reviewId and owner workspaceId/sessionId without navigation or writes. Reports server-stamped origin, target, status and reply acceptance from the receipt, never from question disappearance. Redacted receipts survive reload within this window's session; private review content does not. A missing receipt is not success.",
    kind: "query", effects: { data: "read", ui: "none", external: false }, sideEffect: "none",
    args: [
      { name: "reviewId", type: "string", required: true, description: "Exact reviewId returned by session.question.reply.propose." },
      { name: "workspaceId", type: "string", required: true, description: "Exact target workspaceId from the receipt." },
      { name: "sessionId", type: "string", required: true, description: "Exact target sessionId from the receipt." },
    ],
    execute: args => {
      const parsed = questionReplyStatusArgs.parse(args);
      return questionReplyRegistry.status(parsed, resolveTarget(parsed));
    },
  });

  useControlAction({
    id: "session.question.reply.propose", label: "Review a proposed question answer",
    description: "Stage human review without navigating or sending. Returns a loading receipt promptly; use session.question.reply.status to verify acceptance. Only the person's review button sends and may resume the target agent. Permission gates remain independent. Read session.attention first. Redacted attempt receipts survive route changes and reload within this window's session; private review content does not. Sending fails closed if storage is unavailable. Never retry an uncertain reply.",
    effects: { data: "read", ui: "dialog", external: false }, sideEffect: "none", requiresArgs: true,
    args: [
      { name: "workspaceId", type: "string", required: true, description: "Exact target workspaceId." },
      { name: "sessionId", type: "string", required: true, description: "Exact question owner sessionId." },
      { name: "requestId", type: "string", required: true, description: "Question requestId from session.attention, never a permission or generic form ID." },
      { name: "fingerprint", type: "string", required: true, description: "Unchanged question fingerprint from session.attention." },
      { name: "answers", type: "array", required: true, description: "One array per question, containing exact option labels or allowed custom text. Never a confirmed boolean." },
    ],
    execute: (args, helpers) => controller.propose(args, resolveOrigin(helpers.origin)),
  });

  const busy = review?.status === "sending";
  const targetWorkspace = review && input.workspaces.find(workspace => workspace.id === review.proposal.workspaceId);
  const originWorkspace = review && input.workspaces.find(workspace => workspace.id === review.origin.workspaceId);
  const message = review?.status === "loading" ? t("session_review.loading")
    : review?.status === "sending" ? t("session_review.sending")
    : review?.status === "accepted" ? t("session_review.sent")
    : review?.status === "unknown" ? t("session_review.unknown")
    : review?.status === "rejected" ? t("session_review.rejected") : null;
  return (
    <Dialog open={reviewOpen} onOpenChange={open => { if (!open && !busy) { controller.cancel(); setReviewOpen(false); } }}>
      <DialogContent showCloseButton={!busy} className="max-h-[90dvh] overflow-y-auto lg:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("session_review.title")}</DialogTitle>
          <DialogDescription>{t("session_review.effects")}</DialogDescription>
        </DialogHeader>
        {review ? <div className="flex flex-col gap-4 break-words whitespace-pre-wrap">
          <p>{t("session_review.origin", { title: review.origin.title, workspace: originWorkspace ? controlWorkspaceLabel(originWorkspace) : review.origin.workspaceId })}<br />
            <span className="text-xs text-muted-foreground">{review.origin.workspaceId} / {review.origin.sessionId}</span></p>
          <p>{t("session_review.target", { title: review.targetTitle ?? review.proposal.sessionId, workspace: targetWorkspace ? controlWorkspaceLabel(targetWorkspace) : review.proposal.workspaceId })}<br />
            <span className="text-xs text-muted-foreground">{review.proposal.workspaceId} / {review.proposal.sessionId} / {review.proposal.requestId}</span></p>
          {review.question?.questions.map((question, index) => <section key={index} className="flex flex-col gap-2 rounded-xl border p-3">
            <h3 className="font-medium">{question.header}</h3>
            <p>{question.question}</p>
            <ul className="text-sm text-muted-foreground">{question.options.map(option => <li key={option.label}>{option.label}: {option.description}</li>)}</ul>
            <p className="font-medium">{t("session_review.answers", { answers: review.proposal.answers[index].join("; ") })}</p>
          </section>)}
        </div> : null}
        {message ? <Alert variant={review?.status === "unknown" || review?.status === "rejected" ? "destructive" : "default"}><AlertDescription>{message}</AlertDescription></Alert> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { controller.cancel(); setReviewOpen(false); }}>{t("session_review.close")}</Button>
          {review?.status === "pending_review" ? <Button onClick={() => { void controller.confirm(); }}>{t("session_review.send")}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
