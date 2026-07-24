/** @jsxImportSource react */
import { DotMatrixLoader } from "@/components/ui/dot-matrix-loader";
import { cn } from "@/lib/utils";

type SessionDotMatrixLoaderProps = {
  className?: string;
  label: string;
};

/** Sidebar left-lane activity indicator — shared dot-matrix in the fixed slot. */
export function SessionDotMatrixLoader({ className, label }: SessionDotMatrixLoaderProps) {
  return (
    <DotMatrixLoader
      data-session-loading-indicator
      label={label}
      className={cn("text-sidebar-foreground", className)}
    />
  );
}
