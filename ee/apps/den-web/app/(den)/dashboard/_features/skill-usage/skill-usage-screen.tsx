"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { CircleOff, Plus, Puzzle, Search, Zap } from "lucide-react";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { DenSegmented } from "../../../_components/ui/segmented";
import { getNewPluginRoute, getPluginSkillRoute } from "../../../_lib/den-org";
import { ItemRowsSkeleton } from "../../_components/item-list";
import { LetterTile } from "../../_components/item-logo";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { AnalyticsEmptyState, AnalyticsPageHeader, analyticsPageClass, analyticsSurfaceClass } from "../analytics/analytics-layout";
import { StatCard } from "../analytics/stat-card";
import {
  countingSinceLabel,
  filterSkillUsage,
  lastUsedLabel,
  parseSkillUsageWindow,
  skillUsageWindows,
  type SkillUsageFilter,
  type SkillUsageRow,
  type SkillUsageWindow,
} from "./skill-usage-data";
import { useSkillUsage, useSkillUsageAvailable } from "./use-skill-usage";

// The name lane is capped so the numbers stay next to the skill they describe (OW-LIST-LANES).
const columns = "grid grid-cols-[minmax(0,260px)_56px_56px_112px] items-center gap-4 px-5";

function UsageRow({ row, now }: { row: SkillUsageRow; now: number }) {
  const { orgSlug } = useOrgDashboard();
  const lastUsed = lastUsedLabel(row.lastUsedAt, now);
  return (
    <li className={`${columns} min-h-12 py-2 text-[13px]`} data-testid="skill-usage-row" data-skill={row.skillName}>
      <Link href={getPluginSkillRoute(orgSlug, row.pluginId, row.skillId)} className="flex min-w-0 items-center gap-3 rounded-lg focus-visible:ring-2 focus-visible:ring-gray-300">
        <LetterTile name={row.skillName} />
        <span className="min-w-0">
          <span className="block truncate font-medium text-[#07192C]" title={row.skillName}>{row.skillName}</span>
          <span className="block truncate text-[12px] text-[#637291]">{row.pluginName}</span>
        </span>
      </Link>
      <span className="tabular-nums text-[#07192C]" data-skill-uses>{row.uses.toLocaleString()}</span>
      <span className="tabular-nums text-[#637291]">{row.people.toLocaleString()}</span>
      {lastUsed && row.lastUsedAt
        ? <time dateTime={row.lastUsedAt} title={new Date(row.lastUsedAt).toLocaleString()} className="text-[#637291]">{lastUsed}</time>
        : <span className="text-[#637291]" data-skill-unused>Not used</span>}
    </li>
  );
}

function NoMatches({ allUsed }: { allUsed: boolean }) {
  return <p className="px-5 py-6 text-[13px] text-[#637291]">{allUsed ? "Every skill was used in this period." : "No skills match. Try another name."}</p>;
}

export function SkillUsageScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeOrg } = useOrgDashboard();
  const orgSlug = activeOrg?.slug;
  const available = useSkillUsageAvailable();
  const days = parseSkillUsageWindow(searchParams.get("days"));
  const [filter, setFilter] = useState<SkillUsageFilter>("all");
  const [name, setName] = useState("");
  const usage = useSkillUsage(days);
  const [now] = useState(() => Date.now());

  function setDays(next: SkillUsageWindow) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("days", String(next));
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  const report = usage.data;
  const rows = report ? filterSkillUsage(report.skills, filter, name) : [];
  const since = report ? countingSinceLabel(report, now) : null;
  const notCounting = report && !report.trackingSince && report.skills.length > 0;
  const used = report ? report.skills.filter((skill) => skill.uses > 0).length : 0;
  const total = report?.skills.length ?? 0;
  const uses = report ? report.skills.reduce((sum, skill) => sum + skill.uses, 0) : 0;
  const loading = usage.isPending;

  return (
    <div className={analyticsPageClass} data-testid="skill-usage">
      <AnalyticsPageHeader orgSlug={orgSlug} active="skills" title="Skills"
        description="See which skills your team uses and which nobody uses, so you know what to keep."
        caption={since ? <span data-testid="skill-usage-since">{since}</span> : undefined} />

      {!available ? (
        <div className={analyticsSurfaceClass}><AnalyticsEmptyState title="Skill usage is not on for this workspace">Ask OpenWork to turn it on for your organization.</AnalyticsEmptyState></div>
      ) : usage.isError && !report ? (
        <DenNotice tone="error" presentation="inline" message="Skill usage did not load." action={<DenButton variant="secondary" size="sm" onClick={() => void usage.refetch()}>Try again</DenButton>} />
      ) : report && total === 0 ? (
        <div className={analyticsSurfaceClass} data-testid="skill-usage-empty">
          <AnalyticsEmptyState title="No skills yet" action={<DenButton href={getNewPluginRoute(orgSlug)}><Plus className="mr-2 h-4 w-4" aria-hidden />Create a plugin</DenButton>}>
            Add a plugin with skills to see how often people use them.
          </AnalyticsEmptyState>
        </div>
      ) : (
        <>
          {usage.isError ? <DenNotice tone="neutral" presentation="inline" message="Couldn't refresh. Showing the last counts." action={<DenButton variant="secondary" size="sm" onClick={() => void usage.refetch()}>Retry</DenButton>} /> : null}
          <div className="grid gap-3.5 sm:grid-cols-3">
            <StatCard icon={<Puzzle className="text-[#6F3DFF]" />} tone="violet" title="Skills in use" value={loading ? "…" : `${used} of ${total}`} sub={`Used at least once in ${days} days`} />
            <StatCard icon={<Zap className="text-[#1D63FF]" />} tone="blue" title="Uses" value={loading ? "…" : uses.toLocaleString()} sub="Skill loads by agents" />
            <StatCard icon={<CircleOff className="text-[#B7791F]" />} tone="amber" title="Not used" value={loading ? "…" : `${total - used}`} sub="Worth reviewing" />
          </div>

          <div className="flex flex-wrap items-center gap-2" data-testid="skill-usage-toolbar">
            <label className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-[#e3e7ee] bg-white px-3 focus-within:ring-2 focus-within:ring-gray-300">
              <Search className="h-4 w-4 shrink-0 text-[#637291]" aria-hidden />
              <input type="search" value={name} onChange={(event) => setName(event.target.value)} placeholder="Filter by name" aria-label="Filter skills by name" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
            </label>
            <DenSegmented aria-label="Which skills" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "unused", label: "Not used" }]} />
            <DenSegmented aria-label="Time range" value={String(days)} onChange={(value) => setDays(parseSkillUsageWindow(value))} options={skillUsageWindows.map((window) => ({ value: String(window), label: `${window} days` }))} />
          </div>

          <div className={`${analyticsSurfaceClass} overflow-x-auto`}>
            {loading ? <ItemRowsSkeleton label="Loading skill usage" rows={6} /> : (
              <div className="min-w-[580px]">
                <div className={`${columns} py-2.5 text-[12px] text-[#637291]`} data-testid="skill-usage-columns">
                  <span>Skill</span><span>Uses</span><span>People</span><span>Last used</span>
                </div>
                {notCounting ? <p className="border-t border-[#e3e7ee] px-5 py-3 text-[13px] text-[#637291]" data-testid="skill-usage-not-counting">No uses recorded yet. Counts start the first time someone loads a skill.</p> : null}
                {rows.length === 0
                  ? <div className="border-t border-[#e3e7ee]"><NoMatches allUsed={filter === "unused" && !name.trim()} /></div>
                  : <ul className="divide-y divide-[#e3e7ee] border-t border-[#e3e7ee]">{rows.map((row) => <UsageRow key={row.skillId} row={row} now={now} />)}</ul>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
