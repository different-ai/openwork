"use client";

import Link from "next/link";
import { FileText, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { getNewSkillRoute, getSkillRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useSkills } from "./skill-data";

export function SkillsScreen() {
  const { orgSlug } = useOrgDashboard();
  const { data: skills = [], isLoading, error } = useSkills();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSkills = useMemo(
    () => skills.filter((skill) => (
      !normalizedQuery
      || skill.name.toLowerCase().includes(normalizedQuery)
      || skill.description.toLowerCase().includes(normalizedQuery)
    )),
    [normalizedQuery, skills],
  );

  return (
    <DashboardPageTemplate
      icon={FileText}
      title="Skills"
      description="Create and maintain reusable instructions for agents in this workspace."
      colors={["#ECFDF5", "#064E3B", "#059669", "#A7F3D0"]}
    >
      <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full max-w-sm">
          <DenInput
            type="search"
            icon={Search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills..."
          />
        </div>
        <Link href={getNewSkillRoute(orgSlug)} className={buttonVariants()}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          Create skill
        </Link>
      </div>

      {error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-[14px] text-red-700">
          {error instanceof Error ? error.message : "Failed to load skills."}
        </div>
      ) : isLoading ? (
        <div className="rounded-2xl border border-gray-200 bg-white px-6 py-10 text-[14px] text-gray-500">
          Loading skills…
        </div>
      ) : filteredSkills.length === 0 ? (
        <div className="rounded-[28px] border border-dashed border-gray-200 bg-white px-6 py-12 text-center">
          <p className="text-[16px] font-medium text-gray-900">
            {skills.length === 0 ? "No skills yet." : "No skills match that search."}
          </p>
          <p className="mt-2 text-[14px] text-gray-500">
            {skills.length === 0 ? "Create a skill to give agents reusable guidance." : "Try a different search term."}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filteredSkills.map((skill) => (
            <Link
              key={skill.id}
              href={getSkillRoute(orgSlug, skill.id)}
              className="rounded-2xl border border-gray-100 bg-white px-5 py-4 transition hover:-translate-y-0.5 hover:border-gray-200 hover:shadow-sm"
            >
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700">
                  <FileText className="h-4 w-4" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-[14px] font-semibold text-gray-900">{skill.name}</h2>
                  <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-gray-500">{skill.description}</p>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </DashboardPageTemplate>
  );
}
