"use client";

import Link from "next/link";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { Lock, Pencil, Plus } from "lucide-react";
import { ORG_PROMPT_MAX_LENGTH, type OrgPrompt } from "@openwork/types/den/prompts";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenTextarea } from "../../_components/ui/textarea";
import { getEveryoneRoute, getOrgAccessFlags, permissionLockReason, type DenOrgContext } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useDenToast } from "./den-toast";
import { formatAddedDate } from "./item-dates";
import { ConfirmDialog } from "./item-list";
import { usePromptSettings, useRemovePrompt, useSavePrompt } from "./prompts-data";

const PROMPT_ROWS = 15;
/** Saved prompts and the editor share one type ramp, so Edit swaps the field in place. */
const promptTextClass = "font-mono text-[13px] leading-5";
const promptReadClass = `${promptTextClass} max-h-[480px] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border px-4 py-2.5`;
/** The scope's own prompt: the focal element (P7). */
const ownPromptClass = `${promptReadClass} border-gray-200 bg-white text-gray-900`;
/** A prompt inherited from Everyone: same shape, quieter, no fill. */
const inheritedPromptClass = `${promptReadClass} border-gray-100 text-gray-600`;

/** The Prompts tab shows for people who can view prompts. */
export function promptsTabVisible(orgContext: DenOrgContext | null): boolean {
  if (!orgContext) return false;
  return getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canViewPrompts;
}

/**
 * Members › Teams › a team (or Everyone) › Prompts: the scope's system prompt,
 * read-only until Edit. A team page lists the prompt for everyone first,
 * the order members' agents receive them in.
 */
export function PromptsPanel({ team }: { team: { id: string; name: string } | null }) {
  const { orgId, orgSlug } = useOrgDashboard();
  const settings = usePromptSettings(orgId ?? "", Boolean(orgId));

  if (!orgId || settings.isPending) return <PromptsSkeleton />;
  if (settings.isError) {
    return (
      <DenNotice
        tone="error"
        message={settings.error instanceof Error && settings.error.message ? settings.error.message : "Couldn't load prompts."}
        action={<DenButton variant="secondary" size="sm" onClick={() => void settings.refetch()}>Try again</DenButton>}
      />
    );
  }

  const prompt = team ? settings.data.teams.find((entry) => entry.teamId === team.id)?.prompt ?? null : settings.data.everyone;
  const everyonePrompt = team ? settings.data.everyone : null;
  return (
    <section className="flex flex-col gap-8" data-testid="prompts-panel">
      {everyonePrompt ? (
        <div className="flex flex-col gap-2">
          <PromptHeader
            title="Prompt for everyone"
            state="Applies first"
            action={settings.data.canEdit ? (
              <Link href={`${getEveryoneRoute(orgSlug)}?tab=prompts`} className={buttonVariants({ variant: "ghost", size: "inline" })} data-testid="prompt-everyone-edit">
                Edit on Everyone
              </Link>
            ) : null}
          />
          <div className={inheritedPromptClass} data-testid="prompt-everyone">{everyonePrompt.content}</div>
        </div>
      ) : null}

      <PromptEditor
        key={`${team?.id ?? "everyone"}-${prompt?.updatedAt ?? "none"}`}
        orgId={orgId}
        team={team}
        prompt={prompt}
        canEdit={settings.data.canEdit}
      />
    </section>
  );
}

function PromptEditor({ orgId, team, prompt, canEdit }: {
  orgId: string;
  team: { id: string; name: string } | null;
  prompt: OrgPrompt | null;
  canEdit: boolean;
}) {
  const save = useSavePrompt(orgId);
  const remove = useRemovePrompt(orgId);
  const toast = useDenToast();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const teamId = team?.id ?? null;
  const editing = draft !== null;
  const saved = prompt?.content ?? "";
  const empty = (draft ?? "").trim().length === 0;
  const dirty = editing && draft !== saved;
  const title = team ? `${team.name}'s prompt` : "Prompt for everyone";

  async function submit() {
    if (draft === null || empty || !dirty) return;
    setError(null);
    try {
      await save.mutateAsync({ teamId, content: draft });
      setDraft(null);
      toast({ title: "Prompt saved" });
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "Couldn't save the prompt. Try again.");
    }
  }

  function cancel() {
    setDraft(null);
    setError(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === "Escape" && !dirty && !save.isPending) {
      event.preventDefault();
      cancel();
    }
  }

  const headerAction = editing ? null : !canEdit ? (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-gray-500">
      <Lock className="size-3.5 shrink-0" aria-hidden="true" />
      {permissionLockReason("prompts.manage")}
    </span>
  ) : prompt ? (
    <DenButton variant="secondary" size="sm" icon={Pencil} onClick={() => setDraft(saved)} data-testid="prompt-edit">Edit</DenButton>
  ) : null;

  return (
    <div className="flex flex-col gap-2">
      <PromptHeader title={title} state={prompt ? updatedLabel(prompt.updatedAt) : null} action={headerAction} />

      {editing ? (
        <DenTextarea
          aria-label={title}
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          maxLength={ORG_PROMPT_MAX_LENGTH}
          rows={PROMPT_ROWS}
          placeholder="Describe how agents should work, what to prioritise and what to avoid."
          className={`${promptTextClass} !px-4 overflow-y-auto`}
          data-testid="prompt-content"
        />
      ) : prompt ? (
        <div className={ownPromptClass} data-testid="prompt-content">{prompt.content}</div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-gray-200 px-6 py-10 text-center" data-testid="prompt-empty">
          <p className="text-[13px] font-medium text-gray-700">{team ? `No prompt for ${team.name} yet` : "No prompt for everyone yet"}</p>
          {canEdit ? (
            <DenButton variant="secondary" size="sm" icon={Plus} onClick={() => setDraft("")} data-testid="prompt-edit">Add prompt</DenButton>
          ) : null}
        </div>
      )}

      {error ? <DenNotice tone="error" message={error} className="mt-2" /> : null}

      {editing ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          {prompt ? (
            <DenButton variant="destructive" size="sm" onClick={() => setConfirmingRemove(true)} disabled={save.isPending}>Remove prompt</DenButton>
          ) : <span />}
          <div className="flex items-center gap-3">
            <span className="text-[12px] tabular-nums text-gray-500" aria-live="polite">
              {(draft ?? "").length.toLocaleString("en-US")} / {ORG_PROMPT_MAX_LENGTH.toLocaleString("en-US")}
            </span>
            <DenButton variant="secondary" size="sm" onClick={cancel} disabled={save.isPending}>Cancel</DenButton>
            <DenButton
              size="sm"
              onClick={() => void submit()}
              loading={save.isPending}
              disabled={!dirty || empty}
              title="Save prompt (⌘⏎)"
              data-testid="prompt-save"
            >
              Save prompt
            </DenButton>
          </div>
        </div>
      ) : null}

      <ConfirmDialog
        confirm={confirmingRemove ? {
          title: "Remove this prompt?",
          description: teamId
            ? "Agents for this team's members stop following it at their next sync. The prompt for everyone still applies."
            : "Agents for everyone in the organization stop following it at their next sync. Teams' prompts still apply.",
          action: "Remove prompt",
        } : null}
        destructive
        onConfirm={async () => {
          await remove.mutateAsync(teamId);
          setDraft(null);
          toast({ title: "Prompt removed" });
        }}
        onClose={() => setConfirmingRemove(false)}
      />
    </div>
  );
}

/** One row above each prompt: its name and state on the left, at most one action on the right (S2). */
function PromptHeader({ title, state, action }: { title: string; state: string | null; action: ReactNode }) {
  return (
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div className="flex min-w-0 items-baseline gap-2">
        <h2 className="text-[13px] font-semibold text-gray-900">{title}</h2>
        {state ? <span className="text-[12px] text-gray-500">{state}</span> : null}
      </div>
      {action}
    </div>
  );
}

function updatedLabel(updatedAt: string): string | null {
  const date = formatAddedDate(updatedAt);
  if (!date) return null;
  return `Updated ${date === "Today" || date === "Yesterday" ? date.toLowerCase() : date}`;
}

function PromptsSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <div className="flex min-h-8 items-center justify-between gap-4">
        <DenSkeleton className="h-4 w-40" />
        <DenSkeleton className="h-8 w-16" />
      </div>
      <DenSkeleton className="h-[200px] w-full rounded-lg" />
    </div>
  );
}
