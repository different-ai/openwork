"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Plus, Search } from "lucide-react";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { DenSegmented } from "../../../_components/ui/segmented";
import { getNewPluginRoute, getPluginSkillRoute, getPluginsRoute } from "../../../_lib/den-org";
import { BackLink, ItemPage } from "../../_components/item-header";
import { ItemPanel, ItemRowsSkeleton, LinkButton } from "../../_components/item-list";
import { LetterTile } from "../../_components/item-logo";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
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
          <span className="block truncate font-medium text-gray-900" title={row.skillName}>{row.skillName}</span>
          <span className="block truncate text-[12px] text-gray-500">{row.pluginName}</span>
        </span>
      </Link>
      <span className="tabular-nums text-gray-900" data-skill-uses>{row.uses.toLocaleString()}</span>
      <span className="tabular-nums text-gray-600">{row.people.toLocaleString()}</span>
      {lastUsed && row.lastUsedAt
        ? <time dateTime={row.lastUsedAt} title={new Date(row.lastUsedAt).toLocaleString()} className="text-gray-600">{lastUsed}</time>
        : <span className="text-gray-500" data-skill-unused>Not used</span>}
    </li>
  );
}

function NoMatches({ allUsed }: { allUsed: boolean }) {
  return <p className="px-5 py-6 text-[13px] text-gray-600">{allUsed ? "Every skill was used in this period." : "No skills match. Try another name."}</p>;
}

function UsageEmpty() {
  const { orgSlug } = useOrgDashboard();
  return (
    <div className="flex flex-col items-center gap-4 px-6 pb-12 pt-14 text-center" data-testid="skill-usage-empty">
      <div className="flex flex-col gap-1.5">
        <p className="text-[15px] font-semibold leading-5 text-gray-900">No skills yet</p>
        <p className="text-[13px] leading-[18px] text-gray-500">Add a plugin with skills to see how often people use them.</p>
      </div>
      <LinkButton variant="primary" href={getNewPluginRoute(orgSlug)}><Plus className="h-4 w-4" aria-hidden />Create a plugin</LinkButton>
    </div>
  );
}

export function SkillUsageScreen() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { orgSlug } = useOrgDashboard();
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

  if (!available) {
    return (
      <ItemPage testId="skill-usage" wide>
        <BackLink href={getPluginsRoute(orgSlug)} label="Plugins" />
        <DenPageHeader title="Skill usage" />
        <DenNotice tone="neutral" presentation="inline" message="Skill usage is not turned on for this workspace." />
      </ItemPage>
    );
  }

  const report = usage.data;
  const rows = report ? filterSkillUsage(report.skills, filter, name) : [];
  const since = report ? countingSinceLabel(report, now) : null;
  const notCounting = report && !report.trackingSince && report.skills.length > 0;

  return (
    <ItemPage testId="skill-usage" wide>
      <BackLink href={getPluginsRoute(orgSlug)} label="Plugins" />
      <DenPageHeader title="Skill usage" action={since ? <p className="pt-2 text-[12px] leading-4 text-gray-500" data-testid="skill-usage-since">{since}</p> : undefined} />
      <div className="flex flex-wrap items-center gap-2" data-testid="skill-usage-toolbar">
        <label className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 focus-within:ring-2 focus-within:ring-gray-300">
          <Search className="h-4 w-4 shrink-0 text-gray-400" aria-hidden />
          <input type="search" value={name} onChange={(event) => setName(event.target.value)} placeholder="Filter by name" aria-label="Filter skills by name" className="min-w-0 flex-1 bg-transparent text-[13px] outline-none" />
        </label>
        <DenSegmented aria-label="Which skills" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "unused", label: "Not used" }]} />
        <DenSegmented aria-label="Time range" value={String(days)} onChange={(value) => setDays(parseSkillUsageWindow(value))} options={skillUsageWindows.map((window) => ({ value: String(window), label: `${window} days` }))} />
      </div>

      {usage.isError && report ? (
        <DenNotice tone="neutral" presentation="inline" message="Couldn't refresh. Showing the last counts." action={<DenButton variant="secondary" size="sm" onClick={() => void usage.refetch()}>Retry</DenButton>} />
      ) : null}

      {usage.isPending ? (
        <ItemPanel><ItemRowsSkeleton label="Loading skill usage" rows={6} /></ItemPanel>
      ) : usage.isError && !report ? (
        <DenNotice tone="error" presentation="inline" message="Skill usage did not load." action={<DenButton variant="secondary" size="sm" onClick={() => void usage.refetch()}>Try again</DenButton>} />
      ) : report && report.skills.length === 0 ? (
        <ItemPanel><UsageEmpty /></ItemPanel>
      ) : (
        <ItemPanel className="overflow-x-auto">
          <div className="min-w-[580px]">
            <div className={`${columns} py-2 text-[12px] text-gray-500`} data-testid="skill-usage-columns">
              <span>Skill</span><span>Uses</span><span>People</span><span>Last used</span>
            </div>
            {notCounting ? <p className="border-t border-gray-100 px-5 py-3 text-[13px] text-gray-600" data-testid="skill-usage-not-counting">No uses recorded yet. Counts start the first time someone loads a skill.</p> : null}
            {rows.length === 0
              ? <div className="border-t border-gray-100"><NoMatches allUsed={filter === "unused" && !name.trim()} /></div>
              : <ul className="divide-y divide-gray-100 border-t border-gray-100">{rows.map((row) => <UsageRow key={row.skillId} row={row} now={now} />)}</ul>}
          </div>
        </ItemPanel>
      )}
    </ItemPage>
  );
}
