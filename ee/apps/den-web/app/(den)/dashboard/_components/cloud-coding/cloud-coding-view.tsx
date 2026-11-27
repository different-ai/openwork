import type { CloudCodingOverview } from "@openwork/types/den/cloud-coding";
import { GitPullRequest } from "lucide-react";
import type { ReactNode } from "react";
import { DashboardPageTemplate } from "../../../_components/ui/dashboard-page-template";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSectionHeader } from "../../../_components/ui/section-header";
import { DenSwitch } from "../../../_components/ui/switch";
import { DenTable } from "../../../_components/ui/table";
import { ROW_NAME_CLASS, ROW_SECOND_LINE_CLASS } from "../../_features/computers/computer-rows";
import { AccessRow, Avatar } from "../access-rows";
import { ItemPanel, ItemRow, ItemRowsSkeleton } from "../item-list";
import { RelativeTime } from "../permissions-ui";
import { CloudCodingLoadError, GithubMark, Locked } from "./cloud-coding-ui";

const introduction = "Let people fix code and open pull requests from Workbot, Slack and OpenWork Web, as themselves.";
const steps = [
  "You connect GitHub and choose which repositories OpenWork can use.",
  "The first time someone asks for a code change, they link their own GitHub account from the chat.",
  "OpenWork does the work on the cloud computer that chat already has, then waits for that person to approve the push.",
  "The pull request opens in their name.",
];
const pullStates = { open: "Open", merged: "Merged", closed: "Closed" };
const valueClass = "text-[13px] text-[var(--dls-text-primary)]";
const mutedClass = "text-[13px] text-[var(--dls-text-secondary)]";

export function pullCount(count: number) {
  return count === 0 ? "No pull requests from OpenWork yet" : `${count} ${count === 1 ? "pull request" : "pull requests"} from OpenWork`;
}

function audienceParts({ memberIds, teamIds }: CloudCodingOverview["access"]) {
  return [
    memberIds.length && `${memberIds.length} ${memberIds.length === 1 ? "person" : "people"}`,
    teamIds.length && `${teamIds.length} ${teamIds.length === 1 ? "team" : "teams"}`,
  ].filter(Boolean);
}

function descriptionFor(overview: CloudCodingOverview | undefined) {
  if (!overview?.connection) return introduction;
  if (!overview.enabled) return "Off for everyone";
  const count = overview.repositories.length;
  const audience = overview.access.orgWide ? "everyone" : audienceParts(overview.access).join(" and ") || "no one";
  return `On for ${audience}, ${count} ${count === 1 ? "repository" : "repositories"}`;
}

function Cell({ title, detail }: { title: ReactNode; detail: string }) {
  return <span className="flex min-w-0 flex-col"><span className={ROW_NAME_CLASS}>{title}</span><span className={ROW_SECOND_LINE_CLASS}>{detail}</span></span>;
}

type InstallationChoices = {
  accounts?: readonly { installationId: number; accountLogin: string }[];
  error?: string;
  pending?: boolean;
  onRetry: () => void;
  onConnect: (installationId: number) => void;
};

export type CloudCodingViewProps = {
  overview?: CloudCodingOverview;
  loadError?: string;
  callbackError?: string;
  actionError?: string;
  settingsError?: string;
  installations?: InstallationChoices;
  finishConnecting?: boolean;
  installPending?: boolean;
  asked?: boolean;
  askPending?: boolean;
  settingsPending?: boolean;
  linkPending?: boolean;
  sentMemberIds?: readonly string[];
  sendPending?: boolean;
  onRetry: () => void;
  onInstall: (existing: boolean) => void;
  onAsk: () => void;
  onOpenGithub: () => void;
  onToggle: (enabled: boolean) => void;
  onChangeAudience: () => void;
  onLink: () => void;
  onSendLink: (person: CloudCodingOverview["people"][number]) => void;
};

export function CloudCodingView({ overview, loadError, callbackError, actionError, settingsError, installations, finishConnecting, installPending, asked, askPending, settingsPending, linkPending, sentMemberIds, sendPending, onRetry, onInstall, onAsk, onOpenGithub, onToggle, onChangeAudience, onLink, onSendLink }: CloudCodingViewProps) {
  const canManage = overview?.canManage;
  const connection = overview?.connection;
  const people = [...(overview?.people ?? [])].sort((a, b) => Number(b.isYou) - Number(a.isYou) || a.name.localeCompare(b.name));
  const addRepositories = canManage ? <DenButton variant="ghost" size="sm" onClick={onOpenGithub}>Add repositories</DenButton> : null;
  return (
    <DashboardPageTemplate title="Cloud coding" description={descriptionFor(overview)} action={connection && canManage ? <DenButton variant="secondary" size="sm" onClick={onOpenGithub}>Change on GitHub</DenButton> : null}>
      <div className="flex flex-col gap-9">
        {callbackError ? <DenNotice tone="error" message={callbackError} /> : null}
        {actionError ? <DenNotice tone="error" message={actionError} /> : null}
        {loadError ? <CloudCodingLoadError message={loadError} onRetry={onRetry} /> : null}
        {!overview ? (
          !loadError && <ItemPanel><ItemRowsSkeleton label="Loading Cloud coding" rows={1} /></ItemPanel>
        ) : !connection ? (
          <>
            <ItemPanel className="[&_[data-item-action]]:w-auto!">
              <ItemRow compact logo={<GithubMark />} title="GitHub" wrapDescription
                description={!overview.configured ? "Not set up on this deployment" : canManage ? "Not connected" : "Not connected. An admin needs to connect GitHub."}
                action={!overview.configured || canManage ? <DenButton size="sm" disabled={!overview.configured || installPending || installations?.pending} onClick={() => onInstall(false)}>Connect GitHub</DenButton> : <DenButton variant="secondary" size="sm" disabled={asked || askPending} onClick={onAsk}>{asked ? "Asked" : "Ask an admin"}</DenButton>}
              />
              {overview.configured && canManage && finishConnecting && !installations ? (
                <div className="flex justify-end py-1"><DenButton variant="ghost" size="sm" disabled={installPending} onClick={() => onInstall(true)}>Already installed on GitHub? Finish connecting</DenButton></div>
              ) : null}
            </ItemPanel>
            {overview.configured && canManage && installations ? (
              <section>
                <DenSectionHeader density="compact" title="Choose a GitHub account" />
                {installations.error ? <CloudCodingLoadError message={installations.error} onRetry={installations.onRetry} /> : (
                  <ItemPanel>
                    {!installations.accounts ? <ItemRowsSkeleton label="Loading GitHub accounts" rows={2} /> : installations.accounts.length === 0 ? <ItemRow compact title="No GitHub accounts found" description="Choose Connect GitHub to install OpenWork." /> : installations.accounts.map((account) => (
                      <ItemRow key={account.installationId} compact logo={<GithubMark />} title={account.accountLogin} action={<DenButton variant="secondary" size="sm" disabled={installations.pending || installPending} onClick={() => installations.onConnect(account.installationId)}>Connect</DenButton>} />
                    ))}
                  </ItemPanel>
                )}
              </section>
            ) : null}
            <section>
              <DenSectionHeader density="compact" title="How it works" />
              <ItemPanel>{steps.map((line, index) => (
                <div key={line} className={`flex min-h-11 items-center gap-3 py-2 ${valueClass}`}>
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--dls-hover)] text-[11px] font-semibold text-[var(--dls-text-secondary)]">{index + 1}</span>{line}
                </div>
              ))}</ItemPanel>
            </section>
          </>
        ) : (
          <>
            {connection.suspended ? <DenNotice tone="warning" message="GitHub paused OpenWork's access. Resume it on GitHub." action={<DenButton variant="secondary" size="sm" onClick={onOpenGithub}>Open GitHub</DenButton>} /> : null}
            <section>
              <DenSectionHeader density="compact" title="General" className="border-b border-[var(--den-list-line)]" />
              <div className="divide-y divide-[var(--den-list-line)] border-b border-[var(--den-list-line)]">
                <AccessRow title="Cloud coding" description={<span className="whitespace-normal">People can ask OpenWork to change code and open pull requests from Workbot, Slack and OpenWork Web.</span>}
                  trailing={<span className="flex shrink-0 flex-col-reverse items-end gap-2 sm:flex-row sm:items-center">
                    {!canManage ? <Locked id="cloud-coding-admin-lock">Only admins can change this</Locked> : null}
                    <DenSwitch aria-label="Cloud coding" aria-describedby={!canManage ? "cloud-coding-admin-lock" : undefined} checked={overview.enabled} disabled={!canManage || settingsPending} onChange={onToggle} />
                  </span>}
                />
                <AccessRow title="Who can use it" trailing={<span className="flex items-center gap-2"><span className={valueClass}>{overview.access.orgWide ? "Everyone" : audienceParts(overview.access).join(", ") || "No one"}</span>{canManage ? <DenButton variant="ghost" size="sm" disabled={settingsPending} onClick={onChangeAudience}>Change</DenButton> : null}</span>} />
              </div>
              {settingsError ? <DenNotice tone="error" className="mt-2" message={settingsError} /> : null}
            </section>
            <section>
              <DenSectionHeader density="compact" title="Repositories" description="Chosen on GitHub" action={overview.repositories.length > 0 ? addRepositories : null} />
              <ItemPanel className="[&_[data-item-action]]:w-auto!">{overview.repositories.length ? overview.repositories.map((repository) => (
                <ItemRow key={repository.id} compact logo={<GithubMark />} title={repository.fullName} description={pullCount(repository.pullRequestCount)} />
              )) : <ItemRow compact title={<span className={mutedClass}>No repositories chosen yet</span>} action={addRepositories} />}</ItemPanel>
            </section>
            <section>
              <DenSectionHeader density="compact" title="Rules" className="border-b border-[var(--den-list-line)]" />
              <div className="divide-y divide-[var(--den-list-line)] border-b border-[var(--den-list-line)]">
                <AccessRow title="Ask before every push" description={<span className="whitespace-normal">The person who asked approves each push in the chat.</span>} trailing={<Locked>Always</Locked>} />
                <AccessRow title="Push to new branches only" description={<span className="whitespace-normal">OpenWork never pushes to the main branch or rewrites history.</span>} trailing={<Locked>Always</Locked>} />
                <AccessRow title="Pull requests open as" trailing={<span className={valueClass}>The person who asked</span>} />
              </div>
            </section>
            <section>
              <DenSectionHeader density="compact" title="People" description="Each person links their own GitHub account the first time they ask" />
              <DenTable density="compact" cellAlign="middle" rows={people} getRowKey={(person) => person.memberId} columns={[
                { key: "person", header: "Person", width: "45%", render: (person) => <span className="flex min-w-0 items-center gap-3"><Avatar name={person.name} /><Cell title={person.isYou ? `${person.name} (you)` : person.name} detail={person.email} /></span> },
                { key: "github", header: "GitHub", render: (person) => !person.canUse ? <span className={mutedClass}>Not included</span> : person.github ? <span className={`flex items-center gap-1.5 ${valueClass}`}><GithubMark inline />{person.github.login}</span> : <span className={mutedClass}>Not linked yet</span> },
                { key: "action", header: "", width: "120px", align: "right", render: (person) => {
                  if (person.github || !person.canUse) return null;
                  if (person.isYou) return <DenButton variant="ghost" size="xs" disabled={linkPending} onClick={onLink}>Link your account</DenButton>;
                  const sent = sentMemberIds?.includes(person.memberId);
                  return canManage ? <DenButton variant="ghost" size="xs" disabled={sent || sendPending} onClick={() => onSendLink(person)}>{sent ? "Sent" : "Send link"}</DenButton> : null;
                } },
              ]} />
            </section>
            <section>
              <DenSectionHeader density="compact" title="Recent pull requests" />
              <DenTable density="compact" cellAlign="middle" rows={overview.pullRequests} getRowKey={(pull) => pull.id} emptyLabel="No pull requests yet. They'll show up here after someone's first push." columns={[
                { key: "pull", header: "Pull request", width: "60%", render: (pull) => (
                  <span className="flex min-w-0 items-center gap-3">
                    <GitPullRequest className={`size-4 shrink-0 ${pull.state === "open" ? valueClass : mutedClass}`} strokeWidth={1.5} aria-hidden />
                    <Cell title={<a className="hover:underline focus-visible:underline" href={pull.url} target="_blank" rel="noopener noreferrer">{pull.title}</a>} detail={`${pull.repositoryFullName} #${pull.number} · ${pullStates[pull.state]}`} />
                  </span>
                ) },
                { key: "person", header: "Opened by", render: (pull) => pull.openedBy.name },
                { key: "when", header: "When", width: "100px", align: "right", render: (pull) => <RelativeTime value={pull.openedAt} /> },
              ]} />
            </section>
          </>
        )}
      </div>
    </DashboardPageTemplate>
  );
}
