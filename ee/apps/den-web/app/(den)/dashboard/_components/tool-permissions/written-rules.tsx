import { TOOL_PERMISSION_WRITTEN_RULES_MAX_LENGTH } from "@openwork/types/den/tool-permissions";
import { useId, useRef, useState } from "react";
import { DenButton, buttonVariants } from "../../../_components/ui/button";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import { DenTextarea } from "../../../_components/ui/textarea";
import { ActionDialog, type DialogProps } from "../agents-admin/dialogs";
import { useSetWrittenRules, useToolPermissions } from "./data";

const title = "Rules every run follows";
const description = "Told to every agent and Automation run before its own instructions. Use tool permissions to enforce access.";
const muted = "text-[13px] text-[var(--dls-text-secondary)]";

function WrittenRulesDialog({ rules, onSave, ...dialog }: DialogProps & { rules: string; onSave: (rules: string) => void }) {
  const [draft, setDraft] = useState(rules);
  const counterId = useId();
  return <ActionDialog {...dialog} title={title} action="Save rules" disabled={draft.trim() === rules}
    onSave={() => onSave(draft)}>
    <DenTextarea aria-label={title} aria-describedby={counterId} value={draft} rows={6}
      maxLength={TOOL_PERMISSION_WRITTEN_RULES_MAX_LENGTH} disabled={dialog.busy} onChange={(event) => setDraft(event.target.value)} />
    <p id={counterId} className={`text-right tabular-nums ${muted}`}>{draft.length} / {TOOL_PERMISSION_WRITTEN_RULES_MAX_LENGTH}</p>
  </ActionDialog>;
}

export function WrittenRulesCard({ orgId }: { orgId: string }) {
  const headingId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const permissions = useToolPermissions(orgId);
  const edit = useSetWrittenRules(orgId);
  const rules = permissions.data?.writtenRules;
  return <section data-written-rules="" aria-labelledby={headingId} className="space-y-2 border-t border-[var(--dls-border)] pt-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 id={headingId} className="text-base font-semibold">{title}</h2>
        <p className={muted}>{description}</p>
      </div>
      <button ref={editButton} type="button" data-written-rules-edit="" aria-label="Edit rules every run follows"
        disabled={rules === undefined} className={buttonVariants({ variant: "secondary", size: "sm", className: "disabled:opacity-60" })}
        onClick={() => { edit.reset(); setEditing(true); }}>Edit rules</button>
    </div>
    {permissions.isPending ? <DenSkeleton aria-label="Loading written rules" className="h-5 w-40" /> : null}
    {permissions.isError ? <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-[13px] text-[var(--ow-danger)]">Could not load written rules.{permissions.data ? ` Last checked ${new Date(permissions.dataUpdatedAt).toLocaleString()}.` : ""}</p>
      <DenButton variant="secondary" size="xs" onClick={() => void permissions.refetch()}>Try again</DenButton>
    </div> : null}
    {rules !== undefined ? <p className={`truncate ${muted}`}>{rules.split(/\r?\n/, 1)[0]?.trim() || "No written rules yet."}</p> : null}
    {editing && rules !== undefined ? <WrittenRulesDialog rules={rules} busy={edit.isPending}
      error={edit.isError ? "Could not save these rules. Try again." : null} finalFocus={editButton}
      onClose={() => setEditing(false)} onSave={(draft) => edit.mutate(draft, { onSuccess: () => setEditing(false) })} /> : null}
  </section>;
}
