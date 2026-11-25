"use client";

import { useId, type ReactNode } from "react";
import type { WorkbotProactiveSettingsInput } from "@openwork/types/den/workbot-proactive";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import type { AgentPolicyScope } from "./workbot-agent-scope";
import type { WorkbotAgentsPart } from "./workbot-settings-tabs-model";
import { useSaveWorkbotProactive, useWorkbotProactive } from "./workbot-proactive-data";
import { WorkbotProactiveSources } from "./workbot-proactive-sources";
import { WorkbotAgentSettingsGroups } from "./workbot-agent-settings-groups";
import { getLibraryConnectorRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const EVERYONE: AgentPolicyScope = { kind: "everyone" };

function PanelSkeleton() {
  return (
    <div className="divide-y divide-gray-100 overflow-hidden rounded-2xl border border-gray-100 bg-white" data-testid="workbot-proactive-skeleton">
      {["w-36", "w-32", "w-28", "w-28", "w-32", "w-28", "w-40", "w-32", "w-24", "w-28"].map((width, index) => (
        <div key={index} className="flex min-h-[66px] items-center justify-between gap-3 px-6 py-3">
          <DenSkeleton className={`h-4 ${width}`} />
          <DenSkeleton className="h-[42px] w-36" />
        </div>
      ))}
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export function WorkbotProactiveSection({ orgId, canManage, connectorsHref, scope = EVERYONE, headerAside, belowHeader, busy = false, onEdit, show = "all" }: {
  show?: WorkbotAgentsPart;
  orgId: string;
  canManage: boolean;
  connectorsHref: string;
  scope?: AgentPolicyScope;
  headerAside?: ReactNode;
  belowHeader?: ReactNode;
  busy?: boolean;
  onEdit?: () => void;
}) {
  const query = useWorkbotProactive(orgId, Boolean(orgId), scope);
  const { orgSlug } = useOrgDashboard();
  const save = useSaveWorkbotProactive(orgId, scope);
  const headingId = useId();
  const saving = save.isPending || busy;
  const change = (next: WorkbotProactiveSettingsInput) => {
    onEdit?.();
    save.mutate(next);
  };
  const inTab = show !== "all";
  const heading = <h2 id={headingId} className="px-1 text-[13px] font-medium text-gray-500">{inTab ? (show === "sources" ? "Connectors" : "Proactive Mode") : "Members' agents"}</h2>;

  return (
    <section aria-labelledby={inTab && !headerAside ? undefined : headingId} aria-label={inTab && !headerAside ? (show === "sources" ? "Connectors" : "Proactive Mode") : undefined} className="grid gap-2" data-section="workbot-proactive">
      {inTab && !headerAside ? null : headerAside ? (
        <div className="flex min-h-6 flex-wrap items-center justify-between gap-3 pr-1">
          {heading}
          <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">{headerAside}</div>
        </div>
      ) : heading}
      {belowHeader}
      {query.isError ? (
        <DenNotice
          tone="error"
          message={errorMessage(query.error, "Couldn't load agent settings.")}
          action={(
            <DenButton variant="secondary" size="sm" loading={query.isFetching} onClick={() => void query.refetch()}>
              Try again
            </DenButton>
          )}
        />
      ) : query.data ? (
        <div className="grid gap-6">
          {show === "sources" ? null : (
            <WorkbotAgentSettingsGroups
              view={query.data}
              canManage={canManage}
              saving={saving}
              connectorsHref={connectorsHref}
              onChange={change}
              scope={scope}
            />
          )}
          {show === "policy" ? null : (
            <WorkbotProactiveSources view={query.data} canManage={canManage} saving={saving} onChange={change} heading={show !== "sources"}
              tools={{ orgId, scope, connectorHref: (connectionId) => getLibraryConnectorRoute(orgSlug, connectionId) }} />
          )}
        </div>
      ) : (
        <PanelSkeleton />
      )}
      {save.isError ? (
        <p role="alert" className="px-1 text-[13px] text-red-700">{errorMessage(save.error, "Couldn't save. Try again.")}</p>
      ) : null}
    </section>
  );
}
