/** @jsxImportSource react */
import type { ComponentType, ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import {
  iconTileClass,
  interactiveCardClass,
  sectionBodyClass,
  sectionTitleClass,
} from "./modal-styles";

export type WorkspaceOptionCardProps = {
  title: string;
  description: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  onClick?: () => void;
  disabled?: boolean;
  endAdornment?: ReactNode;
};

export function WorkspaceOptionCard({
  title,
  description,
  icon: Icon,
  onClick,
  disabled,
  endAdornment,
}: WorkspaceOptionCardProps) {
  return (
    <button
      type="button"
      onClick={() => onClick?.()}
      disabled={disabled}
      className={`${interactiveCardClass} group flex w-full items-center gap-4 disabled:cursor-not-allowed disabled:opacity-60`}
    >
      <div className={iconTileClass}>
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={sectionTitleClass}>{title}</div>
        <div className={sectionBodyClass}>{description}</div>
      </div>
      {endAdornment ?? (
        <ChevronRight
          size={18}
          className="shrink-0 text-dls-secondary transition-transform group-hover:translate-x-0.5"
        />
      )}
    </button>
  );
}
