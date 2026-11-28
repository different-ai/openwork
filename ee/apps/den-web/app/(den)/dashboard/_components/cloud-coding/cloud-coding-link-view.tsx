import type { CloudCodingOverview } from "@openwork/types/den/cloud-coding";
import { DenButton } from "../../../_components/ui/button";
import { DashboardPageTemplate } from "../../../_components/ui/dashboard-page-template";
import { DenNotice } from "../../../_components/ui/notice";
import { ItemPanel, ItemRow, ItemRowsSkeleton } from "../item-list";
import { CloudCodingLoadError, GithubMark, Locked } from "./cloud-coding-ui";

export type CloudCodingLinkViewProps = {
  overview?: Pick<CloudCodingOverview, "me" | "connection" | "enabled">;
  loadError?: string;
  actionError?: string;
  callbackError?: string;
  linked?: boolean;
  pending?: boolean;
  onRetry: () => void;
  onLink: () => void;
  onUnlink: () => void;
};

export function CloudCodingLinkView({ overview, loadError, actionError, callbackError, linked, pending, onRetry, onLink, onUnlink }: CloudCodingLinkViewProps) {
  const login = overview?.me.github?.login;
  const locked = !overview?.connection ? "An admin needs to connect GitHub first"
    : !overview.enabled ? "Cloud coding is turned off for your organization"
    : !overview.me.canUse ? "You're not included yet. Ask an admin to add you." : null;
  return (
    <DashboardPageTemplate title="Link your GitHub account" description={!login && !locked ? "Pull requests OpenWork opens for you will be in your name." : null} measure>
      <div className="flex flex-col gap-4">
        {linked && !callbackError ? <DenNotice tone="success" message="You can go back to your chat." /> : null}
        {callbackError ? <DenNotice tone="error" message={callbackError} /> : null}
        {actionError ? <DenNotice tone="error" message={actionError} /> : null}
        {loadError ? <CloudCodingLoadError message={loadError} onRetry={onRetry} /> : null}
        {overview ? (
          <ItemPanel className="[&_[data-item-action]]:w-auto!">
            <ItemRow compact logo={<GithubMark />} title="GitHub" wrapDescription
              description={locked ? <Locked>{locked}</Locked> : login ? `Linked as ${login}` : "Not linked"}
              action={locked ? undefined : login ? <DenButton variant="secondary" size="sm" disabled={pending} onClick={onUnlink}>Unlink</DenButton>
                : <DenButton size="sm" disabled={pending} onClick={onLink}>Link your GitHub account</DenButton>}
            />
          </ItemPanel>
        ) : !loadError ? <ItemPanel><ItemRowsSkeleton label="Loading GitHub account" rows={1} /></ItemPanel> : null}
      </div>
    </DashboardPageTemplate>
  );
}
