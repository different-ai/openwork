"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Globe, Users, X, type LucideIcon } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { AUTOMATION_CARD_CLASS, CARD_TITLE_CLASS } from "../../_components/ui/dashboard-styles";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import {
  getAiGatewayLimitRoute,
  getAiGatewayPersonRoute,
  getAiGatewayUsersTeamsRoute,
  getMembersRoute,
  getNewAiGatewayLimitRoute,
  type DenOrgContext,
  type DenOrgTeam,
} from "../../_lib/den-org";
import { formatUsageCost } from "../_features/analytics/stacked-daily-chart";
import { useFeatureIntro } from "../_features/feature-intros";
import { directoryAccess, directoryLimit, limitSourceLabel, limitSummary, memberSubject, type DirectorySubject } from "./gateway-directory-data";
import { initials } from "./gateway-spend-breakdown";
import { useGatewayAccessProviders, type GatewayAccessProvider } from "./gateway-subject-access-data";
import { gatewayUsageTotals, useGatewayUsage } from "./gateway-usage-data";
import { useGatewayPolicies } from "./gateway-usage-limits-data";
import { getProviderIconSlug } from "./llm-provider-data";
import { RowLane, RowLaneLabel, RowList, RowListHeader } from "../_features/computers/computer-rows";
import { GATEWAY_LANE, GatewayRow, InitialsTile, RowListNote } from "./gateway-rows";
import { FilterInput } from "./item-list";
import type { GatewayUsageLimitPolicy } from "@openwork/types/den/gateway-usage-limits";

type DirectoryView = "people" | "teams";

const PAGE_SIZE = 50;
const VISIBLE_MARKS = 4;
const MUTED = "text-[color:var(--dls-text-secondary)]";

function ProviderMarks({ providers }: { providers: GatewayAccessProvider[] }) {
  if (!providers.length) return <span className={`text-[12px] ${MUTED}`}>Nothing yet</span>;
  const hidden = providers.length - VISIBLE_MARKS;
  return (
    <span className="flex items-center gap-1" aria-label={`Can use ${providers.map((provider) => provider.name).join(", ")}`} role="img">
      {providers.slice(0, VISIBLE_MARKS).map((provider) => (
        <DenBrandMark key={provider.id} name={provider.name} simpleIconSlug={getProviderIconSlug(provider.providerId)} className="size-6 rounded-md" imageClassName="size-3.5" />
      ))}
      {hidden > 0 ? <span className={`pl-1 text-[12px] ${MUTED}`}>+{hidden}</span> : null}
    </span>
  );
}

function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return <span aria-hidden="true" className={`flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--dls-hover)] ${MUTED}`}><Icon size={16} strokeWidth={1.5} /></span>;
}

function Spend({ value, state }: { value: number | undefined; state: "ready" | "loading" | "error" }) {
  return (
    <RowLane lane={GATEWAY_LANE.spend} className="font-medium text-[color:var(--dls-text-primary)]">
      {state === "ready" ? formatUsageCost(value ?? 0) : <span className={`font-normal ${MUTED}`}>{state === "loading" ? "…" : "—"}</span>}
    </RowLane>
  );
}

function LimitCell({ summary, source }: { summary: string; source: string }) {
  return (
    <RowLane lane={GATEWAY_LANE.limit} className="flex-col justify-center">
      <span className={`truncate ${summary === "No limit" ? MUTED : "text-[color:var(--dls-text-primary)]"}`}>{summary}</span>
      {source ? <span className={`truncate text-[12px] leading-4 ${MUTED}`}>{source}</span> : null}
    </RowLane>
  );
}

function CanUse({ providers }: { providers: GatewayAccessProvider[] }) {
  return <RowLane lane={GATEWAY_LANE.canUse} className="items-center"><ProviderMarks providers={providers} /></RowLane>;
}

function Columns({ first }: { first: string }) {
  return (
    <RowListHeader lead={first}>
      <RowLaneLabel lane={GATEWAY_LANE.canUse}>Can use</RowLaneLabel>
      <RowLaneLabel lane={GATEWAY_LANE.limit}>Limit</RowLaneLabel>
      <RowLaneLabel lane={`${GATEWAY_LANE.spend} text-right`}>Last 31 days</RowLaneLabel>
    </RowListHeader>
  );
}

export function GatewayUsersTeamsSection({ orgId, orgSlug, orgContext }: { orgId: string; orgSlug: string | null | undefined; orgContext: DenOrgContext }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const providers = useGatewayAccessProviders(orgId);
  const policies = useGatewayPolicies(orgId);
  const personUsage = useGatewayUsage(orgId, "person", []);
  const teamUsage = useGatewayUsage(orgId, "team", []);
  const [query, setQuery] = useState("");
  const [pages, setPages] = useState(1);
  // Feature intros: providers nobody can use yet → a banner above the directory.
  const accessIntro = useFeatureIntro(
    "ai-gateway.users-and-teams",
    providers.data ? { accessGrants: providers.data.reduce((count, provider) => count + provider.accessGrants.length, 0) } : null,
  );

  const teamId = searchParams.get("team");
  const view: DirectoryView = !teamId && searchParams.get("view") === "teams" ? "teams" : "people";
  const team = teamId ? orgContext.teams.find((item) => item.id === teamId) : undefined;

  function setView(next: DirectoryView) {
    router.push(next === "teams" ? getAiGatewayUsersTeamsRoute(orgSlug, { view: "teams" }) : getAiGatewayUsersTeamsRoute(orgSlug), { scroll: false });
  }

  const dataError = providers.error?.message ?? policies.error?.message;
  if (providers.isPending || policies.isPending) {
    return <section aria-label="Users and teams" data-testid="gateway-users-teams"><p role="status" className={`text-[13px] ${MUTED}`}>Loading people and teams…</p></section>;
  }
  if (dataError || !providers.data || !policies.data) {
    return (
      <section aria-label="Users and teams" data-testid="gateway-users-teams" className="flex flex-col items-start gap-3">
        <DenNotice tone="error" message={dataError ?? "Could not load people and teams."} />
        <DenButton size="sm" variant="secondary" onClick={() => { void providers.refetch(); void policies.refetch(); }}>Retry</DenButton>
      </section>
    );
  }

  const providerList = providers.data;
  const policyList = policies.data.policies;
  const spendState = (usage: typeof personUsage) => usage.isPending ? "loading" : usage.isError ? "error" : "ready";
  const personSpend = new Map((personUsage.data ? gatewayUsageTotals(personUsage.data) : []).map((row) => [row.id, row.costMicroUsd]));
  const teamSpend = new Map((teamUsage.data ? gatewayUsageTotals(teamUsage.data) : []).map((row) => [row.id, row.costMicroUsd]));
  const usable = (subject: DirectorySubject) => directoryAccess(providerList, subject).map((entry) => entry.provider);
  const needle = query.trim().toLowerCase();
  const people = orgContext.members
    .filter((member) => !team || team.memberIds.includes(member.id))
    .filter((member) => !needle || `${member.user.name} ${member.user.email}`.toLowerCase().includes(needle))
    .sort((a, b) => (personSpend.get(b.id) ?? 0) - (personSpend.get(a.id) ?? 0) || (a.user.name || a.user.email).localeCompare(b.user.name || b.user.email));
  const teams = orgContext.teams
    .filter((item) => !needle || item.name.toLowerCase().includes(needle))
    .sort((a, b) => (teamSpend.get(b.id) ?? 0) - (teamSpend.get(a.id) ?? 0) || a.name.localeCompare(b.name));
  const everyone: DirectorySubject = { type: "organization" };
  const everyoneLimit = directoryLimit(policyList, everyone);

  return (
    <section aria-label="Users and teams" data-testid="gateway-users-teams" className="flex flex-col gap-4">
      {accessIntro.size === "banner" ? <div className="mb-2">{accessIntro.element}</div> : null}
      <div className="flex flex-wrap items-center justify-between gap-3 sm:flex-row-reverse">
        <DenSegmented<DirectoryView>
          aria-label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: "people", label: "People" },
            { value: "teams", label: "Teams" },
          ]}
        />
        {teamId ? (
          <Link href={getAiGatewayUsersTeamsRoute(orgSlug)} scroll={false} data-testid="gateway-directory-team-filter" aria-label={`Clear team filter ${team?.name ?? ""}`.trim()}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--den-shell-line)] bg-[var(--dls-surface)] pl-3 pr-2 text-[12px] hover:border-[var(--dls-text-secondary)]">
            <span className={MUTED}>Team</span>
            <span className="font-medium text-[color:var(--dls-text-primary)]">{team?.name ?? "Removed team"}</span>
            <X className={`size-3.5 ${MUTED}`} aria-hidden="true" />
          </Link>
        ) : view === "people" || orgContext.teams.length ? (
          <FilterInput value={query} onChange={(value) => { setQuery(value); setPages(1); }}
            placeholder={view === "teams" ? "Filter teams by name" : "Filter people by name"} className="w-full sm:w-64" />
        ) : null}
      </div>

      <div className="flex flex-col">
        {teamId && !team ? (
          <DenNotice tone="info" message="This team no longer exists. Clear the filter to see everyone." />
        ) : team ? (
          <TeamStrip team={team} orgSlug={orgSlug} policies={policyList}
            providers={usable({ type: "team", teamId: team.id })} spend={teamSpend.get(team.id)} spendState={spendState(teamUsage)} />
        ) : (
          <RowList label="Everyone" header={<Columns first={view === "teams" ? "Team" : "Person"} />}>
            <GatewayRow
              rowTestId="gateway-directory-everyone"
              lead={<IconTile icon={Globe} />}
              name={`Everyone in ${orgContext.organization.name}`}
              secondLine={`${orgContext.members.length} ${orgContext.members.length === 1 ? "person" : "people"}, and anyone who joins`}
              lanes={<>
                <CanUse providers={usable(everyone)} />
                <LimitCell summary={limitSummary(everyoneLimit, true)} source={limitSourceLabel(everyoneLimit, everyone, orgContext.teams)} />
                <Spend value={personUsage.data?.totalCostMicroUsd} state={spendState(personUsage)} />
              </>}
            />
          </RowList>
        )}

        {view === "teams" ? (
          orgContext.teams.length === 0 ? (
            <div className={`${AUTOMATION_CARD_CLASS} mt-4 flex flex-col items-center gap-3 p-4 py-14 text-center`} data-testid="gateway-teams-empty">
              <span aria-hidden="true" className={`flex size-10 items-center justify-center rounded-[10px] bg-[var(--dls-hover)] ${MUTED}`}><Users size={16} strokeWidth={1.5} /></span>
              <span className="flex flex-col gap-1">
                <span className={CARD_TITLE_CLASS}>No teams yet</span>
                <span className={`text-[13px] ${MUTED}`}>Group people into teams to give them models and a shared limit in one step.</span>
              </span>
              <Link href={getMembersRoute(orgSlug)} className={buttonVariants({ variant: "primary", size: "sm" })}>Create a team</Link>
              <span className={`text-[12px] ${MUTED}`}>Teams are managed in Members.</span>
            </div>
          ) : (
            <RowList label="Teams" testId="gateway-directory-teams">
              {teams.length === 0 ? <RowListNote>No team matches “{query.trim()}”.</RowListNote> : null}
              {teams.map((item) => {
                const subject: DirectorySubject = { type: "team", teamId: item.id };
                const limit = directoryLimit(policyList, subject);
                return (
                  <GatewayRow
                    key={item.id}
                    rowTestId="gateway-directory-team-row"
                    rowData={{ "data-team-id": item.id }}
                    href={getAiGatewayUsersTeamsRoute(orgSlug, { teamId: item.id })}
                    scroll={false}
                    stretch
                    lead={<IconTile icon={Users} />}
                    name={item.name}
                    secondLine={`${item.memberIds.length} ${item.memberIds.length === 1 ? "person" : "people"}`}
                    lanes={<>
                      <CanUse providers={usable(subject)} />
                      <LimitCell summary={limitSummary(limit, true)} source={limitSourceLabel(limit, subject, orgContext.teams)} />
                      <Spend value={teamSpend.get(item.id)} state={spendState(teamUsage)} />
                    </>}
                  />
                );
              })}
            </RowList>
          )
        ) : teamId && !team ? null : (
          <div>
            <RowList label="People" testId="gateway-directory-people" header={team ? <Columns first="Person" /> : undefined}>
              {people.length === 0 ? (
                <RowListNote>
                  {needle ? `No one matches “${query.trim()}”.` : team ? "No one is in this team yet." : "No people yet."}
                </RowListNote>
              ) : null}
              {people.slice(0, pages * PAGE_SIZE).map((member) => {
                const subject = memberSubject(member, orgContext.teams);
                const limit = directoryLimit(policyList, subject);
                const memberTeams = orgContext.teams.filter((item) => item.memberIds.includes(member.id)).map((item) => item.name);
                const name = member.user.name || member.user.email;
                return (
                  <GatewayRow
                    key={member.id}
                    rowTestId="gateway-directory-person-row"
                    rowData={{ "data-member-id": member.id }}
                    href={getAiGatewayPersonRoute(orgSlug, member.id)}
                    stretch
                    lead={<InitialsTile>{initials(name)}</InitialsTile>}
                    name={name}
                    secondLine={memberTeams.length ? memberTeams.join(", ") : member.user.email}
                    lanes={<>
                      <CanUse providers={usable(subject)} />
                      <LimitCell summary={limitSummary(limit, false)} source={limitSourceLabel(limit, subject, orgContext.teams)} />
                      <Spend value={personSpend.get(member.id)} state={spendState(personUsage)} />
                    </>}
                  />
                );
              })}
            </RowList>
            {people.length > pages * PAGE_SIZE ? (
              <div className="flex items-center justify-between py-3 text-[12px]">
                <span className={MUTED}>{people.length - pages * PAGE_SIZE} more {people.length - pages * PAGE_SIZE === 1 ? "person" : "people"}</span>
                <DenButton variant="secondary" size="sm" onClick={() => setPages(pages + 1)}>Show more</DenButton>
              </div>
            ) : null}
          </div>
        )}
      </div>
      {personUsage.isError || teamUsage.isError ? (
        <p className={`text-[12px] ${MUTED}`}>Spend could not be loaded. <button type="button" className="underline underline-offset-4" onClick={() => { void personUsage.refetch(); void teamUsage.refetch(); }}>Try again</button></p>
      ) : null}
    </section>
  );
}

function TeamStrip({ team, orgSlug, policies, providers, spend, spendState }: {
  team: DenOrgTeam;
  orgSlug: string | null | undefined;
  policies: GatewayUsageLimitPolicy[];
  providers: GatewayAccessProvider[];
  spend: number | undefined;
  spendState: "ready" | "loading" | "error";
}) {
  const subject: DirectorySubject = { type: "team", teamId: team.id };
  const limit = directoryLimit(policies, subject);
  const teamPolicy = policies.find((policy) => !policy.archivedAt && policy.assignments.some((assignment) => assignment.teamId === team.id));
  return (
    <RowList label={team.name} header={<Columns first="Team" />}>
      <GatewayRow
        rowTestId="gateway-directory-team-strip"
        lead={<IconTile icon={Users} />}
        name={team.name}
        secondLine={`${team.memberIds.length} ${team.memberIds.length === 1 ? "person" : "people"}`}
        lanes={<>
          <CanUse providers={providers} />
          <RowLane lane={GATEWAY_LANE.limit} className="flex-col justify-center">
            <span className="truncate text-[color:var(--dls-text-primary)]">{limitSummary(limit, true)}</span>
            <Link href={teamPolicy ? getAiGatewayLimitRoute(orgSlug, teamPolicy.id) : getNewAiGatewayLimitRoute(orgSlug, { teamId: team.id })}
              data-testid="gateway-directory-team-limit" className="w-fit text-[12px] leading-4 font-medium text-[color:var(--dls-text-primary)] underline underline-offset-2 hover:opacity-70">
              {teamPolicy ? "Edit team limit" : "Set a team limit"}
            </Link>
          </RowLane>
          <Spend value={spend} state={spendState} />
        </>}
      />
    </RowList>
  );
}
