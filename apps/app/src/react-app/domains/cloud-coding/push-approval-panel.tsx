import { ChevronRight, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { CloudCodingPushApproval, CloudCodingPushDecisionInput } from "@openwork/types/den/cloud-coding";

import { ServiceMark, GITHUB_SERVICE_MARK } from "@/components/chat/service-mark";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ComposerApprovalActions, ComposerApprovalHeader, ComposerApprovalPanel } from "@/react-app/design-system/composer-approval-panel";

type Choice = CloudCodingPushDecisionInput["decision"];
const testLabels = { passed: "cloud_coding.tests_passed", failed: "cloud_coding.tests_failed", not_run: "cloud_coding.tests_not_run" } as const;
const changeLabels = { added: "cloud_coding.added", modified: "cloud_coding.changed", deleted: "cloud_coding.removed" } as const;

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return <details className="group border-t border-dls-border">
    <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 py-2 text-xs font-medium text-dls-text [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-4 text-dls-secondary transition-transform duration-150 ease-out group-open:rotate-90 motion-reduce:transition-none" strokeWidth={1.5} />
      {label}
    </summary>
    <div className="max-h-32 overflow-auto pb-2">{children}</div>
  </details>;
}

export type PushApprovalPanelProps = {
  approval: CloudCodingPushApproval;
  phase: "pending" | "pushing" | "opened" | "denied" | "unfinished";
  count?: number;
  busy?: boolean;
  retryDecision?: Choice;
  decide: (choice: Choice) => void;
  dismiss: () => void;
  onOpenPullRequest: (url: string) => Promise<unknown>;
};

export function PushApprovalPanel({ approval, phase, count = 1, busy, retryDecision, decide, dismiss, onOpenPullRequest }: PushApprovalPanelProps) {
  const [openFailed, setOpenFailed] = useState(false);
  const { repositoryFullName: repository, branch, files, fileCount, tests, pullRequest } = approval;
  const title = t("cloud_coding.title", { repository });
  const line = phase === "denied" ? t("cloud_coding.denied")
    : phase === "opened" && pullRequest ? t("cloud_coding.opened", { repository, number: pullRequest.number })
    : t("cloud_coding.unfinished");
  const final = phase !== "pending" && phase !== "pushing";
  return <ComposerApprovalPanel data-cloud-coding-approval={phase} data-composer-interaction="cloud-coding-approval" aria-label={title} role="region">
    {final ? <div className="flex min-h-10 flex-wrap items-center gap-x-2 px-4 py-1 text-sm text-dls-secondary">
      <span className="min-w-0 flex-1 wrap-anywhere" role="status">{line}</span>
      {phase === "opened" && pullRequest && <Button type="button" size="sm" variant="link" onClick={() => {
        setOpenFailed(false);
        void onOpenPullRequest(pullRequest.url).catch(() => setOpenFailed(true));
      }}>{t("cloud_coding.open_pull_request")}</Button>}
      <Button type="button" variant="ghost" size="icon-sm" aria-label={t("cloud_coding.dismiss")} onClick={dismiss}>
        <X aria-hidden="true" strokeWidth={1.5} />
      </Button>
      {openFailed && <p className="w-full text-xs" role="status">{t("cloud_coding.open_failed")}</p>}
    </div> : <>
      <ComposerApprovalHeader title={title} icon={<ServiceMark name="GitHub" iconUrl={GITHUB_SERVICE_MARK} />} actions={phase === "pending"
        ? <ComposerApprovalActions disabled={busy} onDeny={() => decide("deny")} onAllowOnce={() => decide("allow_once")} /> : null}>
        {phase === "pushing" ? <span role="status" className="animate-text-shimmer motion-reduce:animate-none">
          {t("cloud_coding.pushing", { branch })}
        </span> : <>
          <div className="wrap-anywhere">
            {t("cloud_coding.new_branch")} <code className="font-mono">{branch}</code>{" · "}
            {t(fileCount === 1 ? "cloud_coding.one_file" : "cloud_coding.files_count", { count: fileCount })}{" · "}
            <span className={tests.status === "failed" ? "text-destructive" : undefined}>{t(testLabels[tests.status])}</span>
          </div>
          <div>{t("cloud_coding.consent")}</div>
          {count > 1 && <div>{t("cloud_coding.queue", { count })}</div>}
        </>}
      </ComposerApprovalHeader>
      {phase === "pending" && <div className="px-4 text-xs text-dls-secondary">
        <Disclosure label={t("cloud_coding.files_changed")}>
          <ul className="space-y-1">
            {files.map(({ path, change }) => <li key={path} className="flex justify-between gap-3">
              <code className="min-w-0 font-mono wrap-anywhere text-dls-text">{path}</code>
              <span className="shrink-0">{t(changeLabels[change])}</span>
            </li>)}
            {fileCount > files.length && <li>{t("cloud_coding.more", { count: fileCount - files.length })}</li>}
          </ul>
        </Disclosure>
        {(tests.command || tests.summary) && <Disclosure label={t("cloud_coding.test_result")}>
          {tests.command && <pre className="font-mono whitespace-pre-wrap wrap-anywhere text-dls-text">{tests.command}</pre>}
          {tests.summary && <p className="whitespace-pre-wrap wrap-anywhere">{tests.summary}</p>}
        </Disclosure>}
        {retryDecision && <div className="flex items-center gap-2 border-t border-dls-border py-1">
          <p role="status">{t("cloud_coding.decision_failed")}</p>
          <Button type="button" size="xs" variant="ghost" onClick={() => decide(retryDecision)}>{t("tool_approvals.retry")}</Button>
        </div>}
      </div>}
    </>}
  </ComposerApprovalPanel>;
}
