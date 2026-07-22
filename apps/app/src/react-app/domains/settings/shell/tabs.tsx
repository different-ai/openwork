/** @jsxImportSource react */
import type * as React from "react";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";

type TabsSidebarProps = {
  children: React.ReactNode;
};

export function TabsSidebar(props: TabsSidebarProps) {
  return (
    <aside className={cn("space-y-6 md:sticky md:top-4 md:self-start")}>{props.children}</aside>
  );
}

type TabsGroupProps = {
  children: React.ReactNode;
};

export function TabsGroup(props: TabsGroupProps) {
  return (
    <div className={cn("rounded-[24px] border border-dls-border bg-dls-sidebar p-3")}>
      {props.children}
    </div>
  );
}

type TabsGroupTitleProps = {
  children: React.ReactNode;
};

export function TabsGroupTitle(props: TabsGroupTitleProps) {
  return (
    <div className={cn("mb-2 px-2 text-[11px] font-medium uppercase tracking-[0.18em] text-gray-8")}>
      {props.children}
    </div>
  );
}

type TabsListProps = {
  children: React.ReactNode;
};

export function TabsList(props: TabsListProps) {
  return <div className={cn("space-y-1")}>{props.children}</div>;
}

type TabsTriggerProps = {
  active: boolean;
  onSelect: () => void;
  children: React.ReactNode;
  beta?: boolean;
};

export function TabsTrigger(props: TabsTriggerProps) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] font-medium transition-colors text-gray-10 hover:bg-dls-surface/50 hover:text-dls-text",
        props.active &&
          "bg-dls-surface text-dls-text shadow-sm hover:bg-dls-surface hover:text-dls-text",
      )}
      onClick={props.onSelect}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span>{props.children}</span>
        {props.beta ? (
          <span className="shrink-0 rounded-full border border-amber-6/40 bg-amber-3/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-11">
            {t("common.beta")}
          </span>
        ) : null}
      </span>
    </button>
  );
}
