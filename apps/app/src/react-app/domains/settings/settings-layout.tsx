import * as React from "react";
import { cn } from "@/lib/utils";

export interface LayoutStackProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutStack({ children, className }: LayoutStackProps) {
  return <div className={cn("@container/settings flex w-full max-w-3xl flex-col gap-y-6", className)}>{children}</div>;
}

interface LayoutSectionProps {
  children: React.ReactNode;
}

export function LayoutSection({ children }: LayoutSectionProps) {
  return (
    <div data-section className="group/section flex flex-col gap-6">
      {children}
    </div>
  );
}

interface LayoutSectionHeaderProps {
  children: React.ReactNode;
}

export function LayoutSectionHeader({ children }: LayoutSectionHeaderProps) {
  return (
    <div className="flex flex-col gap-1">
      {children}
    </div>
  );
}

interface LayoutSectionTitleProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionTitle({ children, className }: LayoutSectionTitleProps) {
  return (
    <h3 className={cn("flex items-center gap-2 text-base font-medium text-foreground", className)}>
      {children}
    </h3>
  );
}

interface LayoutSectionDescriptionProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionDescription({ children, className }: LayoutSectionDescriptionProps) {
  return (
    <p className={cn("text-sm text-muted-foreground", className)}>
      {children}
    </p>
  );
}

interface LayoutSectionContentProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionContent({ children, className }: LayoutSectionContentProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {children}
    </div>
  );
}

interface LayoutSectionItemProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItem({ children, className }: LayoutSectionItemProps) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {children}
    </div>
  );
}

interface LayoutSectionItemHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemHeader({ children, className }: LayoutSectionItemHeaderProps) {
  return (
    <div className={cn("grid auto-rows-min items-start gap-y-1 gap-x-3 has-data-[slot=item-header-actions]:grid-cols-[1fr_auto]", className)}>
      {children}
    </div>
  );
}

interface LayoutSectionItemTitleProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemTitle({ children, className }: LayoutSectionItemTitleProps) {
  return (
    <h4 data-slot="item-title" className={cn("flex items-center gap-2 text-base font-medium text-foreground group-data-section/section:text-sm", className)}>
      {children}
    </h4>
  );
}

interface LayoutSectionItemDescriptionProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemDescription({ children, className }: LayoutSectionItemDescriptionProps) {
  return (
    <p data-slot="item-description" className={cn("text-sm text-muted-foreground", className)}>
      {children}
    </p>
  );
}

interface LayoutSectionItemHeaderActionsProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemHeaderActions({ children, className }: LayoutSectionItemHeaderActionsProps) {
  return (
    <div data-slot="item-header-actions" className={cn("col-start-2 row-span-2 row-start-1 flex flex-wrap items-center gap-2 self-start justify-self-end", className)}>
      {children}
    </div>
  );
}

interface LayoutSectionItemContentProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemContent({ children, className }: LayoutSectionItemContentProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      {children}
    </div>
  );
}

interface LayoutSectionItemFootnoteProps {
  children: React.ReactNode;
  className?: string;
}

export function LayoutSectionItemFootnote({ children, className }: LayoutSectionItemFootnoteProps) {
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      {children}
    </p>
  );
}