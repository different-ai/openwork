"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowLeft, Pencil } from "lucide-react";
import { buttonVariants } from "../../../../_components/ui/button";
import {
  getEditSkillRoute,
  getSkillHubsRoute,
} from "../../../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  formatSkillTimestamp,
  getSkillBodyText,
  getSkillVisibilityLabel,
  parseSkillCategory,
  parseSkillDraft,
  useOrgSkillLibrary,
} from "./skill-hub-data";

export function SkillDetailScreen({ skillId }: { skillId: string }) {
  const { orgId, orgSlug } = useOrgDashboard();
  const { skills, busy, error } = useOrgSkillLibrary(orgId);
  const skill = useMemo(() => skills.find((entry) => entry.id === skillId) ?? null, [skillId, skills]);

  if (busy && !skill) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        <div className="rounded-[28px] border border-gray-200 bg-white px-6 py-10 text-[15px] text-gray-500">
          Loading skill details...
        </div>
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        <div className="rounded-[28px] border border-red-200 bg-red-50 px-6 py-4 text-[15px] text-red-700">
          {error ?? "That skill could not be found."}
        </div>
      </div>
    );
  }

  const draft = parseSkillDraft(skill.skillText, {
    name: skill.title,
    description: skill.description,
  });
  const category = parseSkillCategory(skill.skillText) ?? draft.category;
  const skillBody = getSkillBodyText(skill.skillText, {
    name: skill.title,
    description: skill.description,
  });

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
      <div className="mb-8 flex items-center justify-between gap-4">
        <Link
          href={getSkillHubsRoute(orgSlug)}
          className="inline-flex items-center gap-2 text-[15px] font-medium text-gray-500 transition hover:text-gray-900"
        >
          <ArrowLeft className="h-5 w-5" />
          Back
        </Link>

        {skill.canManage ? (
          <Link href={getEditSkillRoute(orgSlug, skill.id)} className={buttonVariants({ variant: "secondary" })}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Edit Skill
          </Link>
        ) : null}
      </div>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
        <section className="rounded-[36px] border border-gray-200 bg-white p-8 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.24)]">
          <div className="mb-8 flex flex-wrap items-center gap-3">
            <span className="rounded-full bg-gray-100 px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-gray-500">
              {category || "General"}
            </span>
            <span className="rounded-full bg-gray-100 px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.14em] text-gray-500">
              {getSkillVisibilityLabel(skill.shared)}
            </span>
          </div>

          <h1 className="text-[48px] font-semibold tracking-[-0.08em] text-gray-950">{skill.title}</h1>
          <p className="mt-5 max-w-[18ch] text-[28px] leading-[1.35] tracking-[-0.05em] text-gray-500">
            {skill.description || "No short description has been added yet."}
          </p>

          <div className="mt-8 border-t border-gray-100 pt-8">
            <p className="mb-5 text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Skill Definition</p>
            <div className="overflow-x-auto rounded-[28px] border border-gray-200 bg-[#f8fafc] px-6 py-6">
              <pre className="whitespace-pre-wrap font-mono text-[16px] leading-9 text-gray-800">{skillBody}</pre>
            </div>
          </div>

          <p className="mt-6 text-[13px] text-gray-400">Updated {formatSkillTimestamp(skill.updatedAt)}</p>
        </section>

        <aside className="grid gap-4 self-start">
          <div className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.18)]">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Visibility</p>
            <p className="mt-3 text-[22px] font-semibold tracking-[-0.05em] text-gray-950">{getSkillVisibilityLabel(skill.shared)}</p>
          </div>
          <div className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.18)]">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Category</p>
            <p className="mt-3 text-[22px] font-semibold tracking-[-0.05em] text-gray-950">{category || "General"}</p>
          </div>
          <div className="rounded-[28px] border border-gray-200 bg-white p-6 shadow-[0_18px_48px_-34px_rgba(15,23,42,0.18)]">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-gray-400">Preview</p>
            <p className="mt-3 text-[15px] leading-8 text-gray-500">{draft.description || "This skill does not have a summary yet."}</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
