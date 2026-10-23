/** @jsxImportSource react */
import { cn } from "@/lib/utils";

/** The blue mark for something an organization deploys from OpenWork Cloud. */
export function ManagedInDenBadge({ className, label = "Managed in Den" }: { className?: string; label?: string }) {
  return (
    <span data-testid="managed-in-den-badge" className={cn("shrink-0 rounded-full bg-blue-3 px-2 py-0.5 text-xs font-medium text-blue-11", className)}>
      {label}
    </span>
  );
}
