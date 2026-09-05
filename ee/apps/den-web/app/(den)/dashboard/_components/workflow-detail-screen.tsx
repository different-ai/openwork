"use client";

import { ArrowLeft, CalendarClock } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenChip, type DenChipTone } from "../../_components/ui/chip";
import { DenNotice } from "../../_components/ui/notice";
import { DenPageHeader } from "../../_components/ui/page-header";
import { type TabItem, UnderlineTabs } from "../../_components/ui/tabs";
import { useDenFlow } from "../../_providers/den-flow-provider";
import { getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { usePluginAccess } from "./plugin-access-data";
import { PluginAccessSection } from "./plugin-access-section";
import { usePlugin } from "./plugin-data";
import { useWorkflowDetailState } from "./use-workflow-detail-state";
import { WorkflowEditTab } from "./workflow-edit-tab";
import { WorkflowOverviewTab } from "./workflow-overview-tab";
import { WorkflowRunsTab } from "./workflow-runs-tab";
import { WorkflowSharingTab } from "./workflow-sharing-tab";

type WorkflowDetailTab = "overview" | "runs" | "edit" | "sharing";

function freshnessLabel(state: "never_run" | "fresh" | "stale" | "needs_attention"): string {
  if (state === "fresh") return "Up to date";
  if (state === "stale") return "Last run was a while ago";
  if (state === "needs_attention") return "Needs attention";
  return "Not run yet";
}

function stateLabel(state: "ready" | "needs_signin" | "needs_admin_setup") {
  if (state === "needs_signin") return "Needs your sign-in";
  if (state === "needs_admin_setup") return "Needs admin setup";
  return "Ready";
}

function stateTone(state: "ready" | "needs_signin" | "needs_admin_setup"): DenChipTone {
  if (state === "ready") return "success";
  if (state === "needs_admin_setup") return "danger";
  return "warning";
}

function updatedDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function readTab(value: string | null, manager: boolean): WorkflowDetailTab {
  if (value === "runs" || value === "sharing" || value === "overview") return value;
  if (value === "edit" && manager) return value;
  return "overview";
}

export function WorkflowDetailScreen({ workflowId }: { workflowId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { runtimeConfig } = useDenFlow();
  const { orgContext } = useOrgDashboard();
  const state = useWorkflowDetailState(workflowId);
  const pluginId = state.libraryDetail?.workflow.plugin?.id ?? "";
  const pluginAccessQuery = usePluginAccess(pluginId);
  const pluginQuery = usePlugin(pluginId);
  const orgAccess = getOrgAccessFlags(
    orgContext?.currentMember.role ?? "member",
    orgContext?.currentMember.isOwner ?? false,
    orgContext?.roles ?? [],
  );

  if (state.loading || !state.libraryDetail || !state.detail || !state.fields) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8" data-testid="den-workflow-detail">
        <DenCard>{state.error ?? "Loading workflow…"}</DenCard>
      </div>
    );
  }

  const { workflow } = state.libraryDetail;
  const manager = workflow.role === "manager" && state.detail.canManage;
  const canEdit = state.detail.canManage || workflow.role === "editor" || orgAccess.isAdmin;
  const activeTab = readTab(searchParams.get("tab"), manager);
  const tabs: readonly TabItem<WorkflowDetailTab>[] = manager
    ? [
        { value: "overview", label: "Overview" },
        { value: "runs", label: "Runs", count: state.snapshots.length },
        { value: "edit", label: "Edit" },
        { value: "sharing", label: "Sharing" },
      ]
    : [
        { value: "overview", label: "Overview" },
        { value: "runs", label: "Runs", count: state.snapshots.length },
        { value: "sharing", label: "Sharing" },
      ];
  const automateHref = `${runtimeConfig.openworkWebUrl.replace(/\/$/, "")}/automations?create=1&workflow=${encodeURIComponent(workflowId)}&version=${encodeURIComponent(state.detail.currentVersion.id)}`;

  function changeTab(next: WorkflowDetailTab) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  const pluginAccess = workflow.plugin ? (
    <PluginAccessSection
      pluginId={workflow.plugin.id}
      pluginCreatedByOrgMembershipId={pluginQuery.data?.createdByOrgMembershipId ?? null}
      grants={pluginAccessQuery.data ?? []}
      isLoading={pluginAccessQuery.isLoading || pluginQuery.isLoading}
      error={pluginAccessQuery.error ?? pluginQuery.error}
    />
  ) : null;

  return (
    <div className="mx-auto grid max-w-[1180px] gap-6 px-6 py-8 md:px-8" data-testid="den-workflow-detail">
      <DenButton
        variant="ghost"
        size="sm"
        icon={ArrowLeft}
        className="justify-self-start"
        href="/dashboard/library"
      >
        Back to Library
      </DenButton>

      <DenPageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>{workflow.name}</span>
            <DenChip tone="teal">Workflow</DenChip>
            <DenChip tone={stateTone(workflow.state)}>{stateLabel(workflow.state)}</DenChip>
          </span>
        }
        description={
          <span>
            {workflow.description || "A saved, repeatable workflow you can run, schedule, and share."}
            {workflow.plugin ? <span className="mt-1 block text-[12px] text-gray-400">Shared through {workflow.plugin.name}.</span> : null}
          </span>
        }
        action={manager ? (
          <DenButton href={automateHref} target="_blank" rel="noopener noreferrer" icon={CalendarClock}>
            Automate
          </DenButton>
        ) : null}
        caption={`${freshnessLabel(workflow.resultState)} · Updated ${updatedDate(state.detail.currentVersion.createdAt)}`}
      />

      {state.error ? <DenNotice tone="error" message={state.error} /> : null}
      {state.detail.freshness.state === "needs_attention" ? (
        <DenNotice
          tone="warning"
          message={`${state.detail.freshness.reason} You can still open the last successful result.`}
        />
      ) : null}

      <div data-testid="den-workflow-tabs">
        <UnderlineTabs tabs={tabs} activeTab={activeTab} onChange={changeTab} showZeroCounts />
      </div>

      <div data-testid="den-workflow-detail-panel">
        {activeTab === "overview" ? (
          <WorkflowOverviewTab
            detail={state.detail}
            fields={state.fields}
            views={state.views}
            technical={state.technical}
            showJsonInput={state.showJsonInput}
            parsedInputSchema={state.parsedInputSchema}
            hasInputForm={state.hasInputForm}
            inputFormValue={state.inputFormValue}
            pending={state.pending}
            viewPending={state.viewPending}
            canManageDisplays={manager}
            onTechnicalChange={state.setTechnical}
            onShowJsonInputChange={state.setShowJsonInput}
            onInputChange={(value) => state.update("input", value)}
            onRun={state.runNow}
            onActivateView={state.activateView}
            onRetireView={state.retireView}
          />
        ) : null}

        {activeTab === "runs" ? (
          <WorkflowRunsTab
            detail={state.detail}
            snapshots={state.snapshots}
            selectedSnapshot={state.selectedSnapshot}
            selectedReceiptId={state.selectedReceiptId}
            technical={state.technical}
            pending={state.pending}
            automationCount={workflow.automationCount}
            automateHref={manager ? automateHref : null}
            onTechnicalChange={state.setTechnical}
            onSelectRun={state.setSelectedReceiptId}
            onDeleteRun={state.deleteSnapshot}
            onUpdateAutomation={state.updateAutomation}
          />
        ) : null}

        {activeTab === "edit" && manager ? (
          <WorkflowEditTab
            detail={state.detail}
            fields={state.fields}
            parsedInputSchema={state.parsedInputSchema}
            hasInputForm={state.hasInputForm}
            inputFormValue={state.inputFormValue}
            tested={state.tested}
            fingerprint={state.fingerprint}
            pending={state.pending}
            onUpdate={state.update}
            onTest={state.testChanges}
            onSave={state.saveNewVersion}
          />
        ) : null}

        {activeTab === "sharing" ? (
          <WorkflowSharingTab canEdit={canEdit} pluginAccess={pluginAccess} />
        ) : null}
      </div>
    </div>
  );
}
