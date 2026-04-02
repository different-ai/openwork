"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search, Share2, Trash2 } from "lucide-react";
import { DashboardPageTemplate } from "../../../../_components/ui/dashboard-page-template";
import { DenButton, buttonVariants } from "../../../../_components/ui/button";
import { DenInput } from "../../../../_components/ui/input";
import { requestJson, getErrorMessage } from "../../../../_lib/den-flow";
import { getMembersRoute } from "../../../../_lib/den-org";
import { useDenFlow } from "../../../../_providers/den-flow-provider";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  OPENWORK_DOCS_URL,
  formatTemplateTimestamp,
  useOrgTemplates,
} from "./shared-setup-data";

type TemplateView = "all" | "mine" | "team" | "newest" | "a-z";

const viewOptions: Array<{ value: TemplateView; label: string }> = [
  { value: "all", label: "All" },
  { value: "mine", label: "Mine" },
  { value: "team", label: "Team" },
  { value: "newest", label: "Newest" },
  { value: "a-z", label: "A–Z" },
];

function getTemplateAccent(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 360;
  }

  const hue = hash;
  const accent = `hsl(${hue} 82% 52%)`;
  const accentTwo = `hsl(${(hue + 46) % 360} 84% 64%)`;
  const background = `hsl(${hue} 90% 96%)`;

  return {
    background,
    gradient: `radial-gradient(circle at 30% 30%, ${accentTwo} 0%, ${accent} 55%, hsl(${(hue + 140) % 360} 90% 32%) 100%)`,
  };
}

export function SharedSetupsScreen() {
  const { orgSlug, orgId, activeOrg, orgContext } = useOrgDashboard();
  const { user } = useDenFlow();
  const { templates, busy, error, reloadTemplates } = useOrgTemplates(orgId);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeView, setActiveView] = useState<TemplateView>("all");

  const canDelete = orgContext?.currentMember.isOwner ?? false;

  const visibleTemplates = useMemo(() => {
    const loweredQuery = query.trim().toLowerCase();
    let nextTemplates = templates.filter((template) => {
      if (!loweredQuery) {
        return true;
      }

      return (
        template.name.toLowerCase().includes(loweredQuery) ||
        template.creator.name.toLowerCase().includes(loweredQuery) ||
        template.creator.email.toLowerCase().includes(loweredQuery)
      );
    });

    if (activeView === "mine") {
      nextTemplates = nextTemplates.filter(
        (template) => template.creator.email.toLowerCase() === (user?.email ?? "").toLowerCase(),
      );
    }

    if (activeView === "team") {
      nextTemplates = nextTemplates.filter(
        (template) => template.creator.email.toLowerCase() !== (user?.email ?? "").toLowerCase(),
      );
    }

    if (activeView === "a-z") {
      return [...nextTemplates].sort((left, right) => left.name.localeCompare(right.name));
    }

    return [...nextTemplates].sort((left, right) => {
      const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
      return rightTime - leftTime;
    });
  }, [activeView, query, templates, user?.email]);

  async function deleteTemplate(templateId: string) {
    setDeletingId(templateId);
    setDeleteError(null);
    try {
      if (!orgId) {
        throw new Error("Organization not found.");
      }

      const { response, payload } = await requestJson(
        `/v1/orgs/${encodeURIComponent(orgId)}/templates/${encodeURIComponent(templateId)}`,
        { method: "DELETE" },
        12000,
      );

      if (response.status !== 204 && !response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to delete template (${response.status}).`));
      }

      await reloadTemplates();
    } catch (nextError) {
      setDeleteError(
        nextError instanceof Error ? nextError.message : "Failed to delete template.",
      );
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <DashboardPageTemplate
      icon={Share2}
      title="Team Templates"
      description="Browse the shared setups your team has already published from the desktop app."
      colors={["#FFFBEB", "#78350F", "#F59E0B", "#FDE68A"]}
    >
      <div className="mb-4 flex flex-wrap justify-end gap-3">
        <a href={OPENWORK_DOCS_URL} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
          Learn how
        </a>
        <a href="https://openworklabs.com/download" className={buttonVariants({ variant: "primary" })}>
          Use desktop app
        </a>
      </div>

      <div className="mb-6">
        <DenInput
          type="text"
          icon={Search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search templates"
        />
      </div>

      <div className="mb-6 flex flex-wrap gap-2">
        {viewOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setActiveView(option.value)}
            className={`rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors ${
              activeView === option.value
                ? "bg-gray-900 text-white"
                : "border border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      {error ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{error}</div> : null}
      {deleteError ? <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{deleteError}</div> : null}

      {busy ? (
        <div className="rounded-[20px] border border-gray-100 bg-white px-5 py-8 text-[14px] text-gray-500">
          Loading templates…
        </div>
      ) : visibleTemplates.length === 0 ? (
        <div className="rounded-[20px] border border-dashed border-gray-200 bg-white px-5 py-8 text-[14px] text-gray-500">
          {templates.length === 0
            ? "No shared setups yet. Create one from the OpenWork desktop app and it will appear here."
            : "No templates match that search yet."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {visibleTemplates.map((template) => {
            const accent = getTemplateAccent(template.name);
            return (
              <article
                key={template.id}
                className="group relative flex h-full flex-col rounded-[20px] border border-gray-100 bg-white p-5 transition-all hover:border-gray-200 hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)]"
              >
                <div className="mb-2 flex items-start gap-3">
                  <div
                    className="relative mt-0.5 h-6 w-6 shrink-0 overflow-hidden rounded-full"
                    style={{ backgroundColor: accent.background }}
                  >
                    <div
                      className="absolute inset-0 opacity-90 transition-opacity group-hover:opacity-100"
                      style={{ backgroundImage: accent.gradient }}
                    />
                  </div>
                  <div className="min-w-0">
                    <h2 className="mb-1 text-[14px] font-semibold leading-snug text-gray-900">
                      {template.name}
                    </h2>
                    <p className="text-[13px] leading-relaxed text-gray-500">
                      Created by {template.creator.name} · {template.creator.email}
                    </p>
                    <p className="mt-2 text-[12px] text-gray-400">
                      Updated {formatTemplateTimestamp(template.createdAt, { includeTime: true })}
                    </p>
                  </div>
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-2 pl-9 pt-4">
                  <span className="inline-flex items-center gap-1 rounded-md border border-gray-100 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-500">
                    <Share2 className="h-3 w-3" />
                    Shared setup
                  </span>
                  <span className="inline-flex items-center rounded-md border border-gray-100 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-500">
                    {activeOrg?.name ?? "Workspace"}
                  </span>
                  {canDelete ? (
                    <DenButton
                      variant="destructive"
                      size="sm"
                      icon={Trash2}
                      loading={deletingId === template.id}
                      disabled={deletingId !== null}
                      onClick={() => void deleteTemplate(template.id)}
                      className="ml-auto"
                    >
                      Delete
                    </DenButton>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-[12px] text-gray-400">
        {orgContext?.members.length ?? 0} members currently have access to this library.
      </p>
    </DashboardPageTemplate>
  );
}
