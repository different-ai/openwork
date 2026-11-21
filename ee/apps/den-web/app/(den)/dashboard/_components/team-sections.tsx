"use client";

import type { ReactNode } from "react";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { DASHBOARD_PAGE_CLASS } from "../../_components/ui/dashboard-styles";
import { ItemHeader } from "./item-header";

export function TeamPageFrame({ title, memberCount, backHref, action, testId, children }: {
  title: string;
  memberCount: number;
  backHref: string;
  action?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <div className={DASHBOARD_PAGE_CLASS} data-testid={testId}>
      <div className="mx-auto max-w-[860px]">
        <ItemHeader compact back={{ href: backHref, label: "Teams" }} title={title} actions={action}
          state={<span data-testid="team-member-count">{memberCount} {memberCount === 1 ? "member" : "members"}</span>} />
        {children}
      </div>
    </div>
  );
}

export function TeamSections<T extends string>({ tabs, activeTab, onChange, children }: {
  tabs: readonly TabItem<T>[];
  activeTab: T;
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  return <><UnderlineTabs className="mt-6" tabs={tabs} activeTab={activeTab} onChange={onChange} /><div className="mt-6">{children}</div></>;
}
