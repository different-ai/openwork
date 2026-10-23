"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Braces, ChevronRight, KeyRound, Lock, Plus, Search } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenChip } from "../../_components/ui/chip";
import { DenInput } from "../../_components/ui/input";
import { DenList, DenListRow } from "../../_components/ui/list-row";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import {
  getEnvironmentVariableRoute,
  getNewEnvironmentVariableRoute,
  getOrgAccessFlags,
  orgFeatureEnabled,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  audienceSummary,
  useOrgEnvironmentVariables,
  valueSummary,
} from "./environment-variable-data";

function ListSkeleton() {
  return (
    <DenList>
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3 px-6 py-4" aria-hidden>
          <div className="grid flex-1 gap-2">
            <DenSkeleton className="h-4 w-48" />
            <DenSkeleton className="h-3 w-72" />
          </div>
        </div>
      ))}
    </DenList>
  );
}

export function EnvironmentVariablesScreen() {
  const { orgSlug, orgContext } = useOrgDashboard();
  const enabled = orgFeatureEnabled(orgContext, "environmentVariables");
  const access = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.currentMember.permissions);
  const { data, error, loading, reload } = useOrgEnvironmentVariables(enabled && access.canViewEnvironmentVariables);
  const [query, setQuery] = useState("");
  const canManage = data?.canManage ?? access.canManageEnvironmentVariables;

  const variables = useMemo(() => {
    const all = data?.environmentVariables ?? [];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return all;
    return all.filter((variable) => variable.name.toLowerCase().includes(normalized) || variable.key.toLowerCase().includes(normalized));
  }, [data, query]);

  const addButton = canManage ? (
    <Link href={getNewEnvironmentVariableRoute(orgSlug)} className={buttonVariants({ variant: "primary" })} data-testid="environment-variable-create">
      <Plus className="h-4 w-4" aria-hidden />
      Add variable
    </Link>
  ) : (
    <DenButton variant="secondary" disabled title="An organization owner or admin can add environment variables.">
      <Lock className="h-4 w-4" aria-hidden />
      Add variable
    </DenButton>
  );

  return (
    <DashboardPageTemplate
      icon={Braces}
      title="Environment Variables"
      description="Added to the environment of every recipient's desktop agent."
    >
      {!enabled ? (
        <DenNotice tone="info" message="Environment variables aren't turned on for this organization yet." />
      ) : (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1">
              <DenInput type="search" icon={Search} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search variables" aria-label="Search variables" />
            </div>
            {addButton}
          </div>

          {loading && !data ? (
            <ListSkeleton />
          ) : error ? (
            <div className="flex flex-col items-start gap-3">
              <DenNotice tone="error" message={`${error} Check your connection and try again.`} />
              <DenButton variant="secondary" onClick={() => void reload()}>Try again</DenButton>
            </div>
          ) : variables.length > 0 ? (
            <DenList>
              {variables.map((variable) => {
                const values = valueSummary(variable);
                return (
                  <DenListRow
                    key={variable.id}
                    href={getEnvironmentVariableRoute(orgSlug, variable.id)}
                    dataAttributes={{ "data-testid": "environment-variable-row" }}
                    title={variable.name}
                    chips={
                      <>
                        <DenChip mono>{variable.key}</DenChip>
                        {values.missing ? <DenChip tone="warning" icon={KeyRound}>No value yet</DenChip> : null}
                      </>
                    }
                    meta={values.missing ? audienceSummary(variable) : `${values.text} · ${audienceSummary(variable)}`}
                    action={<ChevronRight aria-hidden className="h-4 w-4 text-gray-500" />}
                  />
                );
              })}
            </DenList>
          ) : query ? (
            <p className="text-[14px] text-gray-500">No variables match &quot;{query}&quot;.</p>
          ) : (
            <div className="rounded-[16px] border border-dashed border-gray-200 px-6 py-8 text-[14px] text-gray-500">
              {canManage
                ? "No environment variables yet. Add one to give people's agents an API key, a URL or any other setting."
                : "No environment variables yet. An organization owner or admin can add them."}
            </div>
          )}
        </div>
      )}
    </DashboardPageTemplate>
  );
}
