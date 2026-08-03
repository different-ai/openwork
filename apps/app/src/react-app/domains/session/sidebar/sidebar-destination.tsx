/** @jsxImportSource react */
import type { ComponentType, ReactNode } from "react";

import {
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

type SidebarDestinationProps = {
  active: boolean;
  icon: ComponentType<{ className?: string }>;
  label: string;
  labelContent?: ReactNode;
  onSelect: () => void;
};

export function SidebarDestination({ active, icon: Icon, label, labelContent, onSelect }: SidebarDestinationProps) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        type="button"
        isActive={active}
        aria-current={active ? "page" : undefined}
        aria-label={label}
        tooltip={label}
        className="text-sidebar-foreground/70"
        onClick={onSelect}
      >
        <Icon />
        {labelContent ?? <span>{label}</span>}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
