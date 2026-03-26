"use client";

import { useEffect, useState } from "react";
import { getErrorMessage, requestJson } from "../../../../_lib/den-flow";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

type TemplateCard = {
  id: string;
  name: string;
  createdAt: string | null;
  creator: {
    name: string;
    email: string;
  };
};

function asTemplateCard(value: unknown): TemplateCard | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Record<string, unknown>;
  const creator = entry.creator && typeof entry.creator === "object"
    ? (entry.creator as Record<string, unknown>)
    : null;

  if (
    typeof entry.id !== "string" ||
    typeof entry.name !== "string" ||
    !creator ||
    typeof creator.name !== "string" ||
    typeof creator.email !== "string"
  ) {
    return null;
  }

  return {
    id: entry.id,
    name: entry.name,
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : null,
    creator: {
      name: creator.name,
      email: creator.email,
    },
  };
}

export function TemplatesDashboardScreen() {
  const { orgSlug, orgContext } = useOrgDashboard();
  const [templates, setTemplates] = useState<TemplateCard[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const canDelete = orgContext?.currentMember.isOwner ?? false;

  async function loadTemplates() {
    setBusy(true);
    setError(null);
    try {
      const { response, payload } = await requestJson(
        `/v1/orgs/${encodeURIComponent(orgSlug)}/templates`,
        { method: "GET" },
        12000,
      );

      if (!response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to load templates (${response.status}).`));
      }

      const list =
        payload && typeof payload === "object" && Array.isArray((payload as { templates?: unknown[] }).templates)
          ? (payload as { templates: unknown[] }).templates
          : [];

      setTemplates(list.map(asTemplateCard).filter((entry): entry is TemplateCard => entry !== null));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load templates.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate(templateId: string) {
    setDeletingId(templateId);
    setError(null);
    try {
      const { response, payload } = await requestJson(
        `/v1/orgs/${encodeURIComponent(orgSlug)}/templates/${encodeURIComponent(templateId)}`,
        { method: "DELETE" },
        12000,
      );

      if (response.status !== 204 && !response.ok) {
        throw new Error(getErrorMessage(payload, `Failed to delete template (${response.status}).`));
      }

      await loadTemplates();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete template.");
    } finally {
      setDeletingId(null);
    }
  }

  useEffect(() => {
    void loadTemplates();
  }, [orgSlug]);

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:p-12">
      <div className="rounded-[32px] border border-[var(--dls-border)] bg-white p-6 shadow-[var(--dls-card-shadow)] md:p-8">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--dls-text-secondary)]">Workspace Templates</p>
        <h1 className="mt-2 text-[2.4rem] font-semibold leading-[0.95] tracking-[-0.06em] text-[var(--dls-text-primary)]">Shared setup templates</h1>
        <p className="mt-3 max-w-2xl text-[15px] leading-7 text-[var(--dls-text-secondary)]">
          Templates created for this organization appear here. Use this as the quick place to browse and remove stale links.
        </p>
        <p className="mt-3 text-sm font-medium text-[var(--dls-text-secondary)]">
          Create new templates from workspaces inside the OpenWork desktop app.
        </p>
      </div>

      {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      {busy ? (
        <div className="rounded-[24px] border border-[var(--dls-border)] bg-white p-6 text-sm text-[var(--dls-text-secondary)]">Loading templates...</div>
      ) : templates.length === 0 ? (
        <div className="rounded-[24px] border border-[var(--dls-border)] bg-white p-6 text-sm text-[var(--dls-text-secondary)]">No templates yet for this organization.</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {templates.map((template) => (
            <article key={template.id} className="rounded-[24px] border border-[var(--dls-border)] bg-white p-5 shadow-[var(--dls-card-shadow)]">
              <h2 className="text-lg font-semibold text-[var(--dls-text-primary)]">{template.name}</h2>
              <p className="mt-2 text-xs text-[var(--dls-text-secondary)]">Created by {template.creator.name} ({template.creator.email})</p>
              <p className="mt-1 text-xs text-[var(--dls-text-secondary)]">
                {template.createdAt ? `Created ${new Date(template.createdAt).toLocaleString()}` : "Created recently"}
              </p>
              {canDelete ? (
                <button
                  type="button"
                  className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => void deleteTemplate(template.id)}
                  disabled={deletingId === template.id}
                >
                  {deletingId === template.id ? "Deleting..." : "Delete"}
                </button>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
