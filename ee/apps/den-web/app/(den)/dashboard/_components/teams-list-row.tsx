"use client";

import type { LucideIcon } from "lucide-react";
import { ChevronRight, Lock } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { IconTile } from "./access-rows";

/**
 * Lanes of the Members › Teams list: name, then the fixed Role, Agent
 * permissions and Members lanes the organization has, then a 28px action lane.
 * Literal classes, so Tailwind generates each combination.
 */
export function teamsListColumns({ agentPermissions }: { agentPermissions: boolean }): string {
  return agentPermissions ? "lg:grid-cols-[minmax(0,1fr)_150px_130px_88px_28px]" : "lg:grid-cols-[minmax(0,1fr)_150px_88px_28px]";
}

const ROW = "grid grid-cols-[minmax(0,1fr)_28px] items-center gap-4 px-5";

/** Column titles over the list, aligned with the row lanes. */
export function TeamsListHeader({ columns, agentPermissions }: { columns: string; agentPermissions: boolean }) {
  return (
    <div className={`${ROW} border-b border-gray-100 py-2.5 text-[12px] font-medium leading-4 text-gray-500 ${columns}`}>
      <span>Team</span>
      <span className="hidden lg:block">Role</span>
      {agentPermissions ? <span className="hidden lg:block">Agent permissions</span> : null}
      <span className="hidden lg:block">Members</span>
      <span aria-hidden />
    </div>
  );
}

/** A lane's value: one line, cut short with the full text on hover. */
export function TeamsListLane({ children, title, testId, tone = "default" }: { children: ReactNode; title?: string; testId?: string; tone?: "default" | "muted" }) {
  return (
    <span
      className={`hidden min-w-0 truncate text-[13px] leading-[18px] lg:block ${tone === "muted" ? "text-gray-500" : "text-gray-700"}`}
      title={title}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

/**
 * One row of Members › Teams, the same anatomy for Everyone and each team: a
 * 32px tile, a one-line name and subtitle, the fixed lanes, and an action lane.
 */
export function TeamsListRow({ columns, icon, name, href, badge, subtitle, lanes, action, testId }: {
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
  const nameClass = "min-w-0 truncate text-[14px] font-medium leading-5 text-gray-900";
  return (
    <div data-testid={testId} className={`${ROW} border-b border-gray-100 py-3 transition-colors last:border-b-0 hover:bg-gray-50/60 ${columns}`}>
      <div className="flex min-w-0 items-center gap-3.5">
        <IconTile icon={icon} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            {href ? (
              <Link href={href} title={name} data-testid="team-row-name" className={`${nameClass} rounded hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400`}>
                {name}
              </Link>
            ) : (
              <span title={name} data-testid="team-row-name" className={nameClass}>{name}</span>
            )}
            {badge}
          </span>
          <span title={subtitle} data-testid="team-row-subtitle" className="truncate text-[13px] leading-[18px] text-gray-500">{subtitle}</span>
        </div>
      </div>
      {lanes}
      <div className="flex w-7 justify-end" data-team-action>{action}</div>
    </div>
  );
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
