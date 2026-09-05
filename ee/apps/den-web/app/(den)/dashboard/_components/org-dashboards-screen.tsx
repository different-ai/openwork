"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { LayoutDashboard, Loader2, Plus, Search } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenInput } from "../../_components/ui/input";
import { DenButton } from "../../_components/ui/button";
import { getManagedDashboardRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { DenCatalogList, DenCatalogRow } from "../../_components/ui/catalog-row";
import { CatalogIdentityTile } from "./catalog-identity-tile";
import { useCreateDashboard, useManagedDashboards } from "./org-dashboards-data";

function formatDashboardTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "recently";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export function OrgDashboardsScreen() {
  const { orgSlug } = useOrgDashboard();
  const router = useRouter();
  const { data: dashboards = [], isLoading, error } = useManagedDashboards();
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    const matches = normalizedQuery
      ? dashboards.filter((dashboard) => dashboard.name.toLowerCase().includes(normalizedQuery))
      : dashboards;
    return [...matches].sort((a, b) => a.name.localeCompare(b.name));
  }, [dashboards, normalizedQuery]);

  return (
    <DashboardPageTemplate
      icon={LayoutDashboard}
      title="Dashboards"
      description="Dashboards are curated sets of MCP apps. Assign one to people or teams and it appears on their desktop Dashboard after sign-in."
      colors={["#E0F2FE", "#0C4A6E", "#0EA5E9", "#BAE6FD"]}
    >
      <div className="mb-6 flex flex-col gap-3 sm:flex-row">
        <div className="min-w-0 flex-1">
          <DenInput
            type="search"
            icon={Search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search dashboards..."
          />
        </div>
        <DenButton icon={Plus} onClick={() => setCreateOpen(true)}>
          New dashboard
        </DenButton>
      </div>

      {error ? (
        <div className="mb-6 rounded-[24px] border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error instanceof Error ? error.message : "Failed to load dashboards."}
        </div>
      ) : null}

      {isLoading ? (
        <div className="rounded-2xl border border-gray-100 bg-white px-6 py-10 text-[14px] text-gray-500">
          Loading dashboards…
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
          <p className="text-[14px] font-medium text-gray-900">
            {dashboards.length === 0 ? "No dashboards yet" : "No dashboards match that search"}
          </p>
          <p className="mx-auto mt-1 max-w-md text-[13px] text-gray-500">
            {dashboards.length === 0
              ? "Create a dashboard, add MCP apps from your connectors, then assign it to people or teams."
              : "Try a different search term."}
          </p>
        </div>
      ) : (
        <DenCatalogList
          label={`${filtered.length} dashboard${filtered.length === 1 ? "" : "s"}`}
          valueLabel="Apps"
        >
          {filtered.map((dashboard) => (
            <DenCatalogRow
              key={dashboard.id}
              href={getManagedDashboardRoute(orgSlug, dashboard.id)}
              leading={<CatalogIdentityTile name={dashboard.name} logoUrl={null} />}
              title={dashboard.name}
              description={
                dashboard.elements.length === 0
                  ? <span className="text-gray-400">No apps yet</span>
                  : dashboard.elements.map((element) => element.title).join(", ")
              }
              value={String(dashboard.elements.length)}
              valueMuted={dashboard.elements.length === 0}
              valueCaption={`Updated ${formatDashboardTimestamp(dashboard.updatedAt)}`}
            />
          ))}
        </DenCatalogList>
      )}

      {createOpen ? (
        <CreateDashboardDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(dashboardId) => {
            setCreateOpen(false);
            router.push(getManagedDashboardRoute(orgSlug, dashboardId));
          }}
        />
      ) : null}
    </DashboardPageTemplate>
  );
}

function CreateDashboardDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (dashboardId: string) => void;
}) {
  const createMutation = useCreateDashboard();
  const [name, setName] = useState("");
  const trimmedName = name.trim();

  async function submit() {
    try {
      const created = await createMutation.mutateAsync({ name: trimmedName });
      setName("");
      onCreated(created.id);
    } catch {
      // The mutation error is rendered in the dialog.
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-dashboard-title"
        className="w-full max-w-[440px] rounded-2xl border border-gray-100 bg-white p-6 shadow-[0_24px_60px_-24px_rgba(15,23,42,0.4)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="create-dashboard-title" className="text-[16px] font-semibold tracking-[-0.01em] text-gray-950">
          New dashboard
        </h2>
        <p className="mt-1 text-[13px] leading-6 text-gray-500">
          Name the dashboard. You can add apps and choose who sees it after creation.
        </p>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-[12px] font-medium text-gray-700">Name</span>
          <DenInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Support overview"
            autoFocus
          />
        </label>

        {createMutation.error ? (
          <p className="mt-3 text-[12.5px] text-red-600">
            {createMutation.error instanceof Error ? createMutation.error.message : "Failed to create the dashboard."}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <DenButton variant="secondary" onClick={onClose} disabled={createMutation.isPending}>
            Cancel
          </DenButton>
          <DenButton disabled={!trimmedName || createMutation.isPending} onClick={() => void submit()}>
            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Create dashboard
          </DenButton>
        </div>
      </div>
    </div>
  );
}
