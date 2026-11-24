"use client";

import Link from "next/link";
import type { ComponentType } from "react";
import { ADMIN_LIMIT_KINDS, type AdminLimitKind } from "@openwork/types/den/admin-limits";
import { WorkspaceCreationLimits } from "./workspace-creation-limits";

/** One panel per limit kind. Add a kind to ADMIN_LIMIT_KINDS and its panel here. */
const PANELS: Record<AdminLimitKind, ComponentType> = {
  "workspace-creation": WorkspaceCreationLimits,
};

export function LimitsPage({ kind }: { kind: AdminLimitKind }) {
  const Panel = PANELS[kind];
  const current = ADMIN_LIMIT_KINDS.find(entry => entry.key === kind);
  return <section className="min-w-0 text-[color:var(--dls-text-primary)]" data-testid="admin-limits">
    <h1 className="mb-2 text-base font-medium">Limits</h1>
    <nav aria-label="Limit kinds" className="mb-5 flex gap-5 overflow-x-auto border-b border-[var(--dls-border)] text-sm">
      {ADMIN_LIMIT_KINDS.map(entry => <Link key={entry.key} prefetch={false} href={`/admin/limits/${entry.key}`} aria-current={entry.key === kind ? "page" : undefined}
        className={`shrink-0 border-b-2 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 ${entry.key === kind ? "border-current font-medium text-[var(--dls-text-primary)]" : "border-transparent text-[var(--dls-text-secondary)] hover:text-[var(--dls-text-primary)]"}`}>
        {entry.label}
      </Link>)}
    </nav>
    {current ? <p className="mb-5 max-w-2xl text-sm text-[color:var(--dls-text-secondary)]">{current.description}</p> : null}
    <Panel />
  </section>;
}
