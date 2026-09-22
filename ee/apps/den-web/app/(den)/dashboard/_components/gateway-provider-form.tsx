"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Check } from "lucide-react";
import type { GatewayCredentialSetPatch } from "@openwork/types/den/gateway";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { DenTextarea } from "../../_components/ui/textarea";
import { getGatewayProviderRoute, getGatewayProvidersRoute, getNewGatewayProviderRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  deleteGatewayResource,
  deleteInferenceProvider,
  patchGatewayResource,
  requestGatewayCatalogModelIds,
  saveGatewayResource,
  saveInferenceProvider,
  useInferenceProvider,
  useOrgInferenceProviders,
} from "./inference-provider-data";
import { GatewayAccessMatrix } from "./inference-provider-matrix";
import {
  getRequiredSettingKeys,
  getSettingLabel,
  isSupportedGatewayNpm,
  supportsMemberCredentialMode,
  type DenInferenceProviderDetails,
  type InferenceProviderRequestBody,
} from "./inference-provider-request";
import {
  EVERYONE,
  getKeyShape,
  getTestKeyApiBase,
  isSimpleProvider,
  needsInstanceName,
  planGrantChanges,
  resolvePrimaryPair,
  sameWho,
  whoFromGrants,
  type GatewayWhoValue,
} from "./gateway-provider-model";
import { GatewayModelsPanel, GatewayPanel, GatewayWhoCanUseIt, type GatewayModelsValue } from "./gateway-provider-sections";
import {
  getProviderApiBase,
  getProviderDocUrl,
  getProviderEnvNames,
  getProviderIconSlug,
  getProviderNpmPackage,
  requestLlmProviderCatalogDetail,
  requestLlmProviderTestConnection,
  type DenModelsDevProviderDetail,
} from "./llm-provider-data";
import { normalizeAzureResourceNameInput } from "./llm-provider-guided";

type KeyTest = { state: "idle" } | { state: "testing" } | { state: "ok" } | { state: "failed"; message: string };
type SignIn = "org" | "member";

/** Masked stand-in for a saved key; secrets never come back from the API. */
const SAVED_KEY_MASK = "••••••••••••••••••••••••••••••••";

function Breadcrumb({ items }: { items: Array<{ label: string; href?: string }> }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-5 flex flex-wrap items-center gap-2 text-[13px] text-gray-500">
      {items.map((item, index) => (
        <span key={item.label} className="flex items-center gap-2">
          {index > 0 ? <span aria-hidden className="text-gray-300">/</span> : null}
          {item.href ? <Link href={item.href} className="hover:text-gray-900">{item.label}</Link> : <span className="text-gray-900">{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}

/**
 * Adding a provider and editing a saved one: one column,
 * Key → Who can use it → Models. The same form serves add and edit; there is
 * no separate edit mode.
 */
export function GatewayProviderForm(props: { catalogProviderId: string } | { inferenceProviderId: string }) {
  const router = useRouter();
  const { orgId, orgSlug, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const inferenceProviderId = "inferenceProviderId" in props ? props.inferenceProviderId : null;
  const { provider, busy: providerBusy, error: providerError, reload } = useInferenceProvider(orgId, inferenceProviderId);
  const { inferenceProviders } = useOrgInferenceProviders(orgId);
  const catalogProviderId = "catalogProviderId" in props ? props.catalogProviderId : provider?.providerId ?? null;

  const [detail, setDetail] = useState<DenModelsDevProviderDetail | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [signIn, setSignIn] = useState<SignIn>("org");
  const [replacingKey, setReplacingKey] = useState(false);
  const [secret, setSecret] = useState("");
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [keyTest, setKeyTest] = useState<KeyTest>({ state: "idle" });
  const [who, setWho] = useState<GatewayWhoValue>(EVERYONE);
  const [models, setModels] = useState<GatewayModelsValue>({ allModels: true, modelIds: [] });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const cancelRemoveRef = useRef<HTMLButtonElement | null>(null);
  const initializedFor = useRef<string | null>(null);

  // Catalog detail: models to pick from and how this provider takes a key.
  useEffect(() => {
    if (!orgId || !catalogProviderId) return;
    let cancelled = false;
    setDetail(null);
    setCatalogError(null);
    void requestLlmProviderCatalogDetail(orgId, catalogProviderId)
      .then((result) => { if (!cancelled) setDetail(result); })
      .catch(() => { if (!cancelled) setCatalogError("Couldn’t load this provider’s models. Reload the page to try again."); });
    return () => { cancelled = true; };
  }, [orgId, catalogProviderId]);

  const pair = provider ? resolvePrimaryPair(provider) : null;
  const primarySet = provider && pair ? provider.credentialSets.find((set) => set.id === pair.credentialSetId) ?? null : null;
  const pairGrants = useMemo(
    () => (provider && pair ? provider.accessGrants.filter((grant) => grant.credentialSetId === pair.credentialSetId && grant.modelGroupId === pair.modelGroupId) : []),
    [provider, pair?.credentialSetId, pair?.modelGroupId],
  );
  const savedWho = useMemo(() => whoFromGrants(pairGrants), [pairGrants]);
  const savedModels: GatewayModelsValue = provider
    ? { allModels: (provider.modelIds ?? []).length === 0, modelIds: provider.modelIds?.length ? provider.modelIds : [] }
    : { allModels: true, modelIds: [] };

  // Fill the form once from the saved provider. Reloads never replace a draft.
  useEffect(() => {
    if (!provider || initializedFor.current === provider.id) return;
    initializedFor.current = provider.id;
    setName(provider.name);
    setSettings(provider.settings);
    setSignIn(primarySet?.credentialMode === "member" ? "member" : "org");
    setOauthClientId(primarySet?.oauthClientId ?? "");
    setWho(savedWho);
    setModels(savedModels);
  }, [provider, primarySet, savedWho, savedModels]);

  const npm = detail ? getProviderNpmPackage(detail.config) : null;
  const envNames = detail ? getProviderEnvNames(detail.config) : [];
  const keyShape = getKeyShape(npm, envNames);
  const testApiBase = detail ? getTestKeyApiBase(npm, getProviderApiBase(detail.config)) : null;
  const memberSignInSupported = catalogProviderId ? supportsMemberCredentialMode(catalogProviderId) : false;
  const providerName = detail?.name ?? provider?.name ?? "provider";
  const isEdit = Boolean(provider);
  const showName = catalogProviderId ? needsInstanceName(catalogProviderId, inferenceProviders, provider?.id ?? null) : false;
  const keyEditable = !isEdit || replacingKey || (signIn === "member" && primarySet?.credentialMode !== "member") || (signIn === "org" && primarySet?.credentialMode === "member");
  const simple = provider ? isSimpleProvider(provider) : true;

  const keyEntered = keyShape === "api_keys" ? Object.values(apiKeys).some((value) => value.trim()) : Boolean(secret.trim());
  const dirty = !isEdit || (
    (showName && name.trim() !== provider?.name) ||
    keyEntered ||
    (signIn === "member" && (oauthClientId.trim() !== (primarySet?.oauthClientId ?? "") || Boolean(oauthClientSecret.trim()))) ||
    (signIn === "member") !== (primarySet?.credentialMode === "member") ||
    !sameWho(who, savedWho) ||
    models.allModels !== savedModels.allModels ||
    (!models.allModels && (models.modelIds.length !== savedModels.modelIds.length || models.modelIds.some((id) => !savedModels.modelIds.includes(id))))
  );

  function clearKeyTest() {
    if (keyTest.state !== "idle") setKeyTest({ state: "idle" });
  }

  async function testKey() {
    if (!testApiBase || !secret.trim()) return;
    setKeyTest({ state: "testing" });
    try {
      const result = await requestLlmProviderTestConnection({ api: testApiBase, apiKey: secret.trim() });
      setKeyTest(result.ok ? { state: "ok" } : { state: "failed", message: result.hint ?? "That key didn’t work. Check it and try again." });
    } catch (cause) {
      setKeyTest({ state: "failed", message: cause instanceof Error ? cause.message : "Couldn’t test the key." });
    }
  }

  /** Credential fields for a create body or a set PATCH; empty when nothing was typed. */
  function credentialFields(): Pick<InferenceProviderRequestBody, "credential" | "apiKeys" | "oauthClientId" | "oauthClientSecret"> {
    if (signIn === "member") {
      return { oauthClientId: oauthClientId.trim(), ...(oauthClientSecret.trim() ? { oauthClientSecret: oauthClientSecret.trim() } : {}) };
    }
    if (keyShape === "api_keys") {
      const entries = Object.entries(apiKeys).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()] as const);
      return entries.length ? { apiKeys: Object.fromEntries(entries) } : {};
    }
    if (!secret.trim()) return {};
    return { credential: { kind: keyShape === "service_account" ? "gcp_service_account" : "api_key", secret: secret.trim() } };
  }

  function validate(): string | null {
    if (!detail) return "Wait for the provider’s models to load.";
    if (!isSupportedGatewayNpm(npm)) return `${detail.name} can’t be used through AI Gateway yet.`;
    if (showName && !name.trim()) return `Name this ${detail.name} so you can tell the two apart.`;
    if (showName && inferenceProviders.some((entry) => entry.id !== provider?.id && entry.name.trim().toLowerCase() === name.trim().toLowerCase())) return `Another provider is already called ${name.trim()}.`;
    for (const key of getRequiredSettingKeys(npm)) if (!settings[key]?.trim()) return `Add the ${getSettingLabel(key).toLowerCase()}.`;
    if (signIn === "member") {
      if (!memberSignInSupported) return `${detail.name} doesn’t support signing in with individual accounts.`;
      const hasSecret = Boolean(oauthClientSecret.trim()) || (primarySet?.credentialMode === "member" && primarySet.hasOauthClientSecret);
      if (!oauthClientId.trim() || !hasSecret) return "Add your Google OAuth client ID and client secret.";
    } else if (keyEditable && !keyEntered) {
      return keyShape === "service_account" ? "Paste the service account key file." : "Paste an API key.";
    }
    if (keyShape === "service_account" && signIn === "org" && secret.trim()) {
      try {
        const parsed: unknown = JSON.parse(secret);
        if (!parsed || typeof parsed !== "object" || !("type" in parsed) || parsed.type !== "service_account") return "Paste a Google service account key file (type: service_account).";
      } catch { return "The service account key file isn’t valid JSON."; }
    }
    if (!models.allModels && !models.modelIds.length) return "Pick at least one model, or choose all models.";
    return null;
  }

  async function create() {
    if (!detail) return;
    const body: Partial<InferenceProviderRequestBody> = {
      name: (showName ? name : detail.name).trim(),
      providerId: detail.id,
      modelIds: models.allModels ? [] : [...new Set(models.modelIds)],
      status: "active",
      credentialMode: signIn,
      ...(getRequiredSettingKeys(npm).length ? { settings: Object.fromEntries(getRequiredSettingKeys(npm).map((key) => [key, settings[key]?.trim() ?? ""])) } : {}),
      ...credentialFields(),
      allMembers: who.orgWide,
      teamIds: who.orgWide ? [] : who.teamIds,
      memberIds: who.orgWide ? [] : who.memberIds,
    };
    const saved = await saveInferenceProvider({ inferenceProviderId: null, body });
    // The page stays and becomes the saved provider.
    router.replace(getGatewayProviderRoute(orgSlug, saved.id));
    router.refresh();
  }

  async function update(current: DenInferenceProviderDetails) {
    if (!orgId || !pair?.credentialSetId || !pair.modelGroupId || !primarySet) throw new Error("This provider is missing its key or model list. Remove it and add it again.");
    const setId = pair.credentialSetId;
    const groupId = pair.modelGroupId;

    if (showName && name.trim() !== current.name) {
      await saveInferenceProvider({ inferenceProviderId: current.id, body: { name: name.trim() } });
    }

    const modeChanged = (signIn === "member") !== (primarySet.credentialMode === "member");
    const credentials = credentialFields();
    if (modeChanged || Object.keys(credentials).length) {
      const patch: GatewayCredentialSetPatch = { credentialMode: signIn, ...credentials };
      await patchGatewayResource(current.id, setId, { resource: "credential-sets", body: patch });
    }

    const nextUniverse = models.allModels ? [] : [...new Set(models.modelIds)];
    const savedUniverse = current.modelIds ?? [];
    const universeChanged = nextUniverse.length !== savedUniverse.length || nextUniverse.some((id) => !savedUniverse.includes(id));
    if (universeChanged) {
      await saveInferenceProvider({ inferenceProviderId: current.id, body: { modelIds: nextUniverse } });
      // Keep the provider's one model group equal to its model list.
      const groupModelIds = await requestGatewayCatalogModelIds(orgId, current.id);
      await patchGatewayResource(current.id, groupId, { resource: "model-groups", body: { modelIds: groupModelIds } });
    }

    const plan = planGrantChanges(pairGrants, who);
    for (const audience of plan.create) {
      await saveGatewayResource(current.id, null, { resource: "access-grants", body: { modelGroupId: groupId, credentialSetId: setId, audience } });
    }
    for (const grantId of plan.removeGrantIds) await deleteGatewayResource(current.id, "access-grants", grantId);

    setSecret("");
    setApiKeys({});
    setOauthClientSecret("");
    setReplacingKey(false);
    setKeyTest({ state: "idle" });
    await reload();
  }

  async function save() {
    setSaveError(null);
    const problem = validate();
    if (problem) return setSaveError(problem);
    setSaving(true);
    try {
      await runReauthableAction(isEdit ? "save-gateway-provider" : "create-gateway-provider", () => (provider ? update(provider) : create()));
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Couldn’t save the provider. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!provider) return;
    setSaving(true);
    setSaveError(null);
    try {
      await runReauthableAction("delete-inference-provider", async () => {
        await deleteInferenceProvider(provider.id);
        setConfirmRemove(false);
        router.push(getGatewayProvidersRoute(orgSlug));
        router.refresh();
      });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Couldn’t remove the provider.");
    } finally {
      setSaving(false);
    }
  }

  if (inferenceProviderId && !provider) {
    return (
      <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8">
        {providerBusy ? <div className="h-10 w-64 animate-pulse rounded-lg bg-gray-100" aria-label="Loading provider" /> : <DenNotice tone="error" message={providerError ?? "This provider no longer exists."} />}
      </div>
    );
  }

  const title = isEdit ? (provider?.name ?? providerName) : `Add ${detail?.name ?? "provider"}`;
  const breadcrumb = isEdit
    ? [{ label: "AI Gateway", href: getGatewayProvidersRoute(orgSlug) }, { label: provider?.name ?? providerName }]
    : [{ label: "AI Gateway", href: getGatewayProvidersRoute(orgSlug) }, { label: "Add a provider", href: getNewGatewayProviderRoute(orgSlug) }, { label: detail?.name ?? "…" }];
  const requiredSettings = getRequiredSettingKeys(npm);
  const disabled = saving || !detail;

  const keyPanel = (
    <GatewayPanel title={keyShape === "service_account" ? "Google Cloud" : "Key"} testId="gateway-provider-key">
      <div className="grid gap-4">
        {memberSignInSupported ? (
          <DenSegmented<SignIn>
            aria-label="How people sign in"
            value={signIn}
            onChange={(next) => { setSignIn(next); clearKeyTest(); setSaveError(null); }}
            options={[{ value: "org", label: "One org account" }, { value: "member", label: "Individual accounts" }]}
          />
        ) : null}

        {requiredSettings.length ? (
          <div className="grid gap-3 md:grid-cols-[1fr_260px]">
            {requiredSettings.map((key) => (
              <label key={key} className="grid gap-1.5 text-[12.5px] text-gray-700">
                {getSettingLabel(key)}
                <DenInput
                  value={settings[key] ?? ""}
                  readOnly={isEdit}
                  disabled={disabled}
                  onChange={(event) => setSettings((current) => ({ ...current, [key]: key === "resourceName" ? normalizeAzureResourceNameInput(event.target.value) : event.target.value }))}
                />
              </label>
            ))}
          </div>
        ) : null}

        {signIn === "member" ? (
          <div className="grid gap-3 md:grid-cols-[1fr_260px]">
            <label className="grid gap-1.5 text-[12.5px] text-gray-700">
              Google OAuth client ID
              <DenInput value={oauthClientId} disabled={disabled} autoComplete="off" onChange={(event) => setOauthClientId(event.target.value)} />
            </label>
            <label className="grid gap-1.5 text-[12.5px] text-gray-700">
              Client secret
              <DenInput
                type={primarySet?.hasOauthClientSecret && !oauthClientSecret ? "password" : "text"}
                value={oauthClientSecret}
                disabled={disabled}
                autoComplete="off"
                placeholder={primarySet?.credentialMode === "member" && primarySet.hasOauthClientSecret ? SAVED_KEY_MASK : ""}
                onChange={(event) => setOauthClientSecret(event.target.value)}
              />
            </label>
            {provider?.oauthCallbackUrl ? (
              <p className="text-[12px] text-gray-500 md:col-span-2">
                Redirect URI for your OAuth client: <code className="break-all font-mono text-gray-700">{provider.oauthCallbackUrl}</code>
              </p>
            ) : null}
          </div>
        ) : !keyEditable ? (
          <div className="grid gap-1.5 text-[12.5px] text-gray-700">
            {keyShape === "service_account" ? "Service account key" : "API key"}
            <div className="flex items-center gap-3">
              <DenInput value={primarySet?.configured ? SAVED_KEY_MASK : ""} placeholder="No key saved" readOnly aria-label="Saved key" className="font-mono text-gray-500" />
              <DenButton variant="secondary" disabled={disabled} onClick={() => setReplacingKey(true)} data-testid="gateway-provider-replace-key">Replace key</DenButton>
              {primarySet?.configured ? <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-label="Key saved" /> : null}
            </div>
          </div>
        ) : keyShape === "service_account" ? (
          <label className="grid gap-1.5 text-[12.5px] text-gray-700">
            Service account key file
            <DenTextarea value={secret} rows={5} spellCheck={false} autoComplete="off" disabled={disabled} placeholder="Paste the JSON key file" onChange={(event) => setSecret(event.target.value)} />
          </label>
        ) : keyShape === "api_keys" ? (
          envNames.map((env) => (
            <label key={env} className="grid gap-1.5 text-[12.5px] text-gray-700">
              {env}
              <DenInput value={apiKeys[env] ?? ""} disabled={disabled} autoComplete="off" spellCheck={false} className="font-mono" onChange={(event) => setApiKeys((current) => ({ ...current, [env]: event.target.value }))} />
            </label>
          ))
        ) : (
          <div className="grid gap-1.5 text-[12.5px] text-gray-700">
            <label htmlFor="gateway-provider-api-key">API key</label>
            <div className="flex items-center gap-3">
              {/* Plain text while typing (settled in review); masked once saved. */}
              <DenInput
                id="gateway-provider-api-key"
                data-testid="gateway-provider-api-key"
                value={secret}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                onChange={(event) => { setSecret(event.target.value); clearKeyTest(); }}
              />
              {testApiBase ? (
                <DenButton variant="secondary" loading={keyTest.state === "testing"} disabled={disabled || !secret.trim()} onClick={() => void testKey()} data-testid="gateway-provider-test-key">
                  Test key
                </DenButton>
              ) : null}
              {keyTest.state === "ok" ? <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-label="Key works" data-testid="gateway-provider-key-ok" /> : null}
            </div>
            {keyTest.state === "failed" ? <p className="text-[12.5px] text-red-700">{keyTest.message}</p> : null}
          </div>
        )}
      </div>
    </GatewayPanel>
  );

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8 md:px-8" data-testid="gateway-provider-form">
      <Breadcrumb items={breadcrumb} />
      <div className="mb-6 flex items-center gap-3">
        {catalogProviderId ? (
          <DenBrandMark
            name={providerName}
            simpleIconSlug={getProviderIconSlug(catalogProviderId)}
            serviceUrl={detail ? getProviderDocUrl(detail.config) : null}
            className="h-10 w-10 rounded-[10px]"
            imageClassName="h-5 w-5"
          />
        ) : null}
        <h1 className="text-[22px] font-semibold tracking-[-0.3px] text-gray-950">{title}</h1>
      </div>

      {catalogError ? <DenNotice tone="error" message={catalogError} className="mb-4" /> : null}

      {!simple && provider ? (
        <div className="grid gap-4">
          <DenNotice tone="info" message="This provider has more than one key or model list, so it’s edited below." />
          <GatewayAccessMatrix key={`${orgId}:${provider.id}`} provider={provider} reload={reload} />
        </div>
      ) : (
        <div className="grid gap-4">
          {showName ? (
            <GatewayPanel title="Name">
              <DenInput
                value={name}
                disabled={disabled}
                aria-label="Name"
                data-testid="gateway-provider-name"
                placeholder={`${providerName} (Marketing)`}
                onChange={(event) => setName(event.target.value)}
              />
            </GatewayPanel>
          ) : null}
          {keyPanel}
          <GatewayWhoCanUseIt value={who} onChange={setWho} disabled={disabled} />
          <GatewayModelsPanel
            providerName={providerName}
            catalogProviderId={catalogProviderId ?? ""}
            models={detail?.models ?? null}
            value={models}
            onChange={setModels}
            disabled={disabled}
          />
        </div>
      )}

      {saveError ? <DenNotice tone="error" message={saveError} className="mt-4" /> : null}

      <DenStickyActionBar testId="gateway-provider-actions" summary={isEdit && dirty ? <span>Unsaved changes</span> : null}>
        {isEdit ? (
          <>
            <DenButton variant="secondary" disabled={saving} onClick={() => setConfirmRemove(true)} data-testid="gateway-provider-remove">Remove</DenButton>
            {simple ? (
              <DenButton loading={saving} disabled={disabled || !dirty} onClick={() => void save()} data-testid="gateway-provider-save">Save changes</DenButton>
            ) : null}
          </>
        ) : (
          <>
            <Link href={getNewGatewayProviderRoute(orgSlug)} className={buttonVariants({ variant: "secondary" })}>Cancel</Link>
            <DenButton loading={saving} disabled={disabled} onClick={() => void save()} data-testid="gateway-provider-save">Add {detail?.name ?? "provider"}</DenButton>
          </>
        )}
      </DenStickyActionBar>

      {provider ? (
        <AlertDialog.Root open={confirmRemove && !reauthDialogOpen} onOpenChange={(open) => { if (!saving) setConfirmRemove(open); }}>
          <AlertDialog.Portal>
            <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
            <AlertDialog.Popup
              initialFocus={cancelRemoveRef}
              aria-busy={saving}
              className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[24px] border border-gray-200 bg-white p-6 outline-none"
            >
              <AlertDialog.Title className="text-[16px] font-semibold text-gray-950">Remove {provider.name}?</AlertDialog.Title>
              <AlertDialog.Description className="mt-2 text-[13px] leading-6 text-gray-600">
                Everyone who uses it loses its models right away. The key is deleted. This can’t be undone.
              </AlertDialog.Description>
              {saveError ? <DenNotice className="mt-4" tone="error" message={saveError} /> : null}
              <div className="mt-6 flex justify-end gap-3">
                <AlertDialog.Close ref={cancelRemoveRef} disabled={saving} className={buttonVariants({ variant: "secondary" })}>Cancel</AlertDialog.Close>
                <DenButton variant="destructive" loading={saving} onClick={() => void remove()} data-testid="gateway-provider-remove-confirm">Remove {provider.name}</DenButton>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      ) : null}
    </div>
  );
}
