"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Check, Globe, Plus, RefreshCw, User, Users } from "lucide-react";
import type { GatewayAccessGrantWrite } from "@openwork/types/den/gateway";
import { createAuditOperationContext } from "@openwork/types/den/audit";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { DenSwitch } from "../../_components/ui/switch";
import { getAiGatewayProviderRoute, getAiGatewayProvidersRoute, getNewAiGatewayProviderRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { deleteGatewayResource, deleteInferenceProvider, saveGatewayResource } from "./inference-provider-data";
import type { DenInferenceProviderDetails } from "./inference-provider-request";
import {
  LITELLM_DOC_URL, createLiteLlmProvider, liteLlmAccessGroupId, liteLlmAccessTitle, liteLlmAttentionLabel, liteLlmCreateError, liteLlmIssueStrategyLabel, liteLlmKeyLabel,
  liteLlmMirrorFallbackLabel, liteLlmModeLabel, liteLlmSpendLabel, liteLlmStatusMode, liteLlmSyncSummary, liteLlmSyncedLabel, replaceLiteLlmKey, syncLiteLlmProvider,
  updateLiteLlmIssue, type LiteLlmIssueStrategy, type LiteLlmMirrorFallback, type LiteLlmMode,
} from "./litellm-provider-data";

const CARD = "rounded-[12px] border border-gray-100 bg-white p-4";
const CARD_TITLE = "text-[13px] font-medium text-gray-900";
const LABEL = "mt-3 block text-[12px] font-medium text-gray-700";
const ROW = "flex min-h-10 items-center gap-3 py-2 text-[13px]";

type Audience = GatewayAccessGrantWrite["audience"];
type AccessValue = { allMembers: boolean; memberIds: string[]; teamIds: string[] };

function Mark({ size = "md" }: { size?: "sm" | "md" }) {
  return <DenBrandMark name="LiteLLM" serviceUrl={LITELLM_DOC_URL} className={size === "sm" ? "h-7 w-7 rounded-[7px]" : "h-8 w-8 rounded-[8px]"} imageClassName={size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4"} />;
}

/** People and teams picker shared by setup and the saved provider. */
function AccessList({ title, value, onAdd, onRemove, onEveryone, busy }: {
  title: string; value: AccessValue; busy: boolean;
  onAdd: (audience: Audience) => void; onRemove: (audience: Audience) => void; onEveryone: (checked: boolean) => void;
}) {
  const { orgContext } = useOrgDashboard();
  const [adding, setAdding] = useState<"person" | "team" | null>(null);
  const teams = orgContext?.teams ?? [];
  const members = orgContext?.members ?? [];
  const teamOptions = teams.filter((team) => !value.teamIds.includes(team.id)).map((team) => ({ value: team.id, label: team.name, description: `${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}` }));
  const memberOptions = members.filter((member) => !value.memberIds.includes(member.id)).map((member) => ({ value: member.id, label: member.user.name, description: member.user.email }));
  return (
    <section className={`${CARD} mt-3`} aria-labelledby="litellm-access-heading">
      <h2 id="litellm-access-heading" className={CARD_TITLE}>{title}</h2>
      <div className={`${ROW} mt-1`}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><Globe className="h-4 w-4" aria-hidden="true" strokeWidth={1.5} /></span>
        <span className="min-w-0 flex-1 font-medium text-gray-900">Everyone in the organization</span>
        <DenSwitch checked={value.allMembers} disabled={busy} aria-label="Everyone in the organization" testId="litellm-access-everyone" onChange={onEveryone} />
      </div>
      {!value.allMembers && (value.teamIds.length || value.memberIds.length) ? (
        <ul className="divide-y divide-gray-100 border-t border-gray-100">
          {value.teamIds.map((teamId) => {
            const team = teams.find((entry) => entry.id === teamId);
            return (
              <li key={teamId} className={ROW} data-testid="litellm-access-row">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><Users className="h-4 w-4" aria-hidden="true" strokeWidth={1.5} /></span>
                <span className="min-w-0 flex-1 text-gray-900">{team?.name ?? "Team"}</span>
                <DenButton size="sm" variant="ghost" disabled={busy} onClick={() => onRemove({ type: "team", teamId })}>Remove</DenButton>
              </li>
            );
          })}
          {value.memberIds.map((memberId) => {
            const member = members.find((entry) => entry.id === memberId);
            return (
              <li key={memberId} className={ROW} data-testid="litellm-access-row">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><User className="h-4 w-4" aria-hidden="true" strokeWidth={1.5} /></span>
                <span className="min-w-0 flex-1"><span className="block text-gray-900">{member?.user.name ?? "Person"}</span><span className="block text-[12px] text-gray-500">{member?.user.email ?? ""}</span></span>
                <DenButton size="sm" variant="ghost" disabled={busy} onClick={() => onRemove({ type: "member", memberId })}>Remove</DenButton>
              </li>
            );
          })}
        </ul>
      ) : null}
      {!value.allMembers ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <DenButton size="xs" variant="secondary" icon={Plus} disabled={busy} onClick={() => setAdding(adding === "person" ? null : "person")}>Add person</DenButton>
          <DenButton size="xs" variant="secondary" icon={Plus} disabled={busy} onClick={() => setAdding(adding === "team" ? null : "team")}>Add team</DenButton>
          {adding ? (
            <div className="w-[280px]">
              <DenCombobox ariaLabel={adding === "team" ? "Team" : "Person"} value="" options={adding === "team" ? teamOptions : memberOptions}
                placeholder={adding === "team" ? "Choose a team…" : "Choose a person…"} searchPlaceholder={adding === "team" ? "Search teams" : "Search people"} emptyLabel={adding === "team" ? "No teams to add" : "No people to add"}
                onChange={(id) => { onAdd(adding === "team" ? { type: "team", teamId: id } : { type: "member", memberId: id }); setAdding(null); }} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function addAudience(value: AccessValue, audience: Audience): AccessValue {
  if (audience.type === "organization") return { allMembers: true, memberIds: [], teamIds: [] };
  return audience.type === "team" ? { ...value, teamIds: [...new Set([...value.teamIds, audience.teamId])] } : { ...value, memberIds: [...new Set([...value.memberIds, audience.memberId])] };
}
function removeAudience(value: AccessValue, audience: Audience): AccessValue {
  if (audience.type === "organization") return { ...value, allMembers: false };
  return audience.type === "team" ? { ...value, teamIds: value.teamIds.filter((id) => id !== audience.teamId) } : { ...value, memberIds: value.memberIds.filter((id) => id !== audience.memberId) };
}

/** Setup for a new LiteLLM provider: proxy URL, key mode, key, and who gets access. */
export function LiteLlmSetupScreen({ embedded = false }: { embedded?: boolean }) {
  const Heading = embedded ? "h2" : "h1";
  const router = useRouter();
  const { orgSlug, runReauthableAction } = useOrgDashboard();
  const [baseUrl, setBaseUrl] = useState("");
  const [mode, setMode] = useState<LiteLlmMode>("org");
  const [issueStrategy, setIssueStrategy] = useState<LiteLlmIssueStrategy>("per_team");
  const [mirrorFallback, setMirrorFallback] = useState<LiteLlmMirrorFallback>("per_team");
  const [apiKey, setApiKey] = useState("");
  const [access, setAccess] = useState<AccessValue>({ allMembers: true, memberIds: [], teamIds: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const input = { name: "LiteLLM", baseUrl, mode, apiKey, access, issueStrategy, mirrorFallback };
    const invalid = liteLlmCreateError(input);
    if (invalid) return setError(invalid);
    setError(null);
    setSaving(true);
    try {
      await runReauthableAction("create-litellm-provider", async () => {
        const { provider } = await createLiteLlmProvider(input, createAuditOperationContext());
        router.push(getAiGatewayProviderRoute(orgSlug, provider.id));
        router.refresh();
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect LiteLLM.");
    } finally { setSaving(false); }
  }

  return (
    <div className={embedded ? "pb-28" : "mx-auto max-w-[860px] px-6 py-6 pb-28"}>
      <nav className="text-[12px] text-gray-500" aria-label="Breadcrumb">
        <Link href={getAiGatewayProvidersRoute(orgSlug)} className="hover:text-gray-900">AI Providers</Link>
        <span className="mx-1.5 text-gray-300">/</span><Link href={getNewAiGatewayProviderRoute(orgSlug)} className="hover:text-gray-900">Add a provider</Link>
        <span className="mx-1.5 text-gray-300">/</span><span className="text-gray-900">LiteLLM</span>
      </nav>
      <div className="mt-3 flex items-center gap-3">
        <Mark />
        <Heading className="text-[20px] font-medium tracking-[-0.02em] text-gray-900" data-testid="gateway-provider-title">Add LiteLLM</Heading>
      </div>
      {error ? <DenNotice tone="error" message={error} className="mt-4" /> : null}

      <section className={`${CARD} mt-5`} aria-labelledby="litellm-connection-heading">
        <h2 id="litellm-connection-heading" className={CARD_TITLE}>Connection</h2>
        <label className={LABEL}>Proxy URL
          <DenInput className="mt-1.5 font-mono text-[12px]" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://litellm.example.com" data-testid="litellm-base-url" autoComplete="off" />
        </label>
        <DenSegmented<LiteLlmMode> className="mt-3" aria-label="Keys" value={mode} options={[
          { value: "org", label: liteLlmModeLabel("org") },
          { value: "member", label: liteLlmModeLabel("member") },
          { value: "issued", label: liteLlmModeLabel("issued") },
        ]} onChange={(next) => { setMode(next); setApiKey(""); }} />
        {mode === "issued" ? (
          <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="flex items-center gap-2 text-[12px] text-gray-700">Keys
              <DenSegmented<LiteLlmIssueStrategy> aria-label="How keys are created" value={issueStrategy} options={[
                { value: "per_team", label: liteLlmIssueStrategyLabel("per_team") },
                { value: "mirror", label: liteLlmIssueStrategyLabel("mirror") },
              ]} onChange={setIssueStrategy} />
            </span>
            {issueStrategy === "mirror" ? (
              <span className="flex items-center gap-2 text-[12px] text-gray-700">No key to copy
                <DenSegmented<LiteLlmMirrorFallback> aria-label="No key to copy" value={mirrorFallback} options={[
                  { value: "per_team", label: liteLlmMirrorFallbackLabel("per_team") },
                  { value: "error", label: liteLlmMirrorFallbackLabel("error") },
                ]} onChange={setMirrorFallback} />
              </span>
            ) : null}
          </div>
        ) : null}
        <p className="mt-2 text-[12px] text-gray-500" data-testid="litellm-spend-tracking">Spend tracking: {liteLlmSpendLabel({ spendTracking: mode === "org" })}</p>
        <label className={LABEL}>{liteLlmKeyLabel(mode)}
          <DenInput className="mt-1.5 font-mono text-[12px]" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" data-testid="litellm-api-key" autoComplete="new-password" />
        </label>
      </section>

      <AccessList title={liteLlmAccessTitle(mode)} value={access} busy={saving}
        onEveryone={(checked) => setAccess(checked ? { allMembers: true, memberIds: [], teamIds: [] } : { allMembers: false, memberIds: [], teamIds: [] })}
        onAdd={(audience) => setAccess((current) => addAudience({ ...current, allMembers: false }, audience))}
        onRemove={(audience) => setAccess((current) => removeAudience(current, audience))} />

      <DenStickyActionBar summary={<span>{liteLlmModeLabel(mode)} · {access.allMembers ? "everyone" : `${access.teamIds.length + access.memberIds.length} teams or people`}</span>}>
        <Link href={getAiGatewayProvidersRoute(orgSlug)} className={buttonVariants({ variant: "secondary" })}>Cancel</Link>
        <DenButton data-testid="litellm-connect" loading={saving} onClick={() => void connect()}>Connect LiteLLM</DenButton>
      </DenStickyActionBar>
    </div>
  );
}

/** A saved LiteLLM provider: sync state, key, groups and access. */
export function LiteLlmProviderScreen({ provider, reload, embedded = false }: { provider: DenInferenceProviderDetails; reload: () => Promise<void>; embedded?: boolean }) {
  const Heading = embedded ? "h2" : "h1";
  const router = useRouter();
  const { orgSlug, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const status = provider.litellm;
  const uiMode: LiteLlmMode = status ? liteLlmStatusMode(status) : "org";
  const [busy, setBusy] = useState<"sync" | "key" | "access" | "issue" | "remove" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const accessGroupId = liteLlmAccessGroupId(provider);
  const set = provider.credentialSets[0] ?? null;
  const grants = provider.accessGrants.filter((grant) => grant.modelGroupId === accessGroupId && grant.credentialSetId === set?.id);
  const access: AccessValue = {
    allMembers: grants.some((grant) => grant.audience.type === "organization"),
    teamIds: grants.flatMap((grant) => grant.audience.type === "team" ? [grant.audience.teamId] : []),
    memberIds: grants.flatMap((grant) => grant.audience.type === "member" ? [grant.audience.memberId] : []),
  };
  const modelGroups = provider.modelGroups.filter((group) => group.id !== accessGroupId || uiMode === "org");

  async function run(kind: "sync" | "key" | "access" | "issue", label: string, action: () => Promise<string | null>) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await runReauthableAction(label, async () => {
        const message = await action();
        await reload();
        setNotice(message);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Something went wrong. Try again.");
      await reload().catch(() => undefined);
    } finally { setBusy(null); }
  }

  const sync = () => run("sync", "sync-litellm-provider", async () => liteLlmSyncSummary((await syncLiteLlmProvider(provider.id, createAuditOperationContext())).sync));
  const saveKey = () => {
    if (!apiKey.trim()) return setError(`Paste the new ${status ? liteLlmKeyLabel(status.mode).toLowerCase() : "key"}.`);
    return run("key", "replace-litellm-key", async () => {
      const result = await replaceLiteLlmKey(provider.id, apiKey, createAuditOperationContext());
      setApiKey("");
      setReplacing(false);
      return `Key replaced. ${liteLlmSyncSummary(result.sync)}`;
    });
  };
  const changeIssue = (input: { issueStrategy?: LiteLlmIssueStrategy; mirrorFallback?: LiteLlmMirrorFallback }) =>
    run("issue", "update-litellm-key-creation", async () => `Key creation updated. ${liteLlmSyncSummary((await updateLiteLlmIssue(provider.id, input, createAuditOperationContext())).sync)}`);
  const addGrant = (audience: Audience) => run("access", "add-litellm-access", async () => {
    if (!accessGroupId || !set) throw new Error("Sync LiteLLM before granting access.");
    const context = createAuditOperationContext();
    await saveGatewayResource(provider.id, null, { resource: "access-grants", body: { audience, modelGroupId: accessGroupId, credentialSetId: set.id } }, context);
    if (audience.type === "organization") for (const grant of grants) if (grant.audience.type !== "organization") await deleteGatewayResource(provider.id, "access-grants", grant.id, context);
    return null;
  });
  const removeGrant = (audience: Audience) => run("access", "remove-litellm-access", async () => {
    const grant = grants.find((entry) => JSON.stringify(entry.audience) === JSON.stringify(audience));
    if (grant) await deleteGatewayResource(provider.id, "access-grants", grant.id, createAuditOperationContext());
    return null;
  });

  async function remove() {
    setBusy("remove");
    setError(null);
    try {
      await runReauthableAction("delete-inference-provider", async () => {
        await deleteInferenceProvider(provider.id, createAuditOperationContext());
        setConfirmDelete(false);
        router.push(getAiGatewayProvidersRoute(orgSlug));
        router.refresh();
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the provider.");
    } finally { setBusy(null); }
  }

  return (
    <div className={embedded ? "pb-28" : "mx-auto max-w-[860px] px-6 py-6 pb-28"}>
      <nav className="text-[12px] text-gray-500" aria-label="Breadcrumb">
        <Link href={getAiGatewayProvidersRoute(orgSlug)} className="hover:text-gray-900">AI Providers</Link>
        <span className="mx-1.5 text-gray-300">/</span><span className="text-gray-900">{provider.name}</span>
      </nav>
      <div className="mt-3 flex items-center gap-3">
        <Mark />
        <Heading className="min-w-0 flex-1 truncate text-[20px] font-medium tracking-[-0.02em] text-gray-900" data-testid="gateway-provider-title">{provider.name}</Heading>
        <DenButton icon={RefreshCw} loading={busy === "sync"} disabled={busy !== null && busy !== "sync"} onClick={() => void sync()} data-testid="litellm-sync">Sync models</DenButton>
      </div>
      {error ? <DenNotice tone="error" message={error} className="mt-4" /> : null}
      {!error && status?.lastSyncError ? <DenNotice tone="error" message={`Last sync failed: ${status.lastSyncError} Fix the key or URL, then sync again.`} className="mt-4" /> : null}
      {notice ? <DenNotice tone="info" message={notice} className="mt-4" /> : null}

      {status ? (
        <section className={`${CARD} mt-5`} aria-labelledby="litellm-status-heading">
          <h2 id="litellm-status-heading" className="sr-only">Status</h2>
          <dl className="divide-y divide-gray-100" data-testid="litellm-status">
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Proxy</dt><dd className="min-w-0 flex-1 truncate font-mono text-[12px] text-gray-900">{status.baseUrl ?? "Not set"}</dd></div>
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Keys</dt><dd className="flex-1 text-gray-900">{liteLlmModeLabel(uiMode)}</dd></div>
            {uiMode === "issued" && status.issueStrategy ? (
              <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Each person gets</dt><dd className="flex-1">
                <DenSegmented<LiteLlmIssueStrategy> aria-label="How keys are created" value={status.issueStrategy} options={[
                  { value: "per_team", label: liteLlmIssueStrategyLabel("per_team"), disabled: busy !== null },
                  { value: "mirror", label: liteLlmIssueStrategyLabel("mirror"), disabled: busy !== null },
                ]} onChange={(issueStrategy) => void changeIssue({ issueStrategy })} />
              </dd></div>
            ) : null}
            {uiMode === "issued" && status.issueStrategy === "mirror" && status.mirrorFallback ? (
              <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">No key to copy</dt><dd className="flex-1">
                <DenSegmented<LiteLlmMirrorFallback> aria-label="No key to copy" value={status.mirrorFallback} options={[
                  { value: "per_team", label: liteLlmMirrorFallbackLabel("per_team"), disabled: busy !== null },
                  { value: "error", label: liteLlmMirrorFallbackLabel("error"), disabled: busy !== null },
                ]} onChange={(mirrorFallback) => void changeIssue({ mirrorFallback })} />
              </dd></div>
            ) : null}
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Spend tracking</dt><dd className="flex-1 text-gray-900" data-testid="litellm-spend-tracking">{liteLlmSpendLabel(status)}</dd></div>
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Models</dt><dd className="flex-1 text-gray-900">{status.modelCount}</dd></div>
            {status.mode === "member" ? <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">LiteLLM teams</dt><dd className="flex-1 text-gray-900">{status.teamCount}</dd></div> : null}
            {uiMode === "member" ? <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">People connected</dt><dd className="flex-1 text-gray-900">{status.connectedMemberCount}</dd></div> : null}
            {uiMode === "issued" ? <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">People with keys</dt><dd className="flex-1 text-gray-900" data-testid="litellm-issued-count">{status.issuedMemberCount}</dd></div> : null}
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Last sync</dt><dd className="flex-1 text-gray-900">{liteLlmSyncedLabel(status.lastSyncedAt)}</dd></div>
            <div className={ROW}>
              <dt className="w-40 shrink-0 text-gray-500">{liteLlmKeyLabel(status.mode)}</dt>
              <dd className="flex min-w-0 flex-1 items-center gap-2">
                {replacing ? (
                  <>
                    <span className="min-w-0 flex-1"><DenInput className="font-mono text-[12px]" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" autoComplete="new-password" aria-label={`New ${liteLlmKeyLabel(status.mode).toLowerCase()}`} data-testid="litellm-replace-key-input" /></span>
                    <DenButton size="sm" variant="ghost" disabled={busy === "key"} onClick={() => { setReplacing(false); setApiKey(""); }}>Keep saved key</DenButton>
                    <DenButton size="sm" loading={busy === "key"} onClick={() => void saveKey()} data-testid="litellm-save-key">Save key</DenButton>
                  </>
                ) : (
                  <>
                    <span className="flex flex-1 items-center gap-1.5 text-gray-900">{status.hasSyncKey ? <><Check className="h-4 w-4 text-emerald-600" aria-hidden="true" strokeWidth={1.5} />Saved</> : "Missing"}</span>
                    <DenButton size="sm" variant="secondary" disabled={busy !== null} onClick={() => setReplacing(true)} data-testid="litellm-replace-key">Replace key</DenButton>
                  </>
                )}
              </dd>
            </div>
          </dl>
        </section>
      ) : <DenNotice tone="error" className="mt-5" message="This LiteLLM provider has no sync state. Sync models to repair it." />}

      {uiMode === "issued" && status && status.attentionCount > 0 ? (
        <section className={`${CARD} mt-3`} aria-labelledby="litellm-attention-heading">
          <h2 id="litellm-attention-heading" className={CARD_TITLE}>No key yet</h2>
          <ul className="mt-1 divide-y divide-gray-100" data-testid="litellm-attention">
            {status.attention.map((entry) => (
              <li key={entry.memberId} className={ROW}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><User className="h-4 w-4" aria-hidden="true" strokeWidth={1.5} /></span>
                <span className="min-w-0 flex-1"><span className="block text-gray-900">{entry.name ?? "Person"}</span><span className="block text-[12px] text-gray-500">{entry.email ?? ""}</span></span>
                <span className="text-[12px] text-amber-700">{liteLlmAttentionLabel(entry.reason)}</span>
              </li>
            ))}
            {status.attentionCount > status.attention.length ? <li className={`${ROW} text-[12px] text-gray-500`}>{status.attentionCount - status.attention.length} more</li> : null}
          </ul>
        </section>
      ) : null}

      <AccessList title={liteLlmAccessTitle(uiMode)} value={access} busy={busy !== null}
        onEveryone={(checked) => void (checked ? addGrant({ type: "organization" }) : removeGrant({ type: "organization" }))}
        onAdd={(audience) => void addGrant(audience)} onRemove={(audience) => void removeGrant(audience)} />

      <section className={`${CARD} mt-3`} aria-labelledby="litellm-groups-heading">
        <h2 id="litellm-groups-heading" className={CARD_TITLE}>Model groups</h2>
        <ul className="mt-1 divide-y divide-gray-100" data-testid="litellm-groups">
          {modelGroups.map((group) => (
            <li key={group.id} className={ROW}>
              <span className="min-w-0 flex-1 truncate text-gray-900">{group.name}</span>
              <span className="text-[12px] text-gray-500">{group.modelIds.length} {group.modelIds.length === 1 ? "model" : "models"}</span>
            </li>
          ))}
          {!modelGroups.length ? <li className={`${ROW} text-gray-500`}>{uiMode === "member" ? "No LiteLLM teams yet. People get a group when they connect their key." : uiMode === "issued" ? "No LiteLLM teams yet. People get a group when OpenWork creates their key." : "No models yet. Sync models to load them."}</li> : null}
        </ul>
      </section>

      <DenStickyActionBar summary={<span>{status ? `${liteLlmModeLabel(uiMode)} · ${status.modelCount} models · ${liteLlmSyncedLabel(status.lastSyncedAt).toLowerCase()}` : provider.name}</span>}>
        <AlertDialog.Root open={confirmDelete && !reauthDialogOpen} onOpenChange={(open) => { if (busy === "remove") return; setConfirmDelete(open); }}>
          <AlertDialog.Trigger disabled={busy !== null} className={buttonVariants({ variant: "secondary" })} data-testid="gateway-provider-remove">Remove</AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
            <AlertDialog.Popup initialFocus={cancelDeleteRef} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none">
              <AlertDialog.Title className="text-[15px] font-medium text-gray-950">Remove {provider.name}?</AlertDialog.Title>
              <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-gray-600">People lose these models and their saved LiteLLM keys. Your LiteLLM proxy is not changed.</AlertDialog.Description>
              <div className="mt-5 flex justify-end gap-2">
                <AlertDialog.Close ref={cancelDeleteRef} disabled={busy === "remove"} className={buttonVariants({ variant: "secondary" })}>Cancel</AlertDialog.Close>
                <DenButton variant="destructive" loading={busy === "remove"} onClick={() => void remove()}>Remove provider</DenButton>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </DenStickyActionBar>
    </div>
  );
}
