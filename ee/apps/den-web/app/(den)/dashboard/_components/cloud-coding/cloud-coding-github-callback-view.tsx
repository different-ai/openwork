import { DenButton } from "../../../_components/ui/button";
import { DashboardPageTemplate } from "../../../_components/ui/dashboard-page-template";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { ItemPanel, ItemRow } from "../item-list";
import { GithubMark, githubCallbackError } from "./cloud-coding-ui";

export type CloudCodingGithubCallbackViewProps = {
  phase: "working" | "error";
  reason?: string | null;
  onBack: () => void;
};

export function CloudCodingGithubCallbackView({ phase, reason, onBack }: CloudCodingGithubCallbackViewProps) {
  return (
    <DashboardPageTemplate title="GitHub connection" description={null} measure>
      {phase === "working" ? (
        <div role="status" aria-label="Finishing the GitHub connection" aria-busy="true">
          <ItemPanel>
            <ItemRow compact logo={<GithubMark />} title={<DenSkeleton className="h-3 w-36 max-w-full" />} />
          </ItemPanel>
        </div>
      ) : (
        <DenNotice tone="error" message={githubCallbackError(reason ?? null)} action={
          <DenButton variant="secondary" size="sm" onClick={onBack}>Back to Cloud coding</DenButton>
        } />
      )}
    </DashboardPageTemplate>
  );
}
