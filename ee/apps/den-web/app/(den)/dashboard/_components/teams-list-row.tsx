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
export function teamsListColumns({ role, agentPermissions }: { role: boolean; agentPermissions: boolean }): string {
  if (role && agentPermissions) return "lg:grid-cols-[minmax(0,1fr)_150px_130px_88px_28px]";
  if (role) return "lg:grid-cols-[minmax(0,1fr)_150px_88px_28px]";
  if (agentPermissions) return "lg:grid-cols-[minmax(0,1fr)_130px_88px_28px]";
  return "lg:grid-cols-[minmax(0,1fr)_88px_28px]";
}

const ROW = "grid grid-cols-[minmax(0,1fr)_28px] items-center gap-4 px-5";

/** Column titles over the list, aligned with the row lanes. */
export function TeamsListHeader({ columns, role, agentPermissions }: { columns: string; role: boolean; agentPermissions: boolean }) {
  return (
    <div className={`${ROW} border-b border-gray-100 py-2.5 text-[12px] font-medium leading-4 text-gray-500 ${columns}`}>
      <span>Team</span>
      {role ? <span className="hidden lg:block">Role</span> : null}
      {agentPermissions ? <span className="hidden lg:block">Agent permissions</span> : null}
      <span className="hidden lg:block">Members</span>
      <span aria-hidden />
    </div>
  );
}

/** A lane's value: one line, cut short with the full text on hover. */
export function TeamsListLane({ children, title, testId, tone = "default", label }: { children: ReactNode; title?: string; testId?: string; tone?: "default" | "muted"; label?: string }) {
  return (
    <div
      className={`col-start-1 min-w-0 break-words pl-11 text-[13px] leading-[18px] lg:col-auto lg:pl-0 ${tone === "muted" ? "text-gray-500" : "text-gray-700"}`}
      title={title}
      data-testid={testId}
    >
      {label ? <span className="text-gray-500 lg:hidden">{label}: </span> : null}{children}
    </div>
  );
}

/**
 * One row of Members › Teams, the same anatomy for Everyone and each team: a
 * 32px tile, a one-line name and subtitle, the fixed lanes, and an action lane.
 */
export function TeamsListRow({ columns, icon, name, href, badge, subtitle, lanes, action, extra, testId }: {
  columns: string;
  icon: LucideIcon;
  name: string;
  href?: string;
  badge?: ReactNode;
  subtitle: ReactNode;
  lanes: ReactNode;
  action: ReactNode;
  /** Legacy controls under the name (the Admin checkbox without Team roles). */
  extra?: ReactNode;
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
          <div data-testid="team-row-subtitle" className="min-w-0 break-words text-[13px] leading-[18px] text-gray-500">{subtitle}</div>
          {extra}
        </div>
      </div>
      {lanes}
      <div className="col-start-2 row-start-1 flex w-7 justify-end lg:col-auto lg:row-auto" data-team-action>{action}</div>
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
