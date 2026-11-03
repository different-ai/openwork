"use client";

import { DenSkeleton } from "../../_components/ui/skeleton";
import { ItemHeader, ItemPage } from "./item-header";

/** Preserve the connector's name/layout while its route loads; never simulate check results. */
export function ConnectorSetupFallback({ name, url }: { name?: string; url?: string }) {
  return <ItemPage testId="connector-setup-loading">
    <ItemHeader title={`Add ${name?.trim() || "a connector"}`} description={url ? <span className="break-all font-mono text-[13px]">{url}</span> : undefined} />
    <div className="flex flex-col gap-4" role="status" aria-label="Loading connector setup">
      <DenSkeleton className="h-5 w-28" />
      {[0, 1, 2].map((row) => <DenSkeleton key={row} className="h-12 w-full rounded-lg" />)}
    </div>
  </ItemPage>;
}
