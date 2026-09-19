"use client";

import { useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { ChevronRight } from "lucide-react";
import type { GatewayAccessGrant, GatewayAudience } from "@openwork/types/den/gateway";
import type { GatewayUsageLimitPolicy } from "@openwork/types/den/gateway-usage-limits";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenChip } from "../../_components/ui/chip";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenNotice } from "../../_components/ui/notice";
import type { DenOrgContext } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { GatewayLimitsRequestError, GatewayLimitsWriteUncertainError, formatLimitMoney, useGatewayLimitsMutation, useGatewayPolicies } from "./gateway-usage-limits-data";
import { timeframeLabels } from "./gateway-usage-policy-editor";
import { GatewayAccessWriteUncertainError, useGatewayAccessProviders, writeSubjectAccess, type GatewayAccessProvider } from "./gateway-subject-access-data";
import { getProviderIconSlug } from "./llm-provider-data";
import { ProviderAccessPicker, type ProviderAccessValue } from "./llm-provider-pickers";

type PolicyAssignment = GatewayUsageLimitPolicy["assignments"][number];
type SubjectCard = {
  audience: GatewayAudience;
  grants: { provider: GatewayAccessProvider; grant: GatewayAccessGrant }[];
  policies: { policy: GatewayUsageLimitPolicy; assignment: PolicyAssignment }[];
};
type Editor = { kind: "access" | "limit"; step: "subject" | "details"; access: ProviderAccessValue; providerId: string; modelGroupId: string; credentialSetId: string; policyId: string; policyRevision: number | null };
type Removal =
  | { kind: "access"; audience: GatewayAudience; provider: GatewayAccessProvider; grant: GatewayAccessGrant }
  | { kind: "limit"; audience: GatewayAudience; policy: GatewayUsageLimitPolicy; assignment: PolicyAssignment };

function subjectKey(audience: GatewayAudience) {
  if (audience.type === "organization") return "organization";
  return audience.type === "member" ? `member:${audience.memberId}` : `team:${audience.teamId}`;
}

function assignmentAudience(assignment: PolicyAssignment): GatewayAudience | null {
  if (assignment.organization === true) return { type: "organization" };
  if (assignment.teamId) return { type: "team", teamId: assignment.teamId };
  if (assignment.memberId) return { type: "member", memberId: assignment.memberId };
  return null;
}

function selectedAudience(access: ProviderAccessValue, directory: DenOrgContext): GatewayAudience | null {
  if (Number(access.allMembers) + access.memberIds.length + access.teamIds.length !== 1) return null;
  if (access.allMembers) return { type: "organization" };
  const memberId = access.memberIds[0];
  if (memberId && directory.members.some((member) => member.id === memberId)) return { type: "member", memberId };
  const teamId = access.teamIds[0];
  return teamId && directory.teams.some((team) => team.id === teamId) ? { type: "team", teamId } : null;
}

function subjectIdentity(audience: GatewayAudience, directory: DenOrgContext) {
  if (audience.type === "organization") return { name: "Everyone", detail: directory.organization.name, kind: "Organization" };
  if (audience.type === "team") {
    const team = directory.teams.find((item) => item.id === audience.teamId);
    return { name: team?.name ?? `Unavailable team (${audience.teamId})`, detail: team ? `${team.memberIds.length} members` : "No longer in the directory", kind: "Team" };
  }
  const member = directory.members.find((item) => item.id === audience.memberId);
  return { name: member?.user.name ?? `Unavailable person (${audience.memberId})`, detail: member?.user.email ?? "No longer in the directory", kind: "Person" };
}

function largestAllowance(policy: GatewayUsageLimitPolicy) {
  return Math.max(0, ...policy.limits.map((limit) => limit.costLimitMicroUsd));
}

function PolicyWindows({ policy }: { policy: GatewayUsageLimitPolicy }) {
  return <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums">
    {policy.limits.map((limit) => <div key={limit.timeframe} className="flex gap-1.5">
      <dt className="text-[var(--ow-muted)]">{timeframeLabels[limit.timeframe]}</dt>
      <dd>{formatLimitMoney(limit.costLimitMicroUsd)}</dd>
    </div>)}
  </dl>;
}

function GroupModelTags({ modelIds }: { modelIds: string[] }) {
  function renderModels(ids: string[]) {
    return <ul className="flex flex-wrap gap-1.5">{ids.map((id) => <li key={id} className="min-w-0 max-w-full"><DenChip size="sm" mono className="max-w-full break-all">{id}</DenChip></li>)}</ul>;
  }
  return <div aria-label="Group models" className="flex flex-col gap-2">
    {renderModels(modelIds.slice(0, 6))}
    {modelIds.length > 6 ? <details className="group/models">
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-[var(--ow-muted)]"><ChevronRight aria-hidden strokeWidth={1.5} className="size-4 transition-transform duration-150 group-open/models:rotate-90 motion-reduce:transition-none" />{modelIds.length - 6} more models</summary>
      <div className="pt-2">{renderModels(modelIds.slice(6))}</div>
    </details> : null}
  </div>;
}

function AssignmentDialog({ title, busy, hidden, onClose, children }: { title: string; busy: boolean; hidden: boolean; onClose: () => void; children: ReactNode }) {
  return <Dialog.Root open={!hidden} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-[var(--ow-ink)]/40" />
      <Dialog.Popup aria-describedby={undefined} aria-busy={busy} className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-2xl border border-[var(--ow-line)] bg-[var(--dls-surface)] p-6 text-[var(--ow-ink)]">
        <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
        {children}
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

function SubjectSkeleton() {
  return <div role="status" aria-label="Loading access assignments" className="flex flex-col gap-4">
    {[0, 1].map((row) => <DenCard key={row} aria-hidden className="flex flex-col gap-4">
      <div className="flex items-center gap-3"><div className="size-10 rounded-full bg-[var(--ow-line)]" /><div className="h-4 w-40 rounded bg-[var(--ow-line)]" /></div>
      <div className="h-4 w-3/4 rounded bg-[var(--ow-line)]" /><div className="h-4 w-1/2 rounded bg-[var(--ow-line)]" />
    </DenCard>)}
  </div>;
}

function SubjectAccessCard({ card, directory, inherited, disabled, onRemove }: { card: SubjectCard; directory: DenOrgContext; inherited: boolean; disabled: boolean; onRemove: (removal: Removal) => void }) {
  const identity = subjectIdentity(card.audience, directory);
  const policies = [...card.policies].sort((a, b) => largestAllowance(b.policy) - largestAllowance(a.policy) || a.policy.name.localeCompare(b.policy.name));
  return <DenCard data-testid="gateway-subject-card" data-subject={subjectKey(card.audience)} className="flex min-w-0 flex-col gap-4">
    <header className="flex items-center gap-3">
      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--ow-line)] text-sm font-semibold">{identity.name.split(" ").map((part) => part[0]).join("").slice(0, 2)}</span>
      <div className="min-w-0 flex-1"><h3 className="break-words font-semibold">{identity.name}</h3><p className="break-words text-xs text-[var(--ow-muted)]">{identity.detail}</p></div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <DenChip tone={card.audience.type === "organization" ? "success" : card.audience.type === "member" ? "info" : "warning"}>
          {card.audience.type === "organization" ? "Everyone" : card.audience.type === "member" ? "User" : "Team"}
        </DenChip>
        {inherited ? <DenChip>Inherited</DenChip> : null}
      </div>
    </header>
    <h4 className="text-xs font-medium text-[var(--ow-muted)]">Providers</h4>
    {card.grants.length ? <ul aria-label={`Provider access for ${identity.name}`} className="divide-y divide-[var(--ow-line)]">
      {card.grants.map(({ provider, grant }) => {
        const group = provider.modelGroups.find((item) => item.id === grant.modelGroupId);
        const credential = provider.credentialSets.find((item) => item.id === grant.credentialSetId);
        const unavailable = !group || !credential;
        const disabledAccess = provider.status === "disabled" || group?.status === "disabled" || credential?.status === "disabled";
        return <li key={`${provider.id}:${grant.id}`} className="flex items-start gap-3 py-3">
          <DenBrandMark name={provider.name} simpleIconSlug={getProviderIconSlug(provider.providerId)} className="size-8 rounded-lg" imageClassName="size-4" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2"><span className="break-words text-sm font-medium">{provider.name}</span>{disabledAccess ? <DenChip>Disabled</DenChip> : null}</div>
            <p className="break-words text-xs text-[var(--ow-muted)]">{group?.name ?? `Unavailable group (${grant.modelGroupId})`} / {credential?.name ?? `Unavailable upstream key (${grant.credentialSetId})`}</p>
            {credential?.credentialMode === "member" ? <span className="text-xs text-[var(--ow-muted)]">Each member signs in</span> : credential && !credential.configured ? <span className="text-xs text-[var(--ow-muted)]">Upstream key not configured</span> : null}
            {group?.modelIds.length ? <GroupModelTags modelIds={group.modelIds} /> : <p className="text-xs text-[var(--ow-muted)]">{group ? "No models in this group" : "Group models unavailable"}</p>}
            {unavailable ? <p className="text-xs text-[var(--ow-muted)]">This grant references an unavailable definition. Review it in AI Providers or remove this grant.</p> : null}
          </div>
          <DenButton variant="ghost" size="sm" disabled={disabled} aria-label={`Remove ${provider.name} / ${group?.name ?? grant.modelGroupId} / ${credential?.name ?? grant.credentialSetId} from ${identity.name}`} onClick={() => onRemove({ kind: "access", audience: card.audience, provider, grant })}>Remove</DenButton>
        </li>;
      })}
    </ul> : <p className="text-sm text-[var(--ow-muted)]">No direct provider grants</p>}
    <section aria-label={`Usage limits for ${identity.name}`} className="flex flex-col gap-2 border-t border-[var(--ow-line)] pt-4">
      <h4 className="text-xs font-medium text-[var(--ow-muted)]">Usage limit policies</h4>
      {policies.length ? <ul className="divide-y divide-[var(--ow-line)]">{policies.map(({ policy, assignment }) => <li key={assignment.id} className="flex items-start justify-between gap-3 py-3 first:pt-0">
        <div className="flex min-w-0 flex-col gap-1.5"><span className="break-words text-sm font-medium">{policy.name}</span><PolicyWindows policy={policy} /><span className="text-xs text-[var(--ow-muted)]">{policy.hardLimit ? "Hard limit" : "Soft limit"}</span></div>
        <DenButton variant="ghost" size="sm" disabled={disabled} aria-label={`Unassign ${policy.name} from ${identity.name}`} onClick={() => onRemove({ kind: "limit", audience: card.audience, policy, assignment })}>Unassign</DenButton>
      </li>)}</ul> : <p className="text-sm text-[var(--ow-muted)]">No directly assigned policies</p>}
    </section>
  </DenCard>;
}

export function GatewayUsersTeamsSection({ orgId, orgContext }: { orgId: string; orgContext: DenOrgContext }) {
  const providers = useGatewayAccessProviders(orgId);
  const policies = useGatewayPolicies(orgId);
  const mutation = useGatewayLimitsMutation(orgId);
  const { runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const [filter, setFilter] = useState("all");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const activePolicies = (policies.data?.policies ?? []).filter((policy) => !policy.archivedAt);
  const dataError = providers.error?.message ?? policies.error?.message;
  const loading = providers.isPending || policies.isPending;
  const fetching = providers.isFetching || policies.isFetching;
  const blocked = busy || fetching || Boolean(dataError) || needsRefresh;
  const cards = new Map<string, SubjectCard>();
  function ensureCard(audience: GatewayAudience) {
    const key = subjectKey(audience);
    let card = cards.get(key);
    if (!card) { card = { audience, grants: [], policies: [] }; cards.set(key, card); }
    return card;
  }
  for (const provider of providers.data ?? []) {
    for (const grant of provider.accessGrants) ensureCard(grant.audience).grants.push({ provider, grant });
  }
  let invalidAssignment = false;
  for (const policy of activePolicies) {
    for (const assignment of policy.assignments) {
      const audience = assignmentAudience(assignment);
      if (audience) ensureCard(audience).policies.push({ policy, assignment });
      else invalidAssignment = true;
    }
  }
  const directorySubjects: GatewayAudience[] = [
    { type: "organization" },
    ...orgContext.members.map((member): GatewayAudience => ({ type: "member", memberId: member.id })),
    ...orgContext.teams.map((team): GatewayAudience => ({ type: "team", teamId: team.id })),
  ];
  const filterSubjects = new Map(directorySubjects.map((audience) => [subjectKey(audience), audience]));
  for (const [key, card] of cards) filterSubjects.set(key, card.audience);
  const selected = filterSubjects.get(filter);
  const visible = [...cards.values()].filter((card) => {
    if (filter === "all") return true;
    if (!selected) return false;
    if (subjectKey(card.audience) === filter) return true;
    return selected.type === "member" && card.audience.type === "team"
      && orgContext.teams.some((team) => card.audience.type === "team" && team.id === card.audience.teamId && team.memberIds.includes(selected.memberId));
  }).sort((a, b) => Number(b.audience.type === "organization") - Number(a.audience.type === "organization")
    || subjectIdentity(a.audience, orgContext).name.localeCompare(subjectIdentity(b.audience, orgContext).name));
  const everyone = visible.filter((card) => card.audience.type === "organization");
  const users = visible.filter((card) => card.audience.type === "member");
  const teams = visible.filter((card) => card.audience.type === "team");
  const audience = editor ? selectedAudience(editor.access, orgContext) : null;
  const provider = providers.data?.find((item) => item.id === editor?.providerId);
  const group = provider?.modelGroups.find((item) => item.id === editor?.modelGroupId);
  const credential = provider?.credentialSets.find((item) => item.id === editor?.credentialSetId);
  const policy = activePolicies.find((item) => item.id === editor?.policyId);
  const duplicate = Boolean(audience && (editor?.kind === "access"
    ? provider?.accessGrants.some((grant) => subjectKey(grant.audience) === subjectKey(audience) && grant.modelGroupId === editor.modelGroupId && grant.credentialSetId === editor.credentialSetId)
    : policy?.assignments.some((assignment) => { const target = assignmentAudience(assignment); return target && subjectKey(target) === subjectKey(audience); })));
  const policyChanged = Boolean(editor?.kind === "limit" && editor.policyId && policy?.revision !== editor.policyRevision);
  const validDetails = editor?.kind === "access"
    ? Boolean(provider && group && credential)
    : Boolean(policy && !policyChanged);
  const saveBlocked = blocked || invalidAssignment || !audience || !validDetails || duplicate;

  function openEditor(kind: Editor["kind"]) {
    if (blocked || invalidAssignment) return;
    setError(null);
    setNotice(null);
    setEditor({ kind, step: "subject", access: { allMembers: false, memberIds: [], teamIds: [] }, providerId: "", modelGroupId: "", credentialSetId: "", policyId: "", policyRevision: null });
  }

  async function refresh() {
    if (busyRef.current) return;
    setBusy(true);
    busyRef.current = true;
    try {
      const [nextProviders, nextPolicies] = await Promise.all([providers.refetch(), policies.refetch()]);
      if (nextProviders.isSuccess && nextPolicies.isSuccess) {
        setNeedsRefresh(false);
        setError(null);
        setNotice("Assignments refreshed. Review the current cards before making another change.");
      }
    } finally { setBusy(false); busyRef.current = false; }
  }

  function writeError(cause: unknown) {
    setError(cause instanceof Error ? cause.message : "Could not update assignments. Refresh and review the current state.");
    if (cause instanceof GatewayLimitsWriteUncertainError || cause instanceof GatewayAccessWriteUncertainError
      || (cause instanceof GatewayLimitsRequestError && (cause.status === 409 || cause.status >= 500))) setNeedsRefresh(true);
  }

  async function save() {
    if (!editor || !audience || saveBlocked || busyRef.current) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      if (editor.kind === "access" && provider && group && credential) {
        await runReauthableAction("assign-gateway-subject-access", () => writeSubjectAccess(orgId, provider.id, {
          body: { audience, modelGroupId: group.id, credentialSetId: credential.id },
        }));
        await providers.refetch();
      } else if (editor.kind === "limit" && policy) {
        await mutation.mutateAsync({ type: "assign", policyId: policy.id, target: audience.type === "organization"
          ? { organization: true } : audience.type === "team" ? { teamId: audience.teamId } : { memberId: audience.memberId } });
      } else return;
      setEditor(null);
      setNotice(editor.kind === "access" ? "Access policy added." : "Usage limit applied.");
    } catch (cause) { writeError(cause); }
    finally { setBusy(false); busyRef.current = false; }
  }

  const currentRemovalPolicy = removal?.kind === "limit" ? activePolicies.find((item) => item.id === removal.policy.id) : null;
  const currentRemovalGrant = removal?.kind === "access" ? providers.data?.find((item) => item.id === removal.provider.id)?.accessGrants.find((item) => item.id === removal.grant.id) : null;
  const removalChanged = removal?.kind === "limit"
    ? currentRemovalPolicy?.revision !== removal.policy.revision || !currentRemovalPolicy?.assignments.some((item) => item.id === removal.assignment.id)
    : removal?.kind === "access" ? !currentRemovalGrant || currentRemovalGrant.modelGroupId !== removal.grant.modelGroupId
      || currentRemovalGrant.credentialSetId !== removal.grant.credentialSetId || subjectKey(currentRemovalGrant.audience) !== subjectKey(removal.audience) : false;

  async function remove() {
    if (!removal || blocked || removalChanged || busyRef.current) return;
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      if (removal.kind === "access") {
        await runReauthableAction("remove-gateway-subject-access", () => writeSubjectAccess(orgId, removal.provider.id, { grantId: removal.grant.id }));
        await providers.refetch();
      } else {
        await mutation.mutateAsync({ type: "unassign", policyId: removal.policy.id, assignmentId: removal.assignment.id });
      }
      setRemoval(null);
      setNotice(removal.kind === "access" ? "Access grant removed." : "Usage limit unassigned.");
    } catch (cause) { writeError(cause); }
    finally { setBusy(false); busyRef.current = false; }
  }

  function renderCard(card: SubjectCard) {
    return <SubjectAccessCard key={subjectKey(card.audience)} card={card} directory={orgContext} inherited={Boolean(selected && subjectKey(card.audience) !== filter)} disabled={blocked || invalidAssignment} onRemove={(target) => { setError(null); setRemoval(target); }} />;
  }

  return <section aria-label="Users and teams assignments" data-testid="gateway-users-teams" className="flex flex-col gap-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap gap-3">
        <DenButton disabled={blocked || invalidAssignment} onClick={() => openEditor("access")}>Add new access policy</DenButton>
        <DenButton variant="secondary" disabled={blocked || invalidAssignment} onClick={() => openEditor("limit")}>Apply new usage limit</DenButton>
      </div>
      <DenButton variant="ghost" disabled={busy || fetching} onClick={() => void refresh()}>Refresh assignments</DenButton>
    </div>
    <DenCombobox ariaLabel="Filter users and teams" value={filter} onChange={setFilter} placeholder="All users and teams" searchPlaceholder="Search people or teams" options={[
      { value: "all", label: "All users and teams" },
      ...[...filterSubjects.values()].map((target) => { const identity = subjectIdentity(target, orgContext); return { value: subjectKey(target), label: identity.name, description: `${identity.kind}: ${identity.detail}` }; }),
    ]} />
    {notice ? <p role="status" className="text-sm text-[var(--ow-muted)]">{notice}</p> : null}
    {needsRefresh ? <DenNotice tone="warning" message="An update needs review. Close the dialog and refresh assignments before making another change." /> : null}
    {error && !editor && !removal ? <DenNotice tone="error" message={error} /> : null}
    {dataError ? <DenNotice tone="error" message={`${dataError} Use Refresh assignments to verify the current state.`} /> : null}
    {dataError && providers.data && policies.data ? <p className="text-xs text-[var(--ow-muted)]">Showing last confirmed assignments from {new Date(Math.min(providers.dataUpdatedAt, policies.dataUpdatedAt)).toLocaleString()}. Changes are disabled.</p> : null}
    {invalidAssignment ? <DenNotice tone="error" message="Some usage assignments have no recognized subject. Refresh or ask an administrator to update the Gateway API before making changes." /> : null}
    {loading ? <SubjectSkeleton /> : providers.data && policies.data ? <>
      {everyone.map(renderCard)}
      {users.map(renderCard)}
      {teams.map(renderCard)}
      {!visible.length && !invalidAssignment && !dataError ? <DenCard className="flex flex-col items-start gap-3"><p className="text-sm text-[var(--ow-muted)]">{filter === "all" ? "No access or usage limit assignments yet." : "No direct or inherited assignments for this selection."}</p><DenButton variant="secondary" disabled={blocked} onClick={() => openEditor("access")}>Add new access policy</DenButton></DenCard> : null}
    </> : null}
    {editor ? <AssignmentDialog title={editor.kind === "access" ? "Add new access policy" : "Apply new usage limit"} hidden={reauthDialogOpen} busy={busy} onClose={() => setEditor(null)}>
      <p className="text-xs text-[var(--ow-muted)]">{editor.step === "subject" ? "1 of 2: People, teams or everyone" : `2 of 2: ${audience ? subjectIdentity(audience, orgContext).name : "Choose a subject"}`}</p>
      {error ? <DenNotice tone="error" message={error} /> : null}
      {dataError ? <DenNotice tone="error" message="Assignments could not be refreshed. Close this dialog and refresh before saving." /> : null}
      <fieldset disabled={busy || needsRefresh} className="flex min-w-0 flex-col gap-4">
        <legend className="sr-only">Assignment</legend>
        {editor.step === "subject" ? <ProviderAccessPicker orgContext={orgContext} value={editor.access} onChange={(access) => setEditor({ ...editor, access })} lockedMemberId={null} singleAudience everyoneDescription={editor.kind === "limit" ? "This usage limit policy applies to each current member and anyone who joins later." : undefined} testIdPrefix="gateway-subject" /> : editor.kind === "access" ? <>
          <Field.Root className="flex flex-col gap-2"><Field.Label className="text-sm font-medium">Provider</Field.Label><DenCombobox ariaLabel="Provider" value={editor.providerId} onChange={(providerId) => {
            const next = providers.data?.find((item) => item.id === providerId);
            const keys = next?.credentialSets ?? [];
            setEditor({ ...editor, providerId, modelGroupId: "", credentialSetId: keys.length === 1 ? keys[0].id : "" });
          }} options={(providers.data ?? []).map((item) => ({ value: item.id, label: item.name, description: item.status === "disabled" ? "Disabled" : undefined, icon: <DenBrandMark name={item.name} simpleIconSlug={getProviderIconSlug(item.providerId)} className="size-6 rounded-lg" imageClassName="size-4" /> }))} placeholder="Choose provider" emptyLabel="Add a provider in AI Providers first" /></Field.Root>
          {provider ? <>
            <Field.Root className="flex flex-col gap-2"><Field.Label className="text-sm font-medium">Model group</Field.Label><DenCombobox ariaLabel="Model group" value={editor.modelGroupId} onChange={(modelGroupId) => setEditor({ ...editor, modelGroupId })} options={provider.modelGroups.map((item) => ({ value: item.id, label: item.name, description: item.status === "disabled" ? "Disabled" : undefined, meta: `${item.modelIds.length} models` }))} placeholder="Choose model group" emptyLabel="Create a model group in AI Providers first" /></Field.Root>
            <Field.Root className="flex flex-col gap-2"><Field.Label className="text-sm font-medium">Upstream key</Field.Label><DenCombobox ariaLabel="Upstream key" value={editor.credentialSetId} onChange={(credentialSetId) => setEditor({ ...editor, credentialSetId })} options={provider.credentialSets.map((item) => ({ value: item.id, label: item.name, description: item.status === "disabled" ? "Disabled" : item.credentialMode === "member" ? "Each member signs in" : item.configured ? "Configured" : "Not configured" }))} placeholder="Choose upstream key" emptyLabel="Create an upstream key in AI Providers first" /></Field.Root>
            {provider.status === "disabled" || group?.status === "disabled" || credential?.status === "disabled" ? <DenNotice tone="warning" message="Access can be saved, but the provider, model group and upstream key must all be active before these models can be used." /> : null}
            {group ? <GroupModelTags modelIds={group.modelIds} /> : null}
            {group && !group.modelIds.length ? <DenNotice tone="warning" message="This group has no models. The grant will not provide model access until models are added." /> : null}
            {credential && !credential.configured ? <DenNotice tone="warning" message={credential.credentialMode === "member" ? "Members must authorize this upstream connection before using these models." : "This upstream key is not configured. Requests cannot use it until an administrator adds credentials."} /> : null}
          </> : null}
        </> : <>
          <Field.Root className="flex flex-col gap-2"><Field.Label className="text-sm font-medium">Usage limit policy</Field.Label><DenCombobox ariaLabel="Usage limit policy" value={editor.policyId} onChange={(policyId) => setEditor({ ...editor, policyId, policyRevision: activePolicies.find((item) => item.id === policyId)?.revision ?? null })} options={[...activePolicies].sort((a, b) => largestAllowance(b) - largestAllowance(a) || a.name.localeCompare(b.name)).map((item) => ({ value: item.id, label: item.name, description: item.limits.map((limit) => `${timeframeLabels[limit.timeframe]}: ${formatLimitMoney(limit.costLimitMicroUsd)}`).join(" / ") }))} placeholder="Choose usage limit policy" emptyLabel="Create a policy in Limits first" /></Field.Root>
          {policy ? <><PolicyWindows policy={policy} /><p className="text-xs text-[var(--ow-muted)]">{policy.hardLimit ? "Hard limit" : "Soft limit"}. All listed timeframes apply; amounts are not added together.</p></> : null}
          {policyChanged ? <DenNotice tone="warning" message="This policy changed. Select it again to review the latest limits before saving." /> : null}
        </>}
        {duplicate ? <p role="status" className="text-sm text-[var(--ow-muted)]">This assignment already exists.</p> : null}
      </fieldset>
      <div className="flex flex-wrap justify-end gap-3">
        <DenButton variant="ghost" disabled={busy} onClick={() => setEditor(null)}>{needsRefresh ? "Close and review" : "Cancel"}</DenButton>
        {editor.step === "details" ? <DenButton variant="secondary" disabled={busy || needsRefresh} onClick={() => setEditor({ ...editor, step: "subject" })}>Back</DenButton> : null}
        {editor.step === "subject" ? <DenButton disabled={!audience || blocked} onClick={() => setEditor({ ...editor, step: "details" })}>Continue</DenButton> : <DenButton loading={busy} disabled={saveBlocked} onClick={() => void save()}>{editor.kind === "access" ? "Save access policy" : "Apply usage limit"}</DenButton>}
      </div>
    </AssignmentDialog> : null}
    {removal ? <AssignmentDialog title={removal.kind === "access" ? "Remove provider access?" : "Unassign usage limit?"} hidden={reauthDialogOpen} busy={busy} onClose={() => setRemoval(null)}>
      <p className="break-words text-sm">{subjectIdentity(removal.audience, orgContext).name}: {removal.kind === "access" ? `${removal.provider.name} / ${removal.provider.modelGroups.find((item) => item.id === removal.grant.modelGroupId)?.name ?? removal.grant.modelGroupId} / ${removal.provider.credentialSets.find((item) => item.id === removal.grant.credentialSetId)?.name ?? removal.grant.credentialSetId}` : removal.policy.name}</p>
      {removal.kind === "limit" ? <PolicyWindows policy={removal.policy} /> : null}
      <p className="text-sm text-[var(--ow-muted)]">{removal.kind === "access" ? "Only this grant will be removed. Other direct, team and Everyone grants remain." : "Only this assignment will be removed. Other policies remain; without another policy, this subject has no usage limit policy."}{removal.audience.type !== "member" ? " This affects everyone covered by this subject." : ""}</p>
      {error ? <DenNotice tone="error" message={error} /> : null}
      {removalChanged ? <DenNotice tone="warning" message="This assignment changed. Cancel and review the latest cards before removing it." /> : null}
      {dataError ? <DenNotice tone="error" message="Assignments could not be verified. Close this dialog and refresh." /> : null}
      <div className="flex flex-wrap justify-end gap-3"><DenButton variant="secondary" disabled={busy} onClick={() => setRemoval(null)}>{needsRefresh ? "Close and review" : "Cancel"}</DenButton><DenButton variant="destructive" disabled={blocked || removalChanged} loading={busy} onClick={() => void remove()}>{removal.kind === "access" ? "Remove access" : "Unassign limit"}</DenButton></div>
    </AssignmentDialog> : null}
  </section>;
}
