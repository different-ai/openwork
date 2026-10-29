"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { KindTile } from "./item-logo";
import { LinkButton } from "./item-list";
import type { PluginSkill } from "./plugin-data";
import { previewSkillSteps, skillTitle } from "./skill-preview-model";

export { skillTitle } from "./skill-preview-model";

/** A skill's description and steps; long steps open with "Show all steps". */
export function SkillSteps({ skill, editHref }: { skill: PluginSkill; editHref?: string }) {
  const [expanded, setExpanded] = useState(false);
  const preview = previewSkillSteps(skill.body ?? "");
  return (
    <div className="flex flex-col gap-3" data-skill-steps={skill.id}>
      {skill.description ? <p className="text-[13px] text-[var(--dls-text-secondary)]">{skill.description}</p> : null}
      {skill.body ? (
        <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-6 text-[var(--dls-text-primary)]">{expanded ? skill.body : preview.text}</pre>
      ) : <p className="text-[13px] text-[var(--dls-text-secondary)]">No steps published yet.</p>}
      {preview.truncated || editHref ? (
        <div className="flex items-center gap-3">
          {preview.truncated ? (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
              className="flex items-center gap-1.5 rounded-lg text-left text-[13px] font-medium text-gray-700 outline-none hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-gray-300"
            >
              {expanded ? "Show less" : "Show all steps"}
              <ChevronDown className={`size-3.5 transition-transform duration-150 ease-out motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} strokeWidth={1.5} aria-hidden />
            </button>
          ) : null}
          {editHref ? <LinkButton size="xs" href={editHref}>Edit skill</LinkButton> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Native disclosure keeps keyboard, focus and open state without a second page.
 * `showKind` is off where every row is a skill, so "Skill" would only repeat.
 */
export function SkillPreview({ skill, editHref, showKind = true }: { skill: PluginSkill; editHref?: string; showKind?: boolean }) {
  return (
    <details className="group/skill" data-skill-preview={skill.id}>
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3 text-[13px] text-[var(--dls-text-primary)] outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-gray-300 [&::-webkit-details-marker]:hidden">
        <KindTile kind="skill" />
        <span className="min-w-0 flex-1 break-words font-medium">{skillTitle(skill.name)}</span>
        {showKind ? <span className="shrink-0 text-[12px] text-[var(--dls-text-secondary)]">Skill</span> : null}
        <ChevronRight className="size-4 shrink-0 text-[var(--dls-text-secondary)] transition-transform duration-150 ease-out group-open/skill:rotate-90 motion-reduce:transition-none" strokeWidth={1.5} aria-hidden />
      </summary>
      <div className="px-3 pb-4 sm:pl-14">
        <SkillSteps skill={skill} editHref={editHref} />
      </div>
    </details>
  );
}
