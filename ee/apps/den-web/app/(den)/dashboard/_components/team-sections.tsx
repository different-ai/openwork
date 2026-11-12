"use client";

import type { ReactNode } from "react";
import { type TabItem, UnderlineTabs, UnseenDot } from "../../_components/ui/tabs";
import { orgFeatureEnabled, type DenOrgContext } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { groupTeamSections } from "./team-section-groups";

/** Width of a team's page and Everyone's page: wider with the sidebar, so the sections keep their room. */
export function teamPageWidthClass(sidebar: boolean) {
  return sidebar ? "max-w-[860px] md:max-w-[1100px]" : "max-w-[860px]";
}

/** A team's page and Everyone's page list their sections in a sidebar with `teamSettingsSidebar` on. */
export function teamSectionsSidebarEnabled(orgContext: DenOrgContext | null): boolean {
  return Boolean(orgContext) && orgFeatureEnabled(orgContext, "teamSettingsSidebar");
}

/** Sections explain themselves (a heading with an "i", and what an empty state means) with `teamSettingsSidebar` on. */
export function useTeamSectionsHelp(): boolean {
  return teamSectionsSidebarEnabled(useOrgDashboard().orgContext);
}

/**
 * The sections of a team's page (or Everyone's) and the chosen one's body.
 * A row of tabs across the top, or with `sidebar` a grouped list on the left
 * from medium screens up; narrow screens keep the row of tabs.
 */
export function TeamSections<T extends string>({ sidebar, tabs, activeTab, onChange, children }: {
  sidebar: boolean;
  tabs: readonly TabItem<T>[];
  activeTab: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  const row = <UnderlineTabs className="mt-6" tabs={tabs} activeTab={activeTab} onChange={onChange} />;
  if (!sidebar) return <>{row}<div className="mt-6">{children}</div></>;

  return (
    <>
      <div className="md:hidden">{row}</div>
      <div className="mt-6 md:mt-8 md:flex md:items-start md:gap-10">
        <nav aria-label="Sections" className="hidden w-[200px] shrink-0 md:sticky md:top-6 md:grid md:gap-5" data-testid="team-sections-sidebar">
          {groupTeamSections(tabs).map((group) => (
            <div key={group.label}>
              <p id={`team-sections-${group.label}`} className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-gray-500">
                {group.label}
              </p>
              <div role="tablist" aria-orientation="vertical" aria-labelledby={`team-sections-${group.label}`} className="grid gap-0.5">
                {group.items.map(({ value, label, icon: Icon, unseen }) => {
                  const selected = activeTab === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => onChange(value)}
                      className={`flex min-w-0 items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-[13px] font-medium tracking-[-0.1px] transition-colors ${
                        selected ? "bg-gray-100 text-gray-900" : "text-gray-500 hover:bg-gray-50 hover:text-gray-700"
                      }`}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
                        <span className="min-w-0 truncate">{label}</span>
                      </span>
                      {unseen && !selected ? <UnseenDot /> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </>
  );
}
