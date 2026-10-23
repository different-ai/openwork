"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Braces, Lock, Trash2, User, Users, X } from "lucide-react";
import {
  environmentVariableKeyProblem,
  type EnvironmentVariableValueMode,
} from "@openwork/types/den/environment-variables";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCombobox, type DenComboboxOption } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSecretInput } from "../../_components/ui/secret-input";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenSkeleton } from "../../_components/ui/skeleton";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { DenSwitch } from "../../_components/ui/switch";
import { DenTextarea } from "../../_components/ui/textarea";
import { getEnvironmentVariablesRoute, getOrgAccessFlags, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { ConfirmDialog } from "./item-list";
import {
  VALUE_MODE_LABELS,
  deleteEnvironmentVariable,
  saveEnvironmentVariable,
  useOrgEnvironmentVariable,
  type DenEnvironmentVariable,
  type EnvironmentVariableAssignmentWrite,
} from "./environment-variable-data";

const MODE_OPTIONS = (["admin", "per_member"] as const).map((value) => ({ value, label: VALUE_MODE_LABELS[value] }));

/** A key suggestion from the name while the person hasn't typed a key: "GitHub token" → GITHUB_TOKEN. */
function keyFromName(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "_$1");
}

/**
 * One assignment being edited: who receives it and, when an admin sets
 * values, its value. `saved` means a value is stored; `value` is a new one
 * typed here; `clear` removes the stored one.
 */
type AssignmentDraft = {
  target: "everyone" | `team:${string}` | `member:${string}`;
  saved: boolean;
  value: string;
  clear: boolean;
};

function draftsFrom(variable: DenEnvironmentVariable | null): AssignmentDraft[] {
  if (!variable) return [{ target: "everyone", saved: false, value: "", clear: false }];
  return variable.assignments.map((entry) => ({
    target: entry.type === "everyone" ? "everyone" : entry.type === "team" ? `team:${entry.teamId ?? ""}` : `member:${entry.orgMembershipId ?? ""}`,
    saved: entry.hasValue,
    value: "",
    clear: false,
  }));
}

function writeFor(draft: AssignmentDraft, valueMode: EnvironmentVariableValueMode): EnvironmentVariableAssignmentWrite {
  const value = valueMode === "per_member" ? {} : draft.value ? { value: draft.value } : draft.clear ? { value: null } : {};
  if (draft.target === "everyone") return { type: "everyone", ...value };
  if (draft.target.startsWith("team:")) return { type: "team", teamId: draft.target.slice(5), ...value };
  return { type: "member", orgMembershipId: draft.target.slice(7), ...value };
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-gray-900">{children}</label>;
}

/** The value field of one assignment, with Remove for a stored value. */
function AssignmentValue({ draft, label, onChange }: { draft: AssignmentDraft; label: string; onChange: (next: Partial<AssignmentDraft>) => void }) {
  const saved = draft.saved && !draft.clear;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <div className="min-w-0 flex-1">
        <DenSecretInput
          aria-label={`${label} value`}
          value={draft.value}
          onChange={(next) => onChange({ value: next, clear: false })}
          saved={saved}
          placeholder={draft.clear ? "Value removed on save" : "Value"}
          autoComplete="new-password"
          data-testid="environment-variable-assignment-value"
        />
      </div>
      {saved && !draft.value ? (
        <DenButton variant="ghost" size="sm" onClick={() => onChange({ clear: true, value: "" })} aria-label={`Remove ${label} value`}>Clear</DenButton>
      ) : null}
    </div>
  );
}

function EditorForm({ variable }: { variable: DenEnvironmentVariable | null }) {
  const router = useRouter();
  const { orgSlug, orgContext, runReauthableAction } = useOrgDashboard();
  const [name, setName] = useState(variable?.name ?? "");
  const [key, setKey] = useState(variable?.key ?? "");
  const [keyTouched, setKeyTouched] = useState(Boolean(variable));
  const [description, setDescription] = useState(variable?.description ?? "");
  const [valueMode, setValueMode] = useState<EnvironmentVariableValueMode>(variable?.valueMode ?? "admin");
  const [drafts, setDrafts] = useState<AssignmentDraft[]>(() => draftsFrom(variable));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const effectiveKey = keyTouched ? key.trim() : keyFromName(name);
  const keyProblem = effectiveKey ? environmentVariableKeyProblem(effectiveKey) : null;
  const listRoute = getEnvironmentVariablesRoute(orgSlug);
  const organizationName = orgContext?.organization.name ?? "this organization";
  const adminValues = valueMode === "admin";
  const teams = useMemo(() => new Map((orgContext?.teams ?? []).map((team) => [team.id, team])), [orgContext?.teams]);
  const members = useMemo(() => new Map((orgContext?.members ?? []).map((member) => [member.id, member])), [orgContext?.members]);

  const everyone = drafts.find((draft) => draft.target === "everyone") ?? null;
  const teamDrafts = drafts.filter((draft) => draft.target.startsWith("team:"));
  const memberDrafts = drafts.filter((draft) => draft.target.startsWith("member:"));
  const chosen = new Set(drafts.map((draft) => draft.target));
  const teamOptions: DenComboboxOption[] = (orgContext?.teams ?? [])
    .filter((team) => !chosen.has(`team:${team.id}`))
    .map((team) => ({ value: team.id, label: team.name, meta: `${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}` }));
  const memberOptions: DenComboboxOption[] = (orgContext?.members ?? [])
    .filter((member) => !chosen.has(`member:${member.id}`))
    .map((member) => ({ value: member.id, label: member.user.name, description: member.user.email, keywords: [member.user.email] }));

  const update = (target: AssignmentDraft["target"], next: Partial<AssignmentDraft>) =>
    setDrafts((current) => current.map((draft) => (draft.target === target ? { ...draft, ...next } : draft)));
  const add = (target: AssignmentDraft["target"]) =>
    setDrafts((current) => (current.some((draft) => draft.target === target) ? current : [...current, { target, saved: false, value: "", clear: false }]));
  const remove = (target: AssignmentDraft["target"]) => setDrafts((current) => current.filter((draft) => draft.target !== target));

  // What saving throws away, said before saving (P9).
  const storedValues = variable?.assignments.filter((entry) => entry.hasValue).length ?? 0;
  const loses = variable && variable.valueMode !== valueMode
    ? valueMode === "per_member" && storedValues > 0
      ? `Saving removes the ${storedValues} ${storedValues === 1 ? "value" : "values"} you set.`
      : variable.valueMode === "per_member" && variable.memberValueCount > 0
        ? `Saving removes the values ${variable.memberValueCount} ${variable.memberValueCount === 1 ? "person has" : "people have"} set.`
        : null
    : null;
  const missingValues = adminValues ? drafts.filter((draft) => !draft.value && (!draft.saved || draft.clear)).length : 0;

  const save = async () => {
    if (!name.trim() || !effectiveKey || keyProblem) {
      setError(!name.trim() ? "Enter a name." : keyProblem ?? "Enter a key.");
      return;
    }
    setError(null);
    try {
      setSaving(true);
      await runReauthableAction("save-environment-variable", async () => {
        await saveEnvironmentVariable(variable?.id ?? null, {
          name: name.trim(),
          key: effectiveKey,
          description: description.trim() || null,
          valueMode,
          assignments: drafts.map((draft) => writeFor(draft, valueMode)),
        });
      });
      router.push(listRoute);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Couldn't save the environment variable.");
    } finally {
      setSaving(false);
    }
  };

  const deleteVariable = async () => {
    if (!variable) return;
    await runReauthableAction("delete-environment-variable", async () => {
      await deleteEnvironmentVariable(variable.id);
    });
    router.push(listRoute);
  };

  return (
    <>
      <div className="grid gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <FieldLabel htmlFor="environment-variable-name">Name</FieldLabel>
            <DenInput id="environment-variable-name" data-testid="environment-variable-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="GitHub token" autoFocus={!variable} />
          </div>
          <div>
            <FieldLabel htmlFor="environment-variable-key">Key</FieldLabel>
            <DenInput
              id="environment-variable-key"
              data-testid="environment-variable-key"
              className="font-mono"
              value={effectiveKey}
              onChange={(event) => { setKeyTouched(true); setKey(event.target.value); }}
              placeholder="GITHUB_TOKEN"
              aria-invalid={Boolean(keyProblem)}
              aria-describedby={keyProblem ? "environment-variable-key-problem" : undefined}
              spellCheck={false}
              autoComplete="off"
            />
            {keyProblem ? <p id="environment-variable-key-problem" className="mt-1.5 text-[12px] text-red-600">{keyProblem}</p> : null}
          </div>
        </div>
        <div>
          <FieldLabel htmlFor="environment-variable-description">Description (optional)</FieldLabel>
          <DenTextarea id="environment-variable-description" rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Shown to people in their settings" />
        </div>
      </div>

      <section className="mt-10 grid gap-3" aria-labelledby="environment-variable-access-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="environment-variable-access-heading" className="text-[16px] font-medium tracking-[-0.02em] text-gray-950">Who receives it</h2>
          <DenSegmented aria-label="Who sets the value" options={MODE_OPTIONS} value={valueMode} onChange={setValueMode} optionTestId={(mode) => `environment-variable-mode-${mode}`} />
        </div>

        <div className="divide-y divide-gray-200 overflow-hidden rounded-[16px] border border-gray-200 bg-white">
          <div className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-testid="environment-variable-everyone">
            <div className="flex min-w-48 flex-1 items-center gap-2 text-[14px] text-gray-900">
              <Users aria-hidden className="h-4 w-4 text-gray-500" />
              <span className="truncate">Everyone in {organizationName}</span>
            </div>
            {everyone && adminValues ? <AssignmentValue draft={everyone} label="Everyone" onChange={(next) => update("everyone", next)} /> : null}
            <div className="flex w-11 shrink-0 justify-end">
              <DenSwitch
                checked={Boolean(everyone)}
                onChange={(checked) => (checked ? add("everyone") : remove("everyone"))}
                aria-label={`Everyone in ${organizationName}`}
                testId="environment-variable-everyone-toggle"
              />
            </div>
          </div>

          {teamDrafts.map((draft) => {
            const team = teams.get(draft.target.slice(5));
            const label = team?.name ?? "Team";
            return (
              <div key={draft.target} className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-testid="environment-variable-team">
                <div className="flex min-w-48 flex-1 items-center gap-2 text-[14px] text-gray-900">
                  <Users aria-hidden className="h-4 w-4 text-gray-500" />
                  <span className="truncate">{label}</span>
                </div>
                {adminValues ? <AssignmentValue draft={draft} label={label} onChange={(next) => update(draft.target, next)} /> : null}
                <div className="flex w-11 shrink-0 justify-end">
                  <DenButton variant="ghost" size="sm" onClick={() => remove(draft.target)} aria-label={`Remove ${label}`}>
                    <X className="h-4 w-4" aria-hidden />
                  </DenButton>
                </div>
              </div>
            );
          })}

          {memberDrafts.map((draft) => {
            const member = members.get(draft.target.slice(7));
            const label = member?.user.name ?? "Person";
            return (
              <div key={draft.target} className="flex flex-wrap items-center gap-3 px-4 py-2.5" data-testid="environment-variable-member">
                <div className="flex min-w-48 flex-1 items-center gap-2 text-[14px] text-gray-900">
                  <User aria-hidden className="h-4 w-4 text-gray-500" />
                  <span className="min-w-0 truncate">{label}</span>
                  {member?.user.email ? <span className="min-w-0 truncate text-[12px] text-gray-500">{member.user.email}</span> : null}
                </div>
                {adminValues ? <AssignmentValue draft={draft} label={label} onChange={(next) => update(draft.target, next)} /> : null}
                <div className="flex w-11 shrink-0 justify-end">
                  <DenButton variant="ghost" size="sm" onClick={() => remove(draft.target)} aria-label={`Remove ${label}`}>
                    <X className="h-4 w-4" aria-hidden />
                  </DenButton>
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-3 bg-gray-50/60 px-4 py-2.5">
            <div className="min-w-48 flex-1">
              <DenCombobox
                value=""
                options={teamOptions}
                onChange={(teamId) => { if (teamId) add(`team:${teamId}`); }}
                placeholder={teamOptions.length ? "Add a team" : "No more teams"}
                searchPlaceholder="Search teams"
                emptyLabel="No teams match"
                disabled={teamOptions.length === 0}
                ariaLabel="Add a team"
              />
            </div>
            <div className="min-w-48 flex-1">
              <DenCombobox
                value=""
                options={memberOptions}
                onChange={(memberId) => { if (memberId) add(`member:${memberId}`); }}
                placeholder={memberOptions.length ? "Add a person" : "No more people"}
                searchPlaceholder="Search people"
                emptyLabel="No people match"
                disabled={memberOptions.length === 0}
                ariaLabel="Add a person"
              />
            </div>
          </div>
        </div>

        {drafts.length === 0 ? <p className="text-[13px] text-gray-500">No one receives this variable yet.</p> : null}
        {adminValues && missingValues > 0 && drafts.length > 0 ? (
          <p className="text-[13px] text-gray-500">{missingValues === 1 ? "1 assignment has" : `${missingValues} assignments have`} no value, so it gives no one a value.</p>
        ) : null}
        {adminValues && drafts.length > 1 ? (
          <p className="text-[13px] text-gray-500">Someone with several values gets the most specific: theirs, then their team&apos;s, then everyone&apos;s. They can pick another in their settings.</p>
        ) : null}
        {!adminValues ? (
          <p className="text-[13px] text-gray-600" data-testid="environment-variable-per-member-state">
            {variable?.valueMode === "per_member"
              ? `Set by ${variable.memberValueCount} ${variable.memberValueCount === 1 ? "person" : "people"}. You never see their values.`
              : "Each person adds theirs in OpenWork or under My Variables. You never see their values."}
          </p>
        ) : null}
        {loses ? <DenNotice tone="warning" message={loses} /> : null}
      </section>

      {error ? <DenNotice className="mt-6" tone="error" message={error} /> : null}

      <DenStickyActionBar
        summary={<span>{variable ? "Desktops pick up changes within a few minutes." : "New conversations get the variable within a few minutes."}</span>}
      >
        {variable ? (
          <DenButton variant="destructive" onClick={() => setConfirmDelete(true)} data-testid="environment-variable-delete">
            <Trash2 className="h-4 w-4" aria-hidden />
            Delete
          </DenButton>
        ) : null}
        <Link href={listRoute} className={buttonVariants({ variant: "secondary" })}>Cancel</Link>
        <DenButton onClick={() => void save()} loading={saving} data-testid="environment-variable-save">
          {variable ? "Save changes" : "Add variable"}
        </DenButton>
      </DenStickyActionBar>

      <ConfirmDialog
        destructive
        confirm={confirmDelete && variable ? {
          title: `Delete ${variable.key}?`,
          description: "It's removed from every recipient's agent, with every value stored for it. This can't be undone.",
          action: "Delete variable",
        } : null}
        onConfirm={deleteVariable}
        onClose={() => setConfirmDelete(false)}
      />
    </>
  );
}

function EditorSkeleton() {
  return (
    <div className="grid gap-5" aria-hidden>
      <div className="grid gap-5 sm:grid-cols-2">
        <DenSkeleton className="h-10 w-full" />
        <DenSkeleton className="h-10 w-full" />
      </div>
      <DenSkeleton className="h-16 w-full" />
      <DenSkeleton className="mt-6 h-32 w-full" />
    </div>
  );
}

export function EnvironmentVariableEditorScreen({ environmentVariableId }: { environmentVariableId?: string }) {
  const { orgContext } = useOrgDashboard();
  const enabled = orgFeatureEnabled(orgContext, "environmentVariables");
  const access = getOrgAccessFlags(orgContext?.currentMember.role ?? "member", orgContext?.currentMember.isOwner ?? false, orgContext?.currentMember.permissions);
  const editing = Boolean(environmentVariableId);
  const { data, error, loading } = useOrgEnvironmentVariable(environmentVariableId ?? null, enabled && editing && access.canViewEnvironmentVariables);

  const title = editing ? data?.name ?? "Environment variable" : "Add environment variable";
  return (
    <DashboardPageTemplate icon={Braces} title={title} description={editing ? (data ? <span className="font-mono">{data.key}</span> : "") : "Added to the environment of every recipient's desktop agent."}>
      {!enabled ? (
        <DenNotice tone="info" message="Environment variables aren't turned on for this organization yet." />
      ) : !access.canManageEnvironmentVariables ? (
        <DenNotice tone="neutral" icon={Lock} message="Only organization owners and admins can change environment variables." />
      ) : editing && loading && !data ? (
        <EditorSkeleton />
      ) : editing && error ? (
        <DenNotice tone="error" message={`${error} Go back to Environment Variables and try again.`} />
      ) : (
        // The form owns its fields; remount when a different variable loads.
        <EditorForm key={`${data?.id ?? "new"}:${data?.updatedAt ?? ""}`} variable={data ?? null} />
      )}
    </DashboardPageTemplate>
  );
}
