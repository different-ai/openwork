"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ArrowLeft, FileText, Pencil } from "lucide-react";
import { PaperMeshGradient } from "@openwork/ui/react";
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
  parseSkillDraft,
  useOrgSkillLibrary,
} from "./skill-hub-data";

export function SkillDetailScreen({ skillId }: { skillId: string }) {
  const { orgId, orgSlug } = useOrgDashboard();
  const { skills, busy, error } = useOrgSkillLibrary(orgId);
  const skill = useMemo(
    () => skills.find((entry) => entry.id === skillId) ?? null,
    [skillId, skills],
  );

  if (busy && !skill) {
    return (
      <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">
        <div className="rounded-xl border border-gray-100 bg-white px-5 py-8 text-[13px] text-gray-400">
          Loading skill details...
        </div>
      </div>
    );
  }

  if (!skill) {
    return (
      <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">
        <div className="rounded-xl border border-red-100 bg-red-50 px-5 py-3.5 text-[13px] text-red-600">
          {error ?? "That skill could not be found."}
        </div>
      </div>
    );
  }

  const draft = parseSkillDraft(skill.skillText, {
    name: skill.title,
    description: skill.description,
  });
  const skillBody = getSkillBodyText(skill.skillText, {
    name: skill.title,
    description: skill.description,
  });

  return (
    <div className="mx-auto max-w-[900px] px-6 py-8 md:px-8">

      {/* Nav */}
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link
          href={getSkillHubsRoute(orgSlug)}
          className="inline-flex items-center gap-1.5 text-[13px] text-gray-400 transition hover:text-gray-700"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Link>

        {skill.canManage ? (
          <Link
            href={getEditSkillRoute(orgSlug, skill.id)}
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            Edit Skill
          </Link>
        ) : null}
      </div>

      <div className="grid gap-5">

        {/* ── Main card ── */}
        <section className="overflow-hidden rounded-2xl border border-gray-100 bg-white">

          {/* Gradient header — seeded by skill id */}
          <div className="relative h-40 overflow-hidden border-b border-gray-100">
            <div className="absolute inset-0">
              <PaperMeshGradient seed={skill.id} speed={0} />
            </div>
            <div className="absolute bottom-[-20px] left-6 flex h-14 w-14 items-center justify-center rounded-[18px] border border-white/60 bg-white shadow-[0_12px_24px_-12px_rgba(15,23,42,0.3)]">
              <FileText className="h-6 w-6 text-gray-700" />
            </div>
          </div>

          <div className="px-6 pb-6 pt-10">
            {/* Title row with inline visibility label */}
            <div className="flex items-start justify-between gap-4">
              <h1 className="text-[18px] font-semibold text-gray-900">{skill.title}</h1>
              <span className="mt-0.5 shrink-0 rounded-full bg-gray-100 px-3 py-1 text-[12px] text-gray-500">
                {getSkillVisibilityLabel(skill.shared)}
              </span>
            </div>
            {skill.description ? (
              <p className="mt-1.5 text-[13px] leading-relaxed text-gray-400">
                {skill.description}
              </p>
            ) : null}
            <p className="mt-2 text-[12px] text-gray-300">
              Updated {formatSkillTimestamp(skill.updatedAt)}
            </p>

            {/* Skill definition */}
            <div className="mt-6 border-t border-gray-100 pt-5">
              <p className="mb-3 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                Instructions
              </p>
              <div className="overflow-x-auto rounded-xl border border-gray-100 bg-gray-50 px-4 py-4">
                <pre className="whitespace-pre-wrap font-mono text-[13px] leading-7 text-gray-700">
                  {skillBody}
                </pre>
              </div>
            </div>
          </div>
        </section>


      </div>
    </div>
  );
}
