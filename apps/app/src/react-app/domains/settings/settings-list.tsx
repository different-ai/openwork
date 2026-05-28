/** @jsxImportSource react */
import type * as React from "react";
import { cn } from "@/lib/utils";
import { SettingsInset } from "./settings-section";
import { SearchIcon } from "lucide-react"

import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"

export interface SettingsListProps {
  children: React.ReactNode;
  className?: string;
}

export function SettingsList({ children, className }: SettingsListProps) {
  return <div className={cn("flex flex-col gap-y-2", className)}>{children}</div>;
}

interface SettingsListEmptyStateProps {
  children: React.ReactNode;
  className?: string;
}

export function SettingsListEmptyState({ children, className }: SettingsListEmptyStateProps) {
  return (
    <SettingsInset className={cn("border-dashed py-6 text-center text-sm text-muted-foreground", className)}>
      {children}
    </SettingsInset>
  );
}


export interface SettingsListTitleProps {
  children: React.ReactNode;
}

export function SettingsListTitle({ children }: SettingsListTitleProps) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export interface SettingsListItemTitleProps {
  children: React.ReactNode;
}

export function SettingsListItemTitle({ children }: SettingsListItemTitleProps) {
  return <span className="truncate font-medium text-dls-text">{children}</span>;
}

export interface SettingsListItemProps {
  children: React.ReactNode;
  className?: string;
}

export function SettingsListItem({ children, className }: SettingsListItemProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-muted/10 hover:border-border border border-transparent",
        className,
      )}
    >
      {children}
    </div>
  );
}

interface SettingsListItemContentProps {
  children: React.ReactNode;
  className?: string;
}

export function SettingsListItemContent({ children, className }: SettingsListItemContentProps) {
  return <div className={cn("flex min-w-0 flex-col gap-y-1 pr-4", className)}>{children}</div>;
}

interface SettingsListItemActionsProps {
  children: React.ReactNode;
  className?: string;
}

export function SettingsListItemActions({ children, className }: SettingsListItemActionsProps) {
  return <div className={cn("flex shrink-0 items-center gap-2", className)}>{children}</div>;
}

interface SettingsListItemDescriptionProps {
  children: React.ReactNode;
  className?: string;
}

export function SettingsListItemDescription({ children, className }: SettingsListItemDescriptionProps) {
  return <div className={cn("mt-0.5 text-muted-foreground text-xs truncate", className)}>{children}</div>;
}

export function SettingsListSearchInput({
  placeholder = "Search...",
  ...props
}: React.ComponentProps<"input">) {
  return (
    <InputGroup>
      <InputGroupInput placeholder={placeholder} {...props} />
      <InputGroupAddon align="inline-start">
        <SearchIcon className="text-muted-foreground" />
      </InputGroupAddon>
    </InputGroup>
  )
}
