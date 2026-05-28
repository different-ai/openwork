/** @jsxImportSource react */
import type * as React from "react";
import { RefreshCcw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type SettingsContentProps = {
  children: React.ReactNode;
};

export function SettingsContent(props: SettingsContentProps) {
  return <div className="min-w-0 min-h-0 flex-1 overflow-y-auto flex flex-col gap-6 p-4 md:gap-8 md:p-6 lg:p-8 items-center">{props.children}</div>;
}

type SettingsPanelProps = {
  children: React.ReactNode;
};

export function SettingsPanel(props: SettingsPanelProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 md:flex-row md:items-center md:justify-between lg:max-w-3xl w-full",
      )}
    >
      {props.children}
    </div>
  );
}

type SettingsPanelHeadingProps = {
  children: React.ReactNode;
  className?: string;
};

export function SettingsPanelHeading(props: SettingsPanelHeadingProps) {
  return <div className={cn("flex flex-col gap-y-1", props.className)}>{props.children}</div>;
}

type SettingsPanelTitleProps = {
  children: React.ReactNode;
  className?: string;
};

export function SettingsPanelTitle(props: SettingsPanelTitleProps) {
  return <h2 className={cn("text-xl font-semibold tracking-tight", props.className)}>{props.children}</h2>;
}

type SettingsPanelDescriptionProps = {
  children: React.ReactNode;
};

export function SettingsPanelDescription(props: SettingsPanelDescriptionProps) {
  return <p className="text-sm text-muted-foreground">{props.children}</p>;
}

type SettingsPanelToolbarProps = {
  children: React.ReactNode;
};

export function SettingsPanelToolbar(props: SettingsPanelToolbarProps) {
  return <div className="mt-4 flex flex-col gap-y-2 md:mt-0 md:max-w-sm md:text-right">{props.children}</div>;
}

type SettingsPanelToolbarActionsProps = {
  children: React.ReactNode;
};

export function SettingsPanelToolbarActions(props: SettingsPanelToolbarActionsProps) {
  return <div className="flex flex-wrap items-center gap-2 md:justify-end">{props.children}</div>;
}

type SettingsPanelToolbarStatusProps = {
  tone?: string;
  title?: string;
  spinning?: boolean;
  children: React.ReactNode;
};

export function SettingsPanelToolbarStatus(props: SettingsPanelToolbarStatusProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-sm",
        props.tone ?? "bg-gray-4/60 text-gray-11 border-gray-7/50",
      )}
      title={props.title}
    >
      {props.spinning ? <RefreshCcw size={12} className="animate-spin" /> : null}
      <span className="tabular-nums whitespace-nowrap">{props.children}</span>
    </div>
  );
}

type SettingsPanelToolbarButtonProps = {
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
};

export function SettingsPanelToolbarButton(props: SettingsPanelToolbarButtonProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </Button>
  );
}

type SettingsPanelToolbarMessageProps = {
  children: React.ReactNode;
};

export function SettingsPanelToolbarMessage(props: SettingsPanelToolbarMessageProps) {
  return <div className="text-xs leading-relaxed text-amber-11/90 md:max-w-sm">{props.children}</div>;
}
