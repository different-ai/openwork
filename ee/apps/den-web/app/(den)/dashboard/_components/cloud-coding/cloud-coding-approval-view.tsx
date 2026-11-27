import type { CloudCodingPushApproval, CloudCodingPushDecisionInput } from "@openwork/types/den/cloud-coding";
import { DenButton } from "../../../_components/ui/button";
import { DashboardPageTemplate } from "../../../_components/ui/dashboard-page-template";
import { DenNotice } from "../../../_components/ui/notice";
import { DetailRows, ItemPanel, ItemRow, ItemRowsSkeleton } from "../item-list";
import { CloudCodingLoadError, GithubMark } from "./cloud-coding-ui";

const testLabels = { passed: "Passed", failed: "Failed", not_run: "Not run" };
const fileLabels = { added: "Added", modified: "Changed", deleted: "Removed" };
const outcomes = {
  pending: "OpenWork will push this as a new branch and open a pull request in your name. Nothing has been sent to GitHub yet.",
  approved: "Allowed. OpenWork is pushing the branch.",
  denied: "Denied. Nothing was pushed.",
  pushed: "Pull request opened",
  expired: "This request expired. Ask OpenWork to try again.",
  superseded: "OpenWork changed the code after this request. Check your chat for the new one.",
};
const unavailableCopy = "This request isn't available. It may belong to another account.";

export type CloudCodingApprovalViewProps = {
  approval?: CloudCodingPushApproval;
  unavailable?: boolean;
  loadError?: string;
  decisionError?: string;
  decisionPending?: boolean;
  onRetry: () => void;
  onDecision: (decision: CloudCodingPushDecisionInput["decision"]) => void;
};

export function CloudCodingApprovalView({ approval, unavailable, loadError, decisionError, decisionPending, onRetry, onDecision }: CloudCodingApprovalViewProps) {
  const visible = unavailable ? undefined : approval;
  const status = visible?.pullRequest ? "pushed" : visible?.status;
  const pending = status === "pending";
  const title = pending && visible ? `Push to ${visible.repositoryFullName}?` : "Push request";
  const remainingFiles = visible ? visible.fileCount - visible.files.length : 0;
  const pull = visible?.pullRequest;
  return (
    <DashboardPageTemplate title={title} measure
      description={status ? <span role={pending ? undefined : "status"}>{outcomes[status]}{pull && visible ? <>{": "}<a href={pull.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{visible.repositoryFullName} #{pull.number}</a></> : null}</span> : null}
    >
      <div className="flex flex-col gap-4">
        {unavailable ? <DenNotice tone="neutral" message={unavailableCopy} /> : null}
        {!unavailable && loadError ? <CloudCodingLoadError message={loadError} onRetry={onRetry} /> : null}
        {decisionError && !unavailable ? <DenNotice tone="error" message={decisionError} /> : null}
        {visible ? (
          <>
            <DetailRows rows={[
              { label: "Repository", value: <span className="inline-flex items-center gap-1.5"><GithubMark inline />{visible.repositoryFullName}</span> },
              { label: "New branch", value: <code className="break-all">{visible.branch}</code> },
              { label: "From", value: <code>{visible.baseBranch}</code> },
              { label: "Commit", value: <code>{visible.headSha.slice(0, 7)}</code> },
              { label: "Tests", wrap: true, value: <span className="flex flex-col gap-1">
                <span className={visible.tests.status === "failed" ? "text-[var(--ow-danger)]" : undefined}>{testLabels[visible.tests.status]}</span>
                {visible.tests.command ? <code className="whitespace-pre-wrap break-all">{visible.tests.command}</code> : null}
                {visible.tests.summary ? <span>{visible.tests.summary}</span> : null}
              </span> },
              { label: "Files changed", value: `${visible.fileCount} ${visible.fileCount === 1 ? "file" : "files"}` },
            ]} />
            {visible.files.length > 0 || remainingFiles > 0 ? (
              <ItemPanel>
                {visible.files.map((file) => <ItemRow compact key={file.path} title={<code className="whitespace-normal break-all">{file.path}</code>} status={fileLabels[file.change]} />)}
                {remainingFiles > 0 ? <ItemRow compact title={<span className="text-[var(--dls-text-secondary)]">and {remainingFiles} more</span>} /> : null}
              </ItemPanel>
            ) : null}
            {pending ? <div className="flex justify-end gap-2">
              <DenButton variant="secondary" size="sm" disabled={decisionPending || !!loadError} onClick={() => onDecision("deny")}>Deny</DenButton>
              <DenButton size="sm" disabled={decisionPending || !!loadError} onClick={() => onDecision("allow_once")}>Allow once</DenButton>
            </div> : null}
          </>
        ) : !unavailable && !loadError ? <ItemPanel><ItemRowsSkeleton label="Loading push request" rows={6} /></ItemPanel> : null}
      </div>
    </DashboardPageTemplate>
  );
}
