"use client";

import { FileText, MessageSquare } from "lucide-react";
import type { ReactNode } from "react";
import { useRouter } from "next/navigation";
import { DenButton } from "../../_components/ui/button";
import { getEditPluginSkillRoute, getLibraryPluginRoute, getPluginRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useDeleteSkill, useSkill } from "./skill-data";
import { BackLink, ItemHeader, ItemPage, SectionTitle } from "./item-header";
import { ItemMenu, removeEntry } from "./item-list";
import { usePlugin } from "./plugin-data";
import { pluginChatDeepLink, skillTitle } from "./plugin-page-screen";
import { SkillInstructions } from "./skill-instructions";

/** Admin mode edits and removes; member mode (from My Library) only reads. */
export function SkillDetailScreen({ pluginId, skillId, mode = "admin" }: { pluginId: string; skillId: string; mode?: "admin" | "member" }) {
  const router = useRouter();
  const { orgSlug } = useOrgDashboard();
  const { data: skill, isLoading, error } = useSkill(pluginId, skillId);
  const plugin = usePlugin(pluginId);
  const deleteSkill = useDeleteSkill(pluginId);
  const pluginHref = mode === "admin" ? getPluginRoute(orgSlug, pluginId) : getLibraryPluginRoute(orgSlug, pluginId);
  const back = { href: pluginHref, label: plugin.data?.name ?? "Back to plugin" };

  // The query waits for the workspace; until it answers, this is still loading.
  if (!skill && (isLoading || !error)) {
    return (
      <ItemPage>
        <SkillHeader back={back} title={<span className="block h-6 w-48 animate-pulse rounded-md bg-gray-100" />} description={<span className="mt-1 block h-4 w-72 max-w-full animate-pulse rounded bg-gray-100" />} />
        <InstructionsSection>
          <div className="flex flex-col gap-3" role="status" aria-label="Loading skill">
            {["w-full", "w-11/12", "w-4/5", "w-2/3"].map((width) => <span key={width} className={`block h-3.5 animate-pulse rounded bg-gray-100 ${width}`} />)}
          </div>
        </InstructionsSection>
      </ItemPage>
    );
  }

  if (!skill) {
    return (
      <ItemPage>
        <ItemHeader
          compact
          back={back}
          title="It did not load"
          description={error instanceof Error ? error.message : "That skill may have been removed from this plugin."}
        />
      </ItemPage>
    );
  }

  const title = skillTitle(skill.name);
  const chat = (
    <DenButton icon={MessageSquare} href={pluginChatDeepLink({ name: `the ${title} skill` })}>
      Use in chat
    </DenButton>
  );

  return (
    <ItemPage testId="skill-detail">
      <SkillHeader
        back={back}
        title={title}
        description={skill.description || undefined}
        actions={mode === "member" ? chat : (
          <>
            <ItemMenu size="md" label={`More for ${title}`} entries={[
              { label: "Edit", href: getEditPluginSkillRoute(orgSlug, pluginId, skill.id) },
              removeEntry(title, async () => {
                await deleteSkill.mutateAsync(skill.id);
                router.push(pluginHref);
              }),
            ]} />
            {chat}
          </>
        )}
      />
      <InstructionsSection>
        <SkillInstructions markdown={skill.body} title={title} />
      </InstructionsSection>
    </ItemPage>
  );
}

/** Title with its description directly beneath, so the two read as one unit. */
function SkillHeader({ back, title, description, actions }: {
  back: { href: string; label: string };
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      <BackLink href={back.href} label={back.label} />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3.5">
          <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-gray-100 bg-white text-gray-500">
            <FileText className="size-[18px]" strokeWidth={1.6} />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <h1 className="break-words text-[20px] font-semibold leading-7 tracking-[-0.3px] text-gray-950">{title}</h1>
            {description ? <div className="mt-0.5 max-w-[68ch] text-[14px] leading-5 text-gray-500">{description}</div> : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

function InstructionsSection({ children }: { children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <SectionTitle title="Instructions" />
      <div className="rounded-2xl border border-gray-100 bg-white px-6 py-5 md:px-7 md:py-6">{children}</div>
    </section>
  );
}
