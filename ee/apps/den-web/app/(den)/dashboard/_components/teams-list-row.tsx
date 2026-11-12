"use client";

import type { LucideIcon } from "lucide-react";
import { ChevronRight, Lock } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ListRow, RowLane, RowLaneLabel, RowListHeader } from "../_features/computers/computer-rows";

/**
 * Lanes of the Members › Teams list: name, then the fixed Role, Agent
 * permissions and Members lanes the organization has, then a 28px action lane.
 * Literal classes, so Tailwind generates each combination.
 */
export function teamsListColumns({ agentPermissions }: { agentPermissions: boolean }): string {
  return agentPermissions ? "lg:grid-cols-[minmax(0,1fr)_150px_130px_88px_28px]" : "lg:grid-cols-[minmax(0,1fr)_150px_88px_28px]";
}

const TEAM_LANE = "hidden w-36 @2xl:block";

/** Column titles over the list, aligned with the row lanes. */
export function TeamsListHeader({ agentPermissions }: { columns: string; agentPermissions: boolean }) {
  return <RowListHeader lead="Team" menu>
    <RowLaneLabel lane={TEAM_LANE}>Role</RowLaneLabel>
    {agentPermissions ? <RowLaneLabel lane={TEAM_LANE}>Agent permissions</RowLaneLabel> : null}
    <RowLaneLabel lane={TEAM_LANE}>Members</RowLaneLabel>
  </RowListHeader>;
}

/** A fixed lane shared with the Computers row component. */
export function TeamsListLane({ children, title, testId, tone = "default" }: { children: ReactNode; title?: string; testId?: string; tone?: "default" | "muted" }) {
  return <RowLane lane={TEAM_LANE} title={title} className={tone === "muted" ? "text-[var(--dls-text-secondary)]" : ""}>
    <span data-testid={testId} className="block truncate">{children}</span>
  </RowLane>;
}

/**
 * One row of Members › Teams, the same anatomy for Everyone and each team: a
 * 32px tile, a one-line name and subtitle, the fixed lanes, and an action lane.
 */
export function TeamsListRow({ icon, name, href, badge, subtitle, lanes, action, testId }: {
  columns: string;
  icon: LucideIcon;
  name: string;
  href?: string;
  badge?: ReactNode;
  subtitle: string;
  lanes: ReactNode;
  action: ReactNode;
  testId: string;
}) {
  return <ListRow icon={icon} name={name} href={href} badge={badge}
    rowTestId={testId} testId="team-row-name"
    secondLine={<span data-testid="team-row-subtitle" title={subtitle}>{subtitle}</span>}
    lanes={lanes} action={<span data-team-action>{action}</span>} />;
}

const ICON_ACTION = "flex h-7 w-7 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-gray-400";

/** Everyone's action lane: opens its page, the same size as a team's menu. */
export function TeamsListOpenLink({ href, name }: { href: string; name: string }) {
  return (
    <Link href={href} aria-label={`Open ${name}`} title="Open" className={ICON_ACTION}>
      <ChevronRight className="h-4 w-4" aria-hidden />
    </Link>
  );
}

/** A team the viewer can't change: a lock with the reason and who can (DESIGN.md P4). */
export function TeamsListLocked({ reason }: { reason: string }) {
  return (
    <span role="img" aria-label={reason} title={reason} className="flex h-7 w-7 items-center justify-center text-gray-500">
      <Lock className="h-4 w-4" aria-hidden />
    </span>
  );
}
