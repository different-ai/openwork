"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Check, RefreshCw, User } from "lucide-react";
import { createAuditOperationContext } from "@openwork/types/den/audit";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenSecretInput } from "../../_components/ui/secret-input";
import { DenNotice } from "../../_components/ui/notice";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { DenSwitch } from "../../_components/ui/switch";
import { getAiGatewayProviderRoute, getAiGatewayProvidersRoute, getNewAiGatewayProviderRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { deleteGatewayResource, deleteInferenceProvider, saveGatewayResource, useOrgInferenceProviders } from "./inference-provider-data";
import { ProviderRemovalUsageLimits, useProviderRemovalUsageLimits } from "./provider-removal-usage-limits";
import type { DenInferenceProviderDetails } from "./inference-provider-request";
import { AccessList, addAudience, removeAudience, type AccessValue, type Audience } from "./litellm-provider-screen";
import { liteLlmSyncedLabel } from "./litellm-provider-data";
import {
  CREATE_MISSING_USERS_DESCRIPTION, CREATE_MISSING_USERS_LABEL, TRUEFOUNDRY_DOC_URL, createTrueFoundryProvider, syncTrueFoundryProvider, trueFoundryAccessGroupId,
  trueFoundryAttentionLabel, trueFoundryCreateError, trueFoundryStatusSummary, trueFoundrySyncSummary, updateTrueFoundryProvider,
} from "./truefoundry-provider-data";

const CARD = "rounded-[12px] border border-gray-100 bg-white p-4";
const CARD_TITLE = "text-[13px] font-medium text-gray-900";
const LABEL = "mt-3 block text-[12px] font-medium text-gray-700";
const ROW = "flex min-h-10 items-center gap-3 py-2 text-[13px]";
const ACCESS_TITLE = "Who gets a key";
const SPEND_LABEL = "Not tracked, TrueFoundry budgets each person";

function Mark() {
  return <DenBrandMark name="TrueFoundry" serviceUrl={TRUEFOUNDRY_DOC_URL} className="h-8 w-8 rounded-[8px]" imageClassName="h-4 w-4" />;
}

/** The "Create missing users in TrueFoundry" setting, shared by setup and the saved provider. */
function MissingUsersSetting({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="mt-3 flex items-start gap-3 border-t border-gray-100 pt-3">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-gray-900" id="truefoundry-create-missing-users-label">{CREATE_MISSING_USERS_LABEL}</span>
        <span className="mt-0.5 block text-[12px] leading-5 text-gray-500">{CREATE_MISSING_USERS_DESCRIPTION}</span>
      </span>
      <DenSwitch checked={checked} disabled={disabled} aria-label={CREATE_MISSING_USERS_LABEL} testId="truefoundry-create-missing-users" onChange={onChange} />
    </div>
  );
}

/** Setup for a new TrueFoundry provider: address, admin key, missing users, and who gets a key. */
export function TrueFoundrySetupScreen({ embedded = false }: { embedded?: boolean }) {
  const Heading = embedded ? "h2" : "h1";
  const router = useRouter();
  const { orgSlug, runReauthableAction } = useOrgDashboard();
  const [controlPlaneUrl, setControlPlaneUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [createMissingUsers, setCreateMissingUsers] = useState(false);
  const [access, setAccess] = useState<AccessValue>({ allMembers: true, memberIds: [], teamIds: [] });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    const input = { name: "TrueFoundry", controlPlaneUrl, apiKey, createMissingUsers, access };
    const invalid = trueFoundryCreateError(input);
    if (invalid) return setError(invalid);
    setError(null);
    setSaving(true);
    try {
      await runReauthableAction("create-truefoundry-provider", async () => {
        const { provider } = await createTrueFoundryProvider(input, createAuditOperationContext());
        router.push(getAiGatewayProviderRoute(orgSlug, provider.id));
        router.refresh();
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect TrueFoundry.");
    } finally { setSaving(false); }
  }

  return (
    <div className={embedded ? "pb-28" : "mx-auto max-w-[860px] px-6 py-6 pb-28"}>
      <nav className="text-[12px] text-gray-500" aria-label="Breadcrumb">
        <Link href={getAiGatewayProvidersRoute(orgSlug)} className="hover:text-gray-900">AI Providers</Link>
        <span className="mx-1.5 text-gray-300">/</span><Link href={getNewAiGatewayProviderRoute(orgSlug)} className="hover:text-gray-900">Add a provider</Link>
        <span className="mx-1.5 text-gray-300">/</span><span className="text-gray-900">TrueFoundry</span>
      </nav>
      <div className="mt-3 flex items-center gap-3">
        <Mark />
        <Heading className="text-[20px] font-medium tracking-[-0.02em] text-gray-900" data-testid="gateway-provider-title">Add TrueFoundry</Heading>
      </div>
      <p className="mt-2 text-[13px] leading-5 text-gray-600">OpenWork finds each person in TrueFoundry by their email and creates an API key for them, so TrueFoundry's teams, budgets and logs apply to each person. Nobody pastes a key.</p>
      {error ? <DenNotice tone="error" message={error} className="mt-4" /> : null}

      <section className={`${CARD} mt-5`} aria-labelledby="truefoundry-connection-heading">
        <h2 id="truefoundry-connection-heading" className={CARD_TITLE}>Connection</h2>
        <label className={LABEL}>TrueFoundry address
          <DenInput className="mt-1.5 font-mono text-[12px]" value={controlPlaneUrl} onChange={(event) => setControlPlaneUrl(event.target.value)} placeholder="https://acme.truefoundry.cloud" data-testid="truefoundry-control-plane-url" autoComplete="off" />
        </label>
        <label className={LABEL}>Admin key
          <DenSecretInput className="mt-1.5 font-mono text-[12px]" value={apiKey} onChange={setApiKey} placeholder="tfy_va_…" data-testid="truefoundry-api-key" autoComplete="new-password" />
        </label>
        <p className="mt-1.5 text-[12px] leading-5 text-gray-500">A virtual account token with the tenant admin role, from TrueFoundry › Access › Virtual Accounts. OpenWork checks it before saving and never shows it again.</p>
        <p className="mt-2 text-[12px] text-gray-500" data-testid="truefoundry-spend-tracking">Spend tracking: {SPEND_LABEL}</p>
        <MissingUsersSetting checked={createMissingUsers} disabled={saving} onChange={setCreateMissingUsers} />
      </section>

      <AccessList idPrefix="truefoundry" title={ACCESS_TITLE} value={access} busy={saving}
        onEveryone={(checked) => setAccess(checked ? { allMembers: true, memberIds: [], teamIds: [] } : { allMembers: false, memberIds: [], teamIds: [] })}
        onAdd={(audience) => setAccess((current) => addAudience({ ...current, allMembers: false }, audience))}
        onRemove={(audience) => setAccess((current) => removeAudience(current, audience))} />

      <DenStickyActionBar summary={<span>One admin key · {access.allMembers ? "everyone" : `${access.teamIds.length + access.memberIds.length} teams or people`}</span>}>
        <Link href={getAiGatewayProvidersRoute(orgSlug)} className={buttonVariants({ variant: "secondary" })}>Cancel</Link>
        <DenButton data-testid="truefoundry-connect" loading={saving} onClick={() => void connect()}>Connect TrueFoundry</DenButton>
      </DenStickyActionBar>
    </div>
  );
}

/** A saved TrueFoundry provider: sync state, admin key, missing users, people needing attention and access. */
export function TrueFoundryProviderScreen({ provider, reload, embedded = false }: { provider: DenInferenceProviderDetails; reload: () => Promise<void>; embedded?: boolean }) {
  const Heading = embedded ? "h2" : "h1";
  const router = useRouter();
  const { orgId, orgSlug, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const status = provider.truefoundry;
  const [busy, setBusy] = useState<"sync" | "key" | "access" | "missing" | "remove" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const { inferenceProviders } = useOrgInferenceProviders(orgId);
  const removalLimits = useProviderRemovalUsageLimits({ orgId, providerId: provider.id, open: confirmDelete, providers: inferenceProviders });
  const accessGroupId = trueFoundryAccessGroupId(provider);
  const set = provider.credentialSets[0] ?? null;
  const grants = provider.accessGrants.filter((grant) => grant.modelGroupId === accessGroupId && grant.credentialSetId === set?.id);
  const access: AccessValue = {
    allMembers: grants.some((grant) => grant.audience.type === "organization"),
    teamIds: grants.flatMap((grant) => grant.audience.type === "team" ? [grant.audience.teamId] : []),
    memberIds: grants.flatMap((grant) => grant.audience.type === "member" ? [grant.audience.memberId] : []),
  };
  const modelGroups = provider.modelGroups.filter((group) => group.id !== accessGroupId);

  async function run(kind: "sync" | "key" | "access" | "missing", label: string, action: () => Promise<string | null>) {
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

  const sync = () => run("sync", "sync-truefoundry-provider", async () => trueFoundrySyncSummary((await syncTrueFoundryProvider(provider.id, createAuditOperationContext())).sync));
  const saveKey = () => {
    if (!apiKey.trim()) return setError("Paste the new admin key.");
    if (apiKey.trim().startsWith("tfy_pat_")) return setError("This is a personal access token. Paste a virtual account token with the tenant admin role instead.");
    return run("key", "replace-truefoundry-key", async () => {
      const result = await updateTrueFoundryProvider(provider.id, { apiKey }, createAuditOperationContext());
      setApiKey("");
      setReplacing(false);
      return `Key replaced. ${trueFoundrySyncSummary(result.sync)}`;
    });
  };
  const setMissingUsers = (createMissingUsers: boolean) => run("missing", "update-truefoundry-missing-users", async () =>
    `${createMissingUsers ? "OpenWork now adds missing people to TrueFoundry." : "OpenWork no longer adds missing people to TrueFoundry."} ${trueFoundrySyncSummary((await updateTrueFoundryProvider(provider.id, { createMissingUsers }, createAuditOperationContext())).sync)}`);
  const addGrant = (audience: Audience) => run("access", "add-truefoundry-access", async () => {
    if (!accessGroupId || !set) throw new Error("Sync TrueFoundry before granting access.");
    const context = createAuditOperationContext();
    await saveGatewayResource(provider.id, null, { resource: "access-grants", body: { audience, modelGroupId: accessGroupId, credentialSetId: set.id } }, context);
    if (audience.type === "organization") for (const grant of grants) if (grant.audience.type !== "organization") await deleteGatewayResource(provider.id, "access-grants", grant.id, context);
    // Create the new people's keys now rather than at the next sync.
    return `Access saved. ${trueFoundrySyncSummary((await syncTrueFoundryProvider(provider.id, context)).sync)}`;
  });
  const removeGrant = (audience: Audience) => run("access", "remove-truefoundry-access", async () => {
    const grant = grants.find((entry) => JSON.stringify(entry.audience) === JSON.stringify(audience));
    const context = createAuditOperationContext();
    if (grant) await deleteGatewayResource(provider.id, "access-grants", grant.id, context);
    // They stop being served at once; the sync deletes their keys in TrueFoundry.
    return `Access removed. ${trueFoundrySyncSummary((await syncTrueFoundryProvider(provider.id, context)).sync)}`;
  });

  async function remove() {
    setBusy("remove");
    setError(null);
    try {
      await runReauthableAction("delete-inference-provider", async () => {
        await deleteInferenceProvider(provider.id, createAuditOperationContext(), removalLimits.requestChoice());
        setConfirmDelete(false);
        router.push(getAiGatewayProvidersRoute(orgSlug));
        router.refresh();
      });
    } catch (cause) {
      if (removalLimits.handleRemoveError(cause)) return;
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
        <DenButton icon={RefreshCw} loading={busy === "sync"} disabled={busy !== null && busy !== "sync"} onClick={() => void sync()} data-testid="truefoundry-sync">Sync</DenButton>
      </div>
      {error ? <DenNotice tone="error" message={error} className="mt-4" /> : null}
      {!error && status?.lastSyncError ? <DenNotice tone="error" message={`Last sync failed: ${status.lastSyncError} Fix the key or address, then sync again.`} className="mt-4" /> : null}
      {notice ? <DenNotice tone="info" message={notice} className="mt-4" /> : null}

      {status ? (
        <section className={`${CARD} mt-5`} aria-labelledby="truefoundry-status-heading">
          <h2 id="truefoundry-status-heading" className="sr-only">Status</h2>
          <dl className="divide-y divide-gray-100" data-testid="truefoundry-status">
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">TrueFoundry</dt><dd className="min-w-0 flex-1 truncate font-mono text-[12px] text-gray-900">{status.controlPlaneUrl ?? "Not set"}</dd></div>
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Gateway</dt><dd className="min-w-0 flex-1 truncate font-mono text-[12px] text-gray-900">{status.gatewayBaseUrl ?? "Not set"}</dd></div>
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Keys</dt><dd className="flex-1 text-gray-900">OpenWork creates an API key for each person</dd></div>
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Spend tracking</dt><dd className="flex-1 text-gray-900" data-testid="truefoundry-spend-tracking">{SPEND_LABEL}</dd></div>
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Models</dt><dd className="flex-1 text-gray-900">{status.modelCount}</dd></div>
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">People with keys</dt><dd className="flex-1 text-gray-900" data-testid="truefoundry-active-count">{status.activeMemberCount}</dd></div>
            {status.createdUserCount ? <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Added to TrueFoundry</dt><dd className="flex-1 text-gray-900">{status.createdUserCount}</dd></div> : null}
            <div className={ROW}><dt className="w-40 shrink-0 text-gray-500">Last sync</dt><dd className="flex-1 text-gray-900">{liteLlmSyncedLabel(status.lastSyncedAt)}</dd></div>
            <div className={ROW}>
              <dt className="w-40 shrink-0 text-gray-500">Admin key</dt>
              <dd className="flex min-w-0 flex-1 items-center gap-2">
                {replacing ? (
                  <>
                    <span className="min-w-0 flex-1"><DenSecretInput className="font-mono text-[12px]" value={apiKey} onChange={setApiKey} placeholder="tfy_va_…" autoComplete="new-password" aria-label="New admin key" data-testid="truefoundry-replace-key-input" /></span>
                    <DenButton size="sm" variant="ghost" disabled={busy === "key"} onClick={() => { setReplacing(false); setApiKey(""); }}>Keep saved key</DenButton>
                    <DenButton size="sm" loading={busy === "key"} onClick={() => void saveKey()} data-testid="truefoundry-save-key">Save key</DenButton>
                  </>
                ) : (
                  <>
                    <span className="flex flex-1 items-center gap-1.5 text-gray-900">{status.hasAdminKey ? <><Check className="h-4 w-4 text-emerald-600" aria-hidden="true" strokeWidth={1.5} />Saved</> : "Missing"}</span>
                    <DenButton size="sm" variant="secondary" disabled={busy !== null} onClick={() => setReplacing(true)} data-testid="truefoundry-replace-key">Replace key</DenButton>
                  </>
                )}
              </dd>
            </div>
          </dl>
          <MissingUsersSetting checked={status.createMissingUsers} disabled={busy !== null} onChange={(checked) => void setMissingUsers(checked)} />
        </section>
      ) : <DenNotice tone="error" className="mt-5" message="This TrueFoundry provider has no sync state. Sync to repair it." />}

      {status && status.attentionCount > 0 ? (
        <section className={`${CARD} mt-3`} aria-labelledby="truefoundry-attention-heading">
          <h2 id="truefoundry-attention-heading" className={CARD_TITLE}>Needs attention</h2>
          <ul className="mt-1 divide-y divide-gray-100" data-testid="truefoundry-attention">
            {status.attention.map((entry) => (
              <li key={entry.memberId} className={ROW}>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><User className="h-4 w-4" aria-hidden="true" strokeWidth={1.5} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block text-gray-900">{entry.name ?? "Person"}</span>
                  <span className="block truncate text-[12px] text-gray-500" title={entry.message ?? undefined}>{entry.email ?? ""}</span>
                </span>
                <span className="text-[12px] text-amber-700" title={entry.message ?? undefined}>{trueFoundryAttentionLabel(entry.reason)}</span>
              </li>
            ))}
            {status.attention.length === 0
              ? <li className={`${ROW} text-[12px] text-gray-500`} data-testid="truefoundry-attention-hidden">{`${status.attentionCount} ${status.attentionCount === 1 ? "person" : "people"}. Names are hidden because you can't manage this provider.`}</li>
              : status.attentionCount > status.attention.length ? <li className={`${ROW} text-[12px] text-gray-500`}>{status.attentionCount - status.attention.length} more</li> : null}
          </ul>
        </section>
      ) : null}

      <AccessList idPrefix="truefoundry" title={ACCESS_TITLE} value={access} busy={busy !== null}
        onEveryone={(checked) => void (checked ? addGrant({ type: "organization" }) : removeGrant({ type: "organization" }))}
        onAdd={(audience) => void addGrant(audience)} onRemove={(audience) => void removeGrant(audience)} />

      <section className={`${CARD} mt-3`} aria-labelledby="truefoundry-groups-heading">
        <h2 id="truefoundry-groups-heading" className={CARD_TITLE}>Model groups</h2>
        <ul className="mt-1 divide-y divide-gray-100" data-testid="truefoundry-groups">
          {modelGroups.map((group) => (
            <li key={group.id} className={ROW}>
              <span className="min-w-0 flex-1 truncate text-gray-900">{group.name}</span>
              <span className="text-[12px] text-gray-500">{group.modelIds.length} {group.modelIds.length === 1 ? "model" : "models"}</span>
            </li>
          ))}
          {!modelGroups.length ? <li className={`${ROW} text-gray-500`}>No groups yet. People get the group matching their TrueFoundry access when OpenWork creates their key.</li> : null}
        </ul>
      </section>

      <DenStickyActionBar sticky={false} summary={<span>{status ? `${trueFoundryStatusSummary(status)} · ${liteLlmSyncedLabel(status.lastSyncedAt).toLowerCase()}` : provider.name}</span>}>
        <AlertDialog.Root open={confirmDelete && !reauthDialogOpen} onOpenChange={(open) => { if (busy === "remove") return; setConfirmDelete(open); if (!open) removalLimits.reset(); }}>
          <AlertDialog.Trigger disabled={busy !== null} className={buttonVariants({ variant: "secondary" })} data-testid="gateway-provider-remove">Remove</AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
            <AlertDialog.Popup initialFocus={cancelDeleteRef} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none">
              <AlertDialog.Title className="text-[15px] font-medium text-gray-950">Remove {provider.name}?</AlertDialog.Title>
              <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-gray-600">People lose these models, and the API keys OpenWork created in TrueFoundry are deleted. TrueFoundry users OpenWork added stay in TrueFoundry.</AlertDialog.Description>
              <ProviderRemovalUsageLimits providerName={provider.name} usageLimits={removalLimits.usageLimits} targets={removalLimits.targets} choice={removalLimits.choice} onChange={removalLimits.setChoice} disabled={busy === "remove"} />
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
