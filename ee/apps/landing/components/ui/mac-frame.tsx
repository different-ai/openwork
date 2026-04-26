import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface MacFrameProps {
  title?: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/**
 * macOS-style window chrome — used for product screenshots in the home page.
 * Subtle border + dot row; tracks the theme via tokens.
 */
export function MacFrame({ title, children, className, bodyClassName }: MacFrameProps) {
  return (
    <div
      className={cn(
        "bg-surface-card border-border-soft rounded-[1.2rem] border overflow-hidden",
        "shadow-[0_40px_80px_-40px_rgba(0,0,0,0.25),0_0_0_1px_rgba(0,0,0,0.02)]",
        className
      )}
    >
      <div className="lin-mac-bar">
        <span className="lin-mac-dot" style={{ background: "#ef4444" }} />
        <span className="lin-mac-dot" style={{ background: "#eab308" }} />
        <span className="lin-mac-dot" style={{ background: "#22c55e" }} />
        {title ? (
          <span className="text-foreground/60 mx-auto font-sans text-[1.2rem] font-medium">
            {title}
          </span>
        ) : null}
      </div>
      <div className={cn("bg-surface-card", bodyClassName)}>{children}</div>
    </div>
  );
}

export default MacFrame;
