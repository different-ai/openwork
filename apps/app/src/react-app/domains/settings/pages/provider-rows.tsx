import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { resolveExtensionIconSrc } from "@/react-app/design-system/extension-icon-src";

// Shared rows for Settings › AI Providers and the Connect a provider sheet,
// so both surfaces render a provider the same way (Paper boards 09–11).

export type ProviderStatusTone = "ready" | "attention" | "neutral" | "error";

/** A provider mark in a rounded tile; OpenWork's own mark sits on a filled tile. */
export function ProviderTile({ providerId, name, size = "md" }: { providerId: string; name?: string; size?: "sm" | "md" }) {
  const filled = providerId === "openwork";
  return (
    <div className={cn(
      "flex shrink-0 items-center justify-center overflow-hidden border shadow-sm",
      size === "md" ? "size-10 rounded-xl" : "size-9 rounded-[11px]",
      filled ? "border-transparent bg-dls-text text-dls-surface" : "border-dls-border bg-dls-surface text-dls-text",
    )}>
      {filled
        ? <img src={resolveExtensionIconSrc("/openwork-mark.svg")} alt="" className={cn("brightness-0 invert dark:invert-0", size === "md" ? "size-5" : "size-[18px]")} />
        : <ProviderIcon providerId={providerId} providerName={name} size={size === "md" ? 20 : 18} />}
    </div>
  );
}

/** "● Ready to use" style status; attention renders as a soft pill. */
export function ProviderStatus({ tone, children }: { tone: ProviderStatusTone; children: ReactNode }) {
  if (tone === "attention") {
    return <span className="rounded-full bg-amber-3 px-2 py-0.5 text-xs font-medium text-amber-11">{children}</span>;
  }
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 text-xs",
      tone === "ready" ? "text-green-11" : tone === "error" ? "text-red-11" : "text-muted-foreground",
    )}>
      <span aria-hidden className={cn(
        "size-1.5 rounded-full",
        tone === "ready" ? "bg-green-9" : tone === "error" ? "bg-red-9" : "bg-gray-8",
      )} />
      {children}
    </span>
  );
}

/** One meta line: an optional monospace id, then plain parts joined by middle dots. */
export function ProviderMeta({ id, parts }: { id?: string; parts: ReadonlyArray<string | null | undefined | false> }) {
  const rest = parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0);
  return (
    <div className="truncate text-xs text-muted-foreground">
      {id ? <span className="font-mono">{id}</span> : null}
      {rest.length ? `${id ? " · " : ""}${rest.join(" · ")}` : null}
    </div>
  );
}

export function ProviderList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("overflow-hidden rounded-2xl border border-dls-border bg-dls-surface divide-y divide-dls-border", className)}>{children}</div>;
}

export function ProviderRow(props: {
  tile: ReactNode;
  name: string;
  status?: ReactNode;
  meta: ReactNode;
  /** Who can use it, shown before the actions (organization rows). */
  aside?: ReactNode;
  actions?: ReactNode;
  className?: string;
  testId?: string;
  scope?: "device" | "organization";
}) {
  return (
    <div className={cn("flex min-h-16 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3", props.className)} data-testid={props.testId} data-provider-scope={props.scope}>
      <div className="flex min-w-0 flex-1 basis-44 items-center gap-3">
        {props.tile}
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-dls-text">{props.name}</span>
            {props.status}
          </div>
          {props.meta}
        </div>
      </div>
      {props.aside ? <div className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground sm:flex">{props.aside}</div> : null}
      {props.actions ? <div className="ml-auto flex shrink-0 items-center gap-1">{props.actions}</div> : null}
    </div>
  );
}

/** Initials for an organization mark, e.g. "Different AI" → "DA". */
export function organizationInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words.slice(0, 2).map((word) => word[0]) : [...(words[0] ?? "").slice(0, 2)]).join("");
  return initials.toUpperCase() || "?";
}

export function OrganizationMark({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  return (
    <span aria-hidden className={cn(
      "inline-flex shrink-0 items-center justify-center rounded-full bg-dls-text font-semibold text-dls-surface",
      size === "md" ? "size-6 text-[10px]" : "size-5 text-[9px]",
    )}>{organizationInitials(name)}</span>
  );
}

/** A quiet group label with its count, e.g. "ON THIS DEVICE 2"; shown in capitals as in the Connect a provider design. */
export function ProviderSectionLabel({ id, count, children }: { id?: string; count?: number; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      <span id={id}>{children}</span>
      {count !== undefined ? <span className="tabular-nums">{count}</span> : null}
    </div>
  );
}
