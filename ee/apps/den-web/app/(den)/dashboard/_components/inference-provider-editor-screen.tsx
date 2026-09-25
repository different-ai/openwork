"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Check, Globe, LockKeyhole, Plus, Search, User, Users } from "lucide-react";
import type { GatewayAccessGrantWrite, GatewayCredentialSetWrite } from "@openwork/types/den/gateway";
import { createAuditOperationContext, type AuditOperationContext } from "@openwork/types/den/audit";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { DenSwitch } from "../../_components/ui/switch";
import { DenTextarea } from "../../_components/ui/textarea";
import { getAiGatewayProvidersRoute, getNewAiGatewayProviderRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { deleteGatewayResource, deleteInferenceProvider, saveGatewayResource, saveInferenceProvider, useInferenceProvider } from "./inference-provider-data";
import {
  accessFromGrants, buildInferenceProviderRequestBody, getNewInferenceProviderSettings, getRequiredSettingKeys, getSettingLabel,
  isGoogleVertexNpm, isSupportedGatewayNpm, supportsMemberCredentialMode,
} from "./inference-provider-request";
import { formatProviderTimestamp, getProviderDocUrl, getProviderEnvNames, getProviderIconSlug, getProviderNpmPackage, requestLlmProviderCatalogDetail, type DenModelsDevProviderDetail } from "./llm-provider-data";
import { normalizeAzureResourceNameInput } from "./llm-provider-guided";
import type { ProviderAccessValue } from "./llm-provider-pickers";

const CARD = "rounded-[12px] border border-gray-100 bg-white p-4";
const CARD_TITLE = "text-[13px] font-medium text-gray-900";
const LABEL = "mt-3 block text-[12px] font-medium text-gray-700";
const MONO_INPUT = "font-mono text-[12px]";

function Radio({ testId, checked, label, onSelect }: { testId: string; checked: boolean; label: string; onSelect: () => void }) {
  return (
    <label className={`flex flex-1 cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-[13px] ${checked ? "border-gray-200 bg-gray-50 text-gray-900" : "border-gray-200 bg-white text-gray-600"}`}>
      <input type="radio" name="gateway-models-scope" data-testid={testId} checked={checked} onChange={onSelect} className="h-4 w-4 accent-gray-900" />
      {label}
    </label>
  );
}

export function InferenceProviderEditorScreen({ inferenceProviderId, catalogProviderId, embedded = false }: { inferenceProviderId?: string; catalogProviderId?: string; embedded?: boolean }) {
  const Heading = embedded ? "h2" : "h1";
  const router = useRouter();
  const { orgId, orgSlug, orgContext, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const { provider, busy, error, reload } = useInferenceProvider(orgId, inferenceProviderId ?? null);
  const [detail, setDetail] = useState<DenModelsDevProviderDetail | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState(catalogProviderId ?? "");
  const [name, setName] = useState("");
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [allowAllModels, setAllowAllModels] = useState(true);
  const [modelQuery, setModelQuery] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [credentialMode, setCredentialMode] = useState<"org" | "member">("org");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyValues, setApiKeyValues] = useState<Record<string, string>>({});
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [rotationAcknowledged, setRotationAcknowledged] = useState(false);
  const [callbackCopied, setCallbackCopied] = useState(false);
  const [replacingKey, setReplacingKey] = useState(false);
  const [access, setAccess] = useState<ProviderAccessValue>({ allMembers: true, memberIds: [], teamIds: [] });
  const [adding, setAdding] = useState<"person" | "team" | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const initializedProviderId = useRef<string | null>(null);
  const initializedNewProviderId = useRef<string | null>(null);

  useEffect(() => { if (catalogProviderId) setProviderId(catalogProviderId); }, [catalogProviderId]);

  useEffect(() => {
    if (!provider || initializedProviderId.current === provider.id) return;
    initializedProviderId.current = provider.id;
    setProviderId(provider.providerId);
    setName(provider.name);
    setModelIds(provider.modelIds ?? provider.catalogModels.map((model) => model.id));
    setAllowAllModels(provider.modelIds !== null && provider.modelIds.length === 0);
    setSettings(provider.settings);
    setCredentialMode(provider.credentialSets[0]?.credentialMode ?? provider.credentialMode);
    setOauthClientId(provider.credentialSets[0]?.oauthClientId ?? provider.oauthClientId ?? "");
    setOauthClientSecret("");
    setApiKey("");
    setApiKeyValues({});
    setServiceAccountJson("");
    setReplacingKey(false);
    setRotationAcknowledged(false);
    setCallbackCopied(false);
    setAccess(accessFromGrants(provider.accessGrants));
  }, [provider]);

  useEffect(() => {
    setDetail(null);
    if (!orgId || !providerId) return;
    let cancelled = false;
    setCatalogError(null);
    void requestLlmProviderCatalogDetail(orgId, providerId)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        if (!inferenceProviderId) {
          setName((current) => current || result.name);
          if (initializedNewProviderId.current !== providerId) {
            initializedNewProviderId.current = providerId;
            setSettings((current) => ({ ...getNewInferenceProviderSettings(getProviderNpmPackage(result.config)), ...current }));
          }
        }
      })
      .catch(() => { if (!cancelled) setCatalogError("Could not load this provider's models. Existing configuration has not changed."); });
    return () => { cancelled = true; };
  }, [orgId, providerId, inferenceProviderId]);

  const npm = detail ? getProviderNpmPackage(detail.config) : null;
  const vertex = isGoogleVertexNpm(npm);
  const envNames = detail ? getProviderEnvNames(detail.config) : [];
  const memberSignInSupported = supportsMemberCredentialMode(providerId);
  const configuredSet = provider?.credentialSets[0] ?? null;
  const invalidatesCredentials = Boolean(configuredSet && (
    configuredSet.credentialMode !== credentialMode ||
    (credentialMode === "member" && (oauthClientId.trim() !== (configuredSet.oauthClientId ?? "") || oauthClientSecret.trim()))
  ));
  const keySaved = Boolean(configuredSet?.configured && configuredSet.credentialMode === credentialMode) && !replacingKey;
  const displayName = detail?.name ?? provider?.name ?? "provider";
  const formInput = {
    name, providerId, modelIds: allowAllModels ? [] : modelIds, credentialMode, status: "active" as const,
    settings, envNames, apiKey, apiKeyValues, serviceAccountJson, oauthClientId, oauthClientSecret, access,
  };
  const models = detail?.models ?? [];
  const filteredModels = useMemo(() => {
    const normalized = modelQuery.trim().toLowerCase();
    return normalized ? models.filter((model) => model.name.toLowerCase().includes(normalized) || model.id.toLowerCase().includes(normalized)) : models;
  }, [models, modelQuery]);
  const grantMeta = (audience: { type: "team"; teamId: string } | { type: "member"; memberId: string }) => {
    const grant = provider?.accessGrants.find((entry) => JSON.stringify(entry.audience) === JSON.stringify(audience));
    return grant ? "assigned" : "will be assigned when you save";
  };

  function changeCredentialMode(mode: "org" | "member") {
    setCredentialMode(mode);
    setOauthClientSecret("");
    setApiKey("");
    setApiKeyValues({});
    setServiceAccountJson("");
    setRotationAcknowledged(false);
  }

  /** Edits go through the matrix routes: first group, first set, and one grant per audience. */
  async function syncAccessAndCredential(auditContext: AuditOperationContext) {
    if (!provider) return;
    const [group] = provider.modelGroups;
    const [set] = provider.credentialSets;
    if (!group || !set) return;
    const groupModels = allowAllModels ? (detail?.models ?? []).map((model) => model.id) : modelIds;
    if (groupModels.length) {
      await saveGatewayResource(provider.id, group.id, { resource: "model-groups", body: { name: group.name, description: group.description, modelIds: groupModels, status: "active" } }, auditContext);
    }
    const { credential, apiKeys, oauthClientId: clientId, oauthClientSecret: clientSecret } = buildInferenceProviderRequestBody(formInput);
    if (credential || apiKeys || credentialMode === "member" || set.credentialMode !== credentialMode) {
      const body: GatewayCredentialSetWrite = { name: set.name, credentialMode, status: "active", credential, apiKeys };
      if (clientId !== undefined) body.oauthClientId = clientId;
      if (clientSecret !== undefined) body.oauthClientSecret = clientSecret;
      await saveGatewayResource(provider.id, set.id, { resource: "credential-sets", body }, auditContext);
    }
    const desired: GatewayAccessGrantWrite["audience"][] = [
      ...(access.allMembers ? [{ type: "organization" as const }] : []),
      ...[...new Set(access.teamIds)].map((teamId) => ({ type: "team" as const, teamId })),
      ...[...new Set(access.memberIds)].map((memberId) => ({ type: "member" as const, memberId })),
    ];
    const same = (a: GatewayAccessGrantWrite["audience"], b: GatewayAccessGrantWrite["audience"]) => JSON.stringify(a) === JSON.stringify(b);
    const existing = provider.accessGrants.filter((grant) => grant.modelGroupId === group.id && grant.credentialSetId === set.id);
    for (const grant of existing) if (!desired.some((audience) => same(audience, grant.audience))) await deleteGatewayResource(provider.id, "access-grants", grant.id, auditContext);
    for (const audience of desired) {
      if (!existing.some((grant) => same(grant.audience, audience))) {
        await saveGatewayResource(provider.id, null, { resource: "access-grants", body: { audience, modelGroupId: group.id, credentialSetId: set.id } }, auditContext);
      }
    }
  }

  async function save() {
    setSaveError(null);
    if (invalidatesCredentials && !rotationAcknowledged) return setSaveError("Confirm that members will need to reconnect before saving this change.");
    if (!detail || detail.id !== providerId) return setSaveError("Wait for the provider catalog to load.");
    if (!isSupportedGatewayNpm(npm)) return setSaveError("This provider is not supported by AI Gateway.");
    if (!allowAllModels && !modelIds.length) return setSaveError("Pick at least one model, or choose all models.");
    for (const key of getRequiredSettingKeys(npm)) if (!settings[key]?.trim()) return setSaveError(`${getSettingLabel(key)} is required.`);
    const granting = access.allMembers || access.teamIds.length > 0 || access.memberIds.length > 0;
    if (!provider && granting && credentialMode === "org") {
      const hasKey = vertex ? Boolean(serviceAccountJson.trim()) : envNames.length > 1 ? Object.values(apiKeyValues).some((value) => value.trim()) : Boolean(apiKey.trim());
      if (!hasKey) return setSaveError("Paste a key before sharing these models.");
    }
    if (credentialMode === "member" && (!memberSignInSupported || !oauthClientId.trim() || (!oauthClientSecret.trim() && !configuredSet?.hasOauthClientSecret))) {
      return setSaveError("People sign in needs a Google OAuth client ID and secret.");
    }
    setSaving(true);
    const auditContext = createAuditOperationContext();
    try {
      await runReauthableAction("save-inference-provider", async () => {
        if (!provider) {
          await saveInferenceProvider({ inferenceProviderId: null, body: buildInferenceProviderRequestBody({ ...formInput, name: name.trim() || displayName }), auditContext });
        } else {
          await saveInferenceProvider({ inferenceProviderId: provider.id, body: { name: name.trim(), modelIds: allowAllModels ? [] : modelIds, status: "active" }, auditContext });
          await syncAccessAndCredential(auditContext);
          await reload();
        }
        router.push(getAiGatewayProvidersRoute(orgSlug));
        router.refresh();
      });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not save the provider.");
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!provider || saving) return;
    setSaving(true);
    setSaveError(null);
    const auditContext = createAuditOperationContext();
    try {
      await runReauthableAction("delete-inference-provider", async () => {
        await deleteInferenceProvider(provider.id, auditContext);
        setConfirmDelete(false);
        router.push(getAiGatewayProvidersRoute(orgSlug));
        router.refresh();
      });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not remove the provider.");
    } finally { setSaving(false); }
  }

  if (inferenceProviderId && !provider) {
    return <div className="p-8">{busy ? "Loading provider..." : <DenNotice tone="error" message={error ?? "Provider not found."} />}</div>;
  }

  const teams = orgContext?.teams ?? [];
  const members = orgContext?.members ?? [];
  const teamOptions = teams.filter((team) => !access.teamIds.includes(team.id)).map((team) => ({ value: team.id, label: team.name, description: `${team.memberIds.length} ${team.memberIds.length === 1 ? "member" : "members"}` }));
  const memberOptions = members.filter((member) => !access.memberIds.includes(member.id)).map((member) => ({ value: member.id, label: member.user.name, description: member.user.email }));

  return (
    <div className={embedded ? "pb-28" : "mx-auto max-w-[860px] px-6 py-6 pb-28"}>
      <nav className="text-[12px] text-gray-500" aria-label="Breadcrumb">
        <Link href={getAiGatewayProvidersRoute(orgSlug)} className="hover:text-gray-900">AI Providers</Link>
        {!provider ? <><span className="mx-1.5 text-gray-300">/</span><Link href={getNewAiGatewayProviderRoute(orgSlug)} className="hover:text-gray-900">Add a provider</Link></> : null}
        <span className="mx-1.5 text-gray-300">/</span><span className="text-gray-900">{displayName}</span>
      </nav>
      <div className="mt-3 flex items-center gap-3">
        <DenBrandMark name={displayName} simpleIconSlug={getProviderIconSlug(providerId)} serviceUrl={detail?.doc ?? (provider ? getProviderDocUrl(provider.providerConfig) : null)} className="h-8 w-8 rounded-[8px]" imageClassName="h-4 w-4" />
        <Heading className="text-[20px] font-medium tracking-[-0.02em] text-gray-900" data-testid="gateway-provider-title">{provider ? provider.name : `Add ${displayName}`}</Heading>
      </div>
      {saveError ? <DenNotice tone="error" message={saveError} className="mt-4" /> : null}
      {catalogError ? <DenNotice tone="error" message={catalogError} className="mt-4" /> : null}
      {provider?.catalogWarning ? <DenNotice tone="warning" message={provider.catalogWarning} className="mt-4" /> : null}

      <section className={`${CARD} mt-5`} aria-labelledby="gateway-key-heading">
        <h2 id="gateway-key-heading" className={CARD_TITLE}>Key</h2>
        <DenSegmented<"org" | "member"> className="mt-3" aria-label="Credential mode" value={credentialMode} options={[
          { value: "org", label: "Shared API key" },
          { value: "member", label: "Each member signs in", disabled: !memberSignInSupported },
        ]} onChange={changeCredentialMode} />
        {!memberSignInSupported ? <p className="mt-3 flex items-center gap-2 text-sm text-[var(--dls-text-secondary)]"><LockKeyhole aria-hidden="true" className="size-4" strokeWidth={1.5} />Google sign-in is unavailable for this provider.</p> : null}
        {getRequiredSettingKeys(npm).map((key) => (
          <label key={key} className={LABEL}>
            {getSettingLabel(key)}
            <DenInput className={`mt-1.5 ${MONO_INPUT}`} readOnly={Boolean(provider)} value={settings[key] ?? ""}
              onChange={(event) => setSettings((current) => ({ ...current, [key]: key === "resourceName" ? normalizeAzureResourceNameInput(event.target.value) : event.target.value }))} />
          </label>
        ))}
        {invalidatesCredentials ? <label className="mt-3 flex items-center gap-3"><DenSwitch checked={rotationAcknowledged} onChange={setRotationAcknowledged} aria-label="Confirm credential invalidation" /><span>Revoke this set’s credentials and pending sign-ins on save; members must reconnect.</span></label> : null}
        {credentialMode === "member" ? (
          <>
            {provider?.oauthCallbackUrl ? <div className="flex flex-wrap items-center gap-3 border-b border-[var(--dls-border)] py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1"><p className="text-sm font-medium">OAuth callback URL</p><code className="break-all text-xs text-[var(--dls-text-secondary)]">{provider.oauthCallbackUrl}</code></div>
              <DenButton size="sm" variant="secondary" onClick={() => {
                const callback = provider.oauthCallbackUrl;
                if (!callback) return;
                if (!navigator.clipboard) { setSaveError("Clipboard access is unavailable. Select and copy the displayed URL manually."); return; }
                void navigator.clipboard.writeText(callback).then(() => setCallbackCopied(true)).catch(() => setSaveError("Could not copy the callback. Select and copy the displayed URL manually."));
              }}>{callbackCopied ? "Callback copied" : "Copy callback URL"}</DenButton>
            </div> : <DenNotice className="mt-3" tone="neutral" message={provider ? "Callback unavailable. Ask your deployment administrator to configure the public Den API origin." : "Save this provider to obtain its exact OAuth callback URL, then register it in your Google Web OAuth client before members connect."} />}
            <label className={LABEL}>OAuth client ID<DenInput className={`mt-1.5 ${MONO_INPUT}`} data-testid="gateway-oauth-client-id" value={oauthClientId} autoComplete="off" onChange={(event) => { setOauthClientId(event.target.value); setRotationAcknowledged(false); }} /></label>
            <label className={LABEL}>OAuth client secret {configuredSet?.hasOauthClientSecret ? "(configured)" : ""}<DenInput className={`mt-1.5 ${MONO_INPUT}`} type="password" data-testid="gateway-oauth-client-secret" value={oauthClientSecret} autoComplete="new-password" onChange={(event) => { setOauthClientSecret(event.target.value); setRotationAcknowledged(false); }} placeholder={configuredSet?.hasOauthClientSecret ? "Saved — enter a replacement to change it" : undefined} /></label>
            <Link href="https://openworklabs.com/docs/ai-gateway/google-agent-platform" target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary", size: "sm", className: "mt-3 w-fit" })}>Read setup instructions</Link>
          </>
        ) : vertex ? (
          <label className={LABEL}>Service account JSON<DenTextarea className={`mt-1.5 ${MONO_INPUT}`} data-testid="gateway-service-account" value={serviceAccountJson} onChange={(event) => setServiceAccountJson(event.target.value)} placeholder={configuredSet?.configured ? "Saved — paste a replacement to change it" : "Paste the key file"} /></label>
        ) : envNames.length > 1 ? (
          envNames.map((envName) => (
            <label key={envName} className={LABEL}>{envName}<DenInput className={`mt-1.5 ${MONO_INPUT}`} type="password" value={apiKeyValues[envName] ?? ""} onChange={(event) => setApiKeyValues((current) => ({ ...current, [envName]: event.target.value }))} /></label>
          ))
        ) : (
          <label className={LABEL}>
            API key
            <span className="mt-1.5 flex items-center gap-2">
              <span className="min-w-0 flex-1">
                <DenInput className={MONO_INPUT} type={keySaved ? "text" : "password"} data-testid="gateway-provider-api-key" readOnly={keySaved}
                  value={keySaved ? "••••••••••••••••••••••••••••••••" : apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste the key" />
              </span>
              {configuredSet?.configured ? (
                <>
                  <DenButton size="sm" variant="secondary" type="button" data-testid="gateway-provider-replace-key" onClick={() => { setReplacingKey((current) => !current); setApiKey(""); }}>{replacingKey ? "Keep saved key" : "Replace key"}</DenButton>
                  <Check className="h-4 w-4 text-emerald-600" aria-label="Key saved" />
                </>
              ) : null}
            </span>
          </label>
        )}
      </section>

      <section className={`${CARD} mt-3`} aria-labelledby="gateway-access-heading">
        <h2 id="gateway-access-heading" className={CARD_TITLE}>Who can use it</h2>
        <div className="mt-3 flex items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><Globe className="h-4 w-4" aria-hidden="true" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium text-gray-900">Everyone in the organization</span>
            <span className="block text-[12px] text-gray-500">{access.allMembers ? "All organization members can use these models." : "Only people and teams you add below can use these models."}</span>
          </span>
          <DenSwitch checked={access.allMembers} aria-label="Everyone in the organization" data-testid="gateway-access-all-members"
            onChange={(checked) => setAccess((current) => ({ ...current, allMembers: checked, ...(checked ? { teamIds: [], memberIds: [] } : {}) }))} />
        </div>
        {!access.allMembers ? (
          <ul className="mt-3 divide-y divide-gray-100 border-t border-gray-100">
            {access.teamIds.map((teamId) => {
              const team = teams.find((entry) => entry.id === teamId);
              return (
                <li key={teamId} className="flex items-center gap-3 py-2.5" data-testid="gateway-access-row">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><Users className="h-4 w-4" aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-gray-900">{team?.name ?? "Team"}</span>
                    <span className="block text-[12px] text-gray-500">{team ? `${team.memberIds.length} members, future members included` : teamId}</span>
                  </span>
                  <span className="text-[11px] text-gray-400">{grantMeta({ type: "team", teamId })}</span>
                  <DenButton size="sm" variant="destructive" type="button" onClick={() => setAccess((current) => ({ ...current, teamIds: current.teamIds.filter((id) => id !== teamId) }))}>Revoke</DenButton>
                </li>
              );
            })}
            {access.memberIds.map((memberId) => {
              const member = members.find((entry) => entry.id === memberId);
              return (
                <li key={memberId} className="flex items-center gap-3 py-2.5" data-testid="gateway-access-row">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500"><User className="h-4 w-4" aria-hidden="true" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium text-gray-900">{member?.user.name ?? "Person"}</span>
                    <span className="block text-[12px] text-gray-500">{member?.user.email ?? memberId}</span>
                  </span>
                  <span className="text-[11px] text-gray-400">{grantMeta({ type: "member", memberId })}</span>
                  <DenButton size="sm" variant="destructive" type="button" onClick={() => setAccess((current) => ({ ...current, memberIds: current.memberIds.filter((id) => id !== memberId) }))}>Revoke</DenButton>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" data-testid="gateway-access-add-person" onClick={() => setAdding(adding === "person" ? null : "person")} className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"><Plus className="h-3 w-3" aria-hidden="true" />Add person</button>
          <button type="button" data-testid="gateway-access-add-team" onClick={() => setAdding(adding === "team" ? null : "team")} className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-2.5 py-1 text-[11px] font-medium text-gray-600 hover:bg-gray-50"><Plus className="h-3 w-3" aria-hidden="true" />Add team</button>
          {adding ? (
            <div className="w-[280px]">
              <DenCombobox ariaLabel={adding === "team" ? "Team" : "Person"} value="" options={adding === "team" ? teamOptions : memberOptions}
                placeholder={adding === "team" ? "Choose a team…" : "Choose a person…"} searchPlaceholder={adding === "team" ? "Search teams" : "Search people"} emptyLabel={adding === "team" ? "No teams to add" : "No people to add"}
                onChange={(id) => {
                  setAccess((current) => ({ ...current, allMembers: false, ...(adding === "team" ? { teamIds: [...current.teamIds, id] } : { memberIds: [...current.memberIds, id] }) }));
                  setAdding(null);
                }} />
            </div>
          ) : null}
        </div>
      </section>

      <section className={`${CARD} mt-3`} aria-labelledby="gateway-models-heading">
        <h2 id="gateway-models-heading" className={CARD_TITLE}>Models</h2>
        <div className="mt-3 flex gap-2">
          <Radio testId="gateway-models-all" checked={allowAllModels} label={`All ${displayName} models`} onSelect={() => setAllowAllModels(true)} />
          <Radio testId="gateway-models-pick" checked={!allowAllModels} label="Only the ones I pick" onSelect={() => { setAllowAllModels(false); if (!provider) setModelIds([]); }} />
        </div>
        {!allowAllModels ? (
          <div className="mt-3 rounded-[10px] bg-gray-50 p-2">
            <div className="flex items-center gap-3">
              <div className="w-[200px]"><DenInput type="search" icon={Search} value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="Filter models" className="h-8 bg-white text-[12px]" /></div>
              <span className="text-[12px] text-gray-500" data-testid="gateway-models-count">{modelIds.length} of {models.length} selected</span>
              <span className="ml-auto flex items-center gap-3 text-[12px]">
                <button type="button" data-testid="gateway-models-select-all" className="font-medium text-gray-700 hover:text-gray-900" onClick={() => setModelIds(models.map((model) => model.id))}>Select all</button>
                <button type="button" data-testid="gateway-models-clear" className="font-medium text-gray-700 hover:text-gray-900" onClick={() => setModelIds([])}>Clear</button>
              </span>
            </div>
            <ul className="mt-2 max-h-[320px] overflow-y-auto">
              {filteredModels.map((model) => {
                const checked = modelIds.includes(model.id);
                return (
                  <li key={model.id}>
                    <label className="flex items-center gap-3 rounded-[8px] px-2 py-1.5 hover:bg-white">
                      <input type="checkbox" checked={checked} onChange={() => setModelIds((current) => checked ? current.filter((id) => id !== model.id) : [...current, model.id])} className="h-4 w-4 accent-emerald-600" data-testid={`gateway-model-${model.id}`} />
                      <DenBrandMark name={displayName} simpleIconSlug={getProviderIconSlug(providerId)} serviceUrl={detail?.doc ?? null} className="h-5 w-5 rounded-[5px]" imageClassName="h-3 w-3" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-gray-900">{model.name}</span>
                      <span className="text-[11px] text-gray-400">{displayName}</span>
                    </label>
                  </li>
                );
              })}
              {!models.length ? <li className="px-2 py-3 text-[12px] text-gray-500">Loading models…</li> : null}
            </ul>
          </div>
        ) : null}
      </section>

      <DenStickyActionBar summary={<span>{allowAllModels ? `All ${displayName} models` : `${modelIds.length} models`} · {access.allMembers ? "everyone" : `${access.teamIds.length + access.memberIds.length} teams or people`}{provider?.updatedAt ? ` · saved ${formatProviderTimestamp(provider.updatedAt)}` : ""}</span>}>
        {provider ? (
          <AlertDialog.Root open={confirmDelete && !reauthDialogOpen} onOpenChange={(open) => { if (saving) return; setConfirmDelete(open); if (open) setSaveError(null); }}>
            <AlertDialog.Trigger disabled={saving} className={buttonVariants({ variant: "secondary" })} data-testid="gateway-provider-remove">Remove</AlertDialog.Trigger>
            <AlertDialog.Portal>
              <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
              <AlertDialog.Popup initialFocus={cancelDeleteRef} aria-busy={saving} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none">
                <AlertDialog.Title className="text-[15px] font-medium text-gray-950">Remove {provider.name}?</AlertDialog.Title>
                <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-gray-600">People lose these models the next time they open OpenWork. This cannot be undone.</AlertDialog.Description>
                {saveError ? <DenNotice className="mt-4" tone="error" message={saveError} /> : null}
                <div className="mt-5 flex justify-end gap-2">
                  <AlertDialog.Close ref={cancelDeleteRef} disabled={saving} className={buttonVariants({ variant: "secondary" })}>Cancel</AlertDialog.Close>
                  <DenButton variant="destructive" loading={saving} onClick={() => void remove()}>Remove provider</DenButton>
                </div>
              </AlertDialog.Popup>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        ) : (
          <Link href={getAiGatewayProvidersRoute(orgSlug)} className={buttonVariants({ variant: "secondary" })}>Cancel</Link>
        )}
        <DenButton data-testid="gateway-provider-save" loading={saving} onClick={() => void save()}>{provider ? "Save changes" : `Add ${displayName}`}</DenButton>
      </DenStickyActionBar>
    </div>
  );
}
