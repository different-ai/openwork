import { ChevronDown, X } from "lucide-react";
import type { CloudCodingPushDecisionInput } from "@openwork/types/den/cloud-coding";
import { AppMark } from "./files";
import type { PushApprovalEntry } from "./cloud-coding-approvals";

const tests = { passed: "Tests passed", failed: "Tests failed", not_run: "Tests not run" };
const changes = { added: "Added", modified: "Changed", deleted: "Removed" };
const action = "rounded-full px-3.5 py-1.5 text-[13px] font-medium focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)] disabled:opacity-60";
const link = "text-[13px] font-medium underline underline-offset-2";

export type CloudCodingApprovalCardProps = {
  entry: PushApprovalEntry;
  icons: readonly string[];
  onDecide(decision: CloudCodingPushDecisionInput["decision"]): void;
  onRetry(): void;
  onDismiss(): void;
};

export function CloudCodingApprovalCard({ entry, icons, onDecide, onRetry, onDismiss }: CloudCodingApprovalCardProps) {
  const { approval, elsewhere, error, busy, retry } = entry;
  const { repositoryFullName, branch, fileCount, files, pullRequest, status } = approval;
  const pending = status === "pending";
  const pushing = !pullRequest && (status === "approved" || status === "pushed");
  const remaining = fileCount - files.length;
  return <section aria-label={`Push approval for ${repositoryFullName}`} className="mb-2 space-y-2 rounded-2xl border border-[var(--wb-ring)] bg-[var(--wb-surface)] p-3.5 text-[var(--wb-text)] shadow-[var(--wb-composer-shadow)]">
    <div className="flex items-start gap-2">
      <AppMark name="GitHub" size={18} iconCandidates={icons} />
      <div className="min-w-0 flex-1 break-words text-[14px] font-semibold" role={pending ? undefined : "status"}>
        {pending ? <h2>Push to {repositoryFullName}?</h2> : pullRequest ? `Pull request opened · ${repositoryFullName} #${pullRequest.number}`
          : pushing ? <>{elsewhere ? "Allowed elsewhere." : "Allowed."} Pushing <code className="font-mono">{branch}</code>…</>
          : status === "denied" ? `${elsewhere ? "Denied elsewhere." : "Denied."} Nothing was pushed.`
          : status === "expired" ? "Approval expired. Nothing was pushed." : "This approval was replaced. Nothing was pushed."}
      </div>
      {!pending && !pushing && <button type="button" aria-label="Dismiss push approval" className="rounded-full p-1 text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]" onClick={onDismiss}><X size={16} aria-hidden /></button>}
    </div>
    {pending && <>
      <p className="break-words text-[13px] text-[var(--wb-muted)]">New branch <code className="font-mono">{branch}</code> · {fileCount} {fileCount === 1 ? "file" : "files"} changed · <span className={approval.tests.status === "failed" ? "text-[var(--wb-danger)]" : undefined}>{tests[approval.tests.status]}</span></p>
      <p className="text-[13px] text-[var(--wb-muted)]">OpenWork will open a pull request in your name. Nothing has been sent to GitHub yet.</p>
      <details className="group text-[13px]">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded font-medium focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"><ChevronDown size={14} aria-hidden className="-rotate-90 group-open:rotate-0" />Files changed</summary>
        <ul className="mt-1 max-h-28 space-y-1 overflow-auto pl-5 text-[var(--wb-muted)]">
          {files.map(file => <li key={file.path} className="break-words"><code className="font-mono">{file.path}</code> · {changes[file.change]}</li>)}
          {remaining > 0 && <li>and {remaining} more</li>}
        </ul>
      </details>
      <div className="flex justify-end gap-2">
        <button type="button" className={`${action} bg-[var(--wb-chip)]`} disabled={busy || retry === "read"} onClick={() => onDecide("deny")}>Deny</button>
        <button type="button" className={`${action} bg-[var(--wb-text)] text-[var(--wb-surface)]`} disabled={busy || retry === "read"} onClick={() => onDecide("allow_once")}>Allow once</button>
      </div>
    </>}
    {pullRequest && <a className={link} href={pullRequest.url} target="_blank" rel="noreferrer">Open pull request</a>}
    {error && <p role="alert" className="text-[13px] text-[var(--wb-danger)]">{error} <button type="button" className={link} onClick={onRetry}>Retry</button></p>}
  </section>;
}
