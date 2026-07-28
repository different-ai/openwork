"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, FileText, Pencil, Trash2, X } from "lucide-react";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { getEditPluginSkillRoute, getPluginRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useDeleteSkill, useSkill } from "./skill-data";

export function SkillDetailScreen({ pluginId, skillId }: { pluginId: string; skillId: string }) {
  const router = useRouter();
  const { orgSlug } = useOrgDashboard();
  const { data: skill, isLoading, error } = useSkill(pluginId, skillId);
  const deleteSkill = useDeleteSkill(pluginId);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  if (isLoading && !skill) {
    return <DetailMessage>Loading skill…</DetailMessage>;
  }

  if (!skill) {
    return <DetailMessage error>{error instanceof Error ? error.message : "That skill could not be found."}</DetailMessage>;
  }

  return (
    <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link href={getPluginRoute(orgSlug, pluginId)} className="inline-flex items-center gap-1.5 text-[13px] text-gray-500 hover:text-gray-900">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to plugin
        </Link>
        <div className="flex items-center gap-2">
          <Link href={getEditPluginSkillRoute(orgSlug, pluginId, skill.id)} className={buttonVariants({ variant: "secondary", size: "sm" })}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Edit
          </Link>
          <DenButton variant="destructive" size="sm" icon={Trash2} onClick={() => setConfirmingDelete(true)}>
            Delete
          </DenButton>
        </div>
      </div>

      <header className="rounded-2xl border border-gray-100 bg-white px-6 py-6 md:px-8">
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
            <FileText className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="break-words text-[24px] font-semibold tracking-[-0.03em] text-gray-950">{skill.name}</h1>
            <p className="mt-2 text-[14px] leading-6 text-gray-500">{skill.description}</p>
          </div>
        </div>
      </header>

      <article className="mt-5 rounded-2xl border border-gray-100 bg-white px-6 py-6 md:px-8">
        <h2 className="mb-4 text-[12px] font-semibold tracking-[0.14em] text-gray-400">Complete skill body</h2>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl border border-gray-200 bg-gray-50 px-5 py-5 font-mono text-[13px] leading-6 text-gray-800">{skill.body}</pre>
      </article>

      {confirmingDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/30 px-4" role="dialog" aria-modal="true" aria-labelledby="delete-skill-title">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="delete-skill-title" className="text-[18px] font-semibold text-gray-950">Delete “{skill.name}”?</h2>
                <p className="mt-2 text-[13px] leading-5 text-gray-500">This removes the skill from its owning plugin. Its version history is retained by Den.</p>
              </div>
              <button type="button" onClick={() => setConfirmingDelete(false)} aria-label="Close delete confirmation" className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {deleteSkill.error instanceof Error ? (
              <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700">{deleteSkill.error.message}</p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <DenButton variant="secondary" onClick={() => setConfirmingDelete(false)}>Cancel</DenButton>
              <DenButton
                variant="destructive"
                loading={deleteSkill.isPending}
                onClick={() => deleteSkill.mutate(skill.id, { onSuccess: () => router.push(getPluginRoute(orgSlug, pluginId)) })}
              >
                Delete “{skill.name}”
              </DenButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DetailMessage({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">
      <div className={`rounded-2xl border px-5 py-8 text-[14px] ${error ? "border-red-200 bg-red-50 text-red-700" : "border-gray-100 bg-white text-gray-500"}`}>
        {children}
      </div>
    </div>
  );
}
