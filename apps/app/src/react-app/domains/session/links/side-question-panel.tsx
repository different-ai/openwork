/** @jsxImportSource react */
import { Check, Copy, RotateCcw, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { createClientV2 } from "@/app/lib/opencode-v2-adapter";
import { markFeatureUsed } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

import { MarkdownBlock } from "../surface/markdown";
import type { SideQuestion } from "./side-question";
import { useSideQuestionStore, useSideQuestions, type SideQuestionClient } from "./side-question-store";

export type SideQuestionEndpoint = { opencodeBaseUrl: string; workspaceRoot: string; openworkToken: string };

function failureText(item: Extract<SideQuestion, { status: "failed" }>) {
  if (item.failure === "empty") return t("side_question.error_empty");
  if (item.failure === "timeout") return t("side_question.error_timeout");
  return t("side_question.error");
}

function Answer({ client, sessionId, item }: { client: SideQuestionClient; sessionId: string; item: SideQuestion }) {
  const [copied, setCopied] = useState(false);
  const retry = useSideQuestionStore((state) => state.retry);
  const remove = useSideQuestionStore((state) => state.remove);
  return (
    <li className="group flex flex-col gap-2" data-side-question={item.status}>
      <div className="flex items-start gap-2">
        <p className="min-w-0 flex-1 whitespace-pre-wrap rounded-xl bg-muted px-3 py-2 text-sm">{item.question}</p>
        <Button variant="ghost" size="icon-xs" className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100" aria-label={t("side_question.remove")} title={t("side_question.remove")} onClick={() => remove(sessionId, item.id)}>
          <X />
        </Button>
      </div>
      {item.status === "asking" ? (
        <p role="status" className="px-1 text-xs text-muted-foreground">{t("side_question.answering")}</p>
      ) : item.status === "answered" ? (
        <div className="px-1 text-sm">
          <MarkdownBlock text={item.answer} />
          <Button variant="ghost" size="xs" className="mt-1 text-muted-foreground" onClick={() => {
            void navigator.clipboard.writeText(item.answer).then(() => setCopied(true), () => undefined);
          }}>
            {copied ? <Check /> : <Copy />}{t("side_question.copy")}
          </Button>
        </div>
      ) : (
        <div role="alert" className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
          <span>{failureText(item)}</span>
          <Button variant="outline" size="xs" onClick={() => retry(client, sessionId, item.id)}><RotateCcw />{t("side_question.retry")}</Button>
        </div>
      )}
    </li>
  );
}

export function SideQuestionPanel({ sessionId, endpoint, onClose }: { sessionId: string; endpoint: SideQuestionEndpoint; onClose: () => void }) {
  const client = useMemo(
    () => createClientV2(endpoint.opencodeBaseUrl, endpoint.workspaceRoot, { token: endpoint.openworkToken }),
    [endpoint.opencodeBaseUrl, endpoint.openworkToken, endpoint.workspaceRoot],
  );
  const questions = useSideQuestions(sessionId);
  const draft = useSideQuestionStore((state) => state.draftBySession[sessionId] ?? "");
  const setDraft = useSideQuestionStore((state) => state.setDraft);
  const ask = useSideQuestionStore((state) => state.ask);
  const listEndRef = useRef<HTMLDivElement>(null);

  const submit = () => {
    const question = draft.trim();
    if (!question) return;
    markFeatureUsed("sideQuestions");
    ask(client, sessionId, question);
    setDraft(sessionId, "");
    requestAnimationFrame(() => listEndRef.current?.scrollIntoView?.({ block: "end" }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="side-question-panel">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-3">
        <span className="min-w-0 flex-1 truncate text-xs">{t("session_management.split_view")}</span>
        <Button variant="ghost" size="icon-xs" aria-label={t("session_management.close_split_view")} title={t("session_management.close_split_view")} onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {questions.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">{t("side_question.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-5">
            {questions.map((item) => <Answer key={item.id} client={client} sessionId={sessionId} item={item} />)}
          </ul>
        )}
        <div ref={listEndRef} />
      </div>
      <form className="shrink-0 border-t border-border p-3" onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <textarea
          autoFocus
          value={draft}
          rows={3}
          aria-label={t("side_question.placeholder")}
          placeholder={t("side_question.placeholder")}
          className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => setDraft(sessionId, event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            submit();
          }}
        />
        <div className="mt-2 flex items-center gap-2">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">{t("side_question.note")}</p>
          <Button type="submit" size="sm" disabled={!draft.trim()}>{t("side_question.ask")}</Button>
        </div>
      </form>
    </div>
  );
}
