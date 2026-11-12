"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { LockKeyhole, RefreshCw } from "lucide-react";
import { createAuditOperationContext } from "@openwork/types/den/audit";
import { normalizeGatewayCustomBaseUrl, type GatewayCustomDiscoveryStatus, type GatewayCustomTestResponse, type GatewayCustomUpdateRequest } from "@openwork/types/den/gateway-custom-providers";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSecretInput } from "../../_components/ui/secret-input";
import { DenSelect } from "../../_components/ui/select";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { getAiGatewayProvidersRoute, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { discoverCustomProviderModels, syncCustomProviderAccess, testCustomProvider, testRequestFailure, updateCustomProvider } from "./custom-provider-data";
import { CustomProviderModelList, useModelTemplates, type ModelListHighlight, type ModelTemplate } from "./custom-provider-model-list";
import {
  applyTemplateSettings, chatCompletionsUrl, checkSelectedModels, connectionError, EMPTY_MODEL_SETTINGS, mergeDiscoveredModels, newOriginNeedsKey, resolveTestModelKey, savedProviderNeedsTest,
  settingsFromModel, testFailureTarget, testFingerprint, type ConnectionField, type ModelDraft, type ModelSettingsDraft,
} from "./custom-provider-models";
import { deleteInferenceProvider, useOrgInferenceProviders } from "./inference-provider-data";
import { accessFromGrants, type DenInferenceProviderDetails } from "./inference-provider-request";
import { formatProviderTimestamp } from "./llm-provider-data";
import { ProviderRemovalUsageLimits, useProviderRemovalUsageLimits } from "./provider-removal-usage-limits";
import { WhoCanUseIt } from "./who-can-use-it";
import type { AccessDraft } from "./access-summary";

const CARD = "rounded-[12px] border border-gray-100 bg-white p-4";
const CARD_TITLE = "text-[13px] font-medium text-gray-900";
const LABEL = "mt-3 block text-[12px] font-medium text-gray-700";
const INVALID = "border-red-300 ring-2 ring-red-100";

function savedDrafts(provider: DenInferenceProviderDetails): ModelDraft[] {
  return (provider.custom?.models ?? []).map((model, index) => ({ key: `s${index}`, settings: settingsFromModel(model), origin: { kind: "saved" }, selected: true, configured: true, missing: false }));
}

function savedAccess(provider: DenInferenceProviderDetails): AccessDraft {
  const access = accessFromGrants(provider.accessGrants);
  return { orgWide: access.allMembers, memberIds: access.memberIds, teamIds: access.teamIds };
}

/** A saved custom OpenAI-compatible provider: connection, models with every setting, re-fetch, access, remove. */
export function CustomProviderManageScreen({ provider, reload, embedded = false }: { provider: DenInferenceProviderDetails; reload: () => Promise<void>; embedded?: boolean }) {
  const Heading = embedded ? "h2" : "h1";
  const router = useRouter();
  const { orgId, orgSlug, orgContext, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const enabled = orgFeatureEnabled(orgContext, "gatewayCustomProviders");
  const custom = provider.custom;
  const editable = enabled && custom !== null;
  const templates = useModelTemplates(editable ? orgId : null);
  const initialAccess = useMemo(() => savedAccess(provider), [provider]);
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(custom?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [drafts, setDrafts] = useState<ModelDraft[]>(() => savedDrafts(provider));
  const nextKey = useRef(1);
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<ModelListHighlight>(null);
  const [fieldError, setFieldError] = useState<{ field: ConnectionField; message: string } | null>(null);
  const [access, setAccess] = useState<AccessDraft>(initialAccess);
  const [discoveryStatus, setDiscoveryStatus] = useState<GatewayCustomDiscoveryStatus | null>(null);
  /** Ids the provider listed at its last answered fetch, saved or on screen; hand-added models are never in it. */
  const [listedModelIds, setListedModelIds] = useState<string[]>(() => custom?.discovery.listedModelIds ?? []);
  const [refetching, setRefetching] = useState(false);
  const [refetchNotice, setRefetchNotice] = useState<{ tone: "info" | "neutral" | "error"; message: string } | null>(null);
  const [testModelChoice, setTestModelChoice] = useState<string | null>(null);
  const [test, setTest] = useState<{ fingerprint: string; result: GatewayCustomTestResponse | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removing, setRemoving] = useState(false);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const { inferenceProviders } = useOrgInferenceProviders(orgId);
  const removalLimits = useProviderRemovalUsageLimits({ orgId, providerId: provider.id, open: confirmDelete, providers: inferenceProviders });

  const makeKey = () => `n${nextKey.current++}`;
  const testModelKey = resolveTestModelKey(drafts, testModelChoice);
  const fingerprint = testFingerprint({ baseUrl, apiKey, drafts, testModelKey });
  const testResult = test && test.fingerprint === fingerprint ? test.result : null;
  const testing = test !== null && test.fingerprint === fingerprint && test.result === null;
  const passed = testResult?.ok === true;
  const check = checkSelectedModels(drafts);
  const needsTest = custom !== null && check.ok && savedProviderNeedsTest({ baseUrl: custom.baseUrl, models: custom.models }, { baseUrl, apiKey, models: check.models });
  const modelsChanged = custom !== null && (!check.ok || JSON.stringify(check.models) !== JSON.stringify(custom.models));
  const accessChanged = JSON.stringify(access) !== JSON.stringify(initialAccess);
  const normalizedBaseUrl = normalizeGatewayCustomBaseUrl(baseUrl);
  const dirty = name.trim() !== provider.name || (normalizedBaseUrl ?? baseUrl) !== (custom?.baseUrl ?? "") || Boolean(apiKey.trim()) || modelsChanged || accessChanged;
  const selected = drafts.filter((draft) => draft.selected);
  const endpoint = chatCompletionsUrl(baseUrl);
  const busy = saving || removing || refetching;
  /** The tested model's display name when it has one, else its id. */
  const testedModelLabel = (modelId: string) => drafts.find((draft) => draft.settings.id.trim() === modelId)?.settings.name.trim() || modelId;

  const editDraft = (key: string, change: (draft: ModelDraft) => ModelDraft) => {
    setDrafts((current) => current.map((draft) => draft.key === key ? change(draft) : draft));
    if (highlight?.key === key) setHighlight(null);
  };
  const fieldInvalid = (field: ConnectionField) => fieldError?.field === field;

  async function refetch() {
    if (!custom) return;
    const problem = normalizedBaseUrl ? connectionProblem() : null;
    if (problem) { setFieldError(problem); if (problem.field === "apiKey") setReplacingKey(true); return; }
    setRefetching(true);
    setRefetchNotice(null);
    try {
      await runReauthableAction("refetch-custom-provider-models", async () => {
        const urlChanged = normalizedBaseUrl !== null && normalizedBaseUrl !== custom.baseUrl;
        // A new key or URL on screen is not saved yet; re-fetching uses what is saved unless the URL changed.
        const response = apiKey.trim() && normalizedBaseUrl
          ? await discoverCustomProviderModels({ baseUrl: normalizedBaseUrl, apiKey: apiKey.trim() })
          : await discoverCustomProviderModels({ inferenceProviderId: provider.id, ...(urlChanged ? { baseUrl: normalizedBaseUrl } : {}) });
        const current = draftsRef.current;
        const merged = mergeDiscoveredModels(current, response.models, response.status, { selectMatched: false, makeKey, previouslyListed: new Set(listedModelIds) });
        const added = merged.length - current.length;
        const missing = merged.filter((draft) => draft.missing).length;
        setDrafts(merged);
        setDiscoveryStatus(response.status);
        if (response.status !== "unavailable") setListedModelIds([...new Set(response.models.map((entry) => entry.id))]);
        if (response.status === "unavailable") {
          setRefetchNotice({ tone: "error", message: `${provider.name} didn't list its models${response.reason ? `: ${response.reason}` : "."} Your models are unchanged.` });
        } else {
          const parts = [added ? `${added} new ${added === 1 ? "model" : "models"} to add` : "No new models"];
          if (missing) parts.push(`${missing} no longer listed`);
          setRefetchNotice({ tone: added || missing ? "info" : "neutral", message: `${parts.join(", ")}. Nothing changes until you save.` });
        }
      });
    } catch (cause) {
      setRefetchNotice({ tone: "error", message: cause instanceof Error ? cause.message : "Could not fetch models. Try again." });
    } finally { setRefetching(false); }
  }

  function connectionProblem(): { field: ConnectionField; message: string } | null {
    const problem = connectionError({ name, baseUrl, apiKey, apiKeyRequired: false });
    if (problem) return problem;
    return custom && newOriginNeedsKey(custom.baseUrl, baseUrl, apiKey) ? { field: "apiKey", message: "Paste the key again. The saved key is only sent to the address it was saved for." } : null;
  }

  async function runTest() {
    setError(null);
    const problem = connectionProblem();
    if (problem) { setFieldError(problem); if (problem.field === "apiKey") setReplacingKey(true); return; }
    if (!check.ok) {
      setHighlight(check.key ? { key: check.key, field: check.field, message: check.message } : null);
      if (check.key) setExpandedKey(check.key);
      if (!check.key) setError(check.message);
      return;
    }
    const index = selected.findIndex((draft) => draft.key === testModelKey);
    const model = check.models[index];
    if (!normalizedBaseUrl || !model) return;
    const ranFor = fingerprint;
    setTest({ fingerprint: ranFor, result: null });
    let result = testRequestFailure(model.id, null);
    try {
      await runReauthableAction("test-custom-provider", async () => {
        result = await testCustomProvider({ baseUrl: normalizedBaseUrl, inferenceProviderId: provider.id, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), model });
      });
    } catch (cause) {
      result = testRequestFailure(model.id, cause);
    }
    setTest((current) => current?.fingerprint === ranFor ? { fingerprint: ranFor, result } : current);
    if (result.ok) return;
    const target = testFailureTarget(result, testModelKey);
    if (target?.step === "connection") { setFieldError({ field: target.field, message: result.message }); if (target.field === "apiKey") setReplacingKey(true); }
    else if (target?.step === "model") { setHighlight({ key: target.modelKey, field: null, message: result.message }); setExpandedKey(target.modelKey); }
  }

  async function save() {
    if (!custom) return;
    setError(null);
    const problem = connectionProblem();
    if (problem) { setFieldError(problem); if (problem.field === "apiKey") setReplacingKey(true); return; }
    if (!check.ok) {
      setHighlight(check.key ? { key: check.key, field: check.field, message: check.message } : null);
      if (check.key) setExpandedKey(check.key);
      else setError(check.message);
      return;
    }
    if (needsTest && !passed) { setError(`Test ${name.trim() || provider.name} before saving. A new URL, key or model ID must answer first.`); return; }
    const body: GatewayCustomUpdateRequest = {
      ...(name.trim() !== provider.name ? { name: name.trim() } : {}),
      ...(normalizedBaseUrl && normalizedBaseUrl !== custom.baseUrl ? { baseUrl: normalizedBaseUrl } : {}),
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      ...(modelsChanged ? { models: check.models } : {}),
      ...(discoveryStatus ? { discoveryStatus, listedModelIds } : {}),
    };
    setSaving(true);
    try {
      await runReauthableAction("save-custom-provider", async () => {
        const auditContext = createAuditOperationContext();
        if (Object.keys(body).length) await updateCustomProvider(provider.id, body, auditContext);
        if (accessChanged) await syncCustomProviderAccess(provider, access, auditContext);
        router.push(getAiGatewayProvidersRoute(orgSlug));
        router.refresh();
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the provider.");
      await reload().catch(() => undefined);
    } finally { setSaving(false); }
  }

  async function remove() {
    setRemoving(true);
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
    } finally { setRemoving(false); }
  }

  const applyTemplate = (key: string, template: ModelTemplate) => editDraft(key, (draft) => ({
    ...draft, settings: applyTemplateSettings(draft.settings, template.settings), origin: { kind: "template", templateId: template.id, templateName: template.name }, configured: true, selected: true,
  }));
  const addDraft = (settings: ModelSettingsDraft, origin: ModelDraft["origin"]) => {
    const key = makeKey();
    setDrafts((current) => [...current, { key, settings, origin, selected: true, configured: true, missing: false }]);
    setExpandedKey(key);
  };

  return (
    <div className={embedded ? "pb-28" : "mx-auto max-w-[860px] px-6 py-6 pb-28"} data-testid="custom-provider-manage">
      <nav className="text-[12px] text-gray-500" aria-label="Breadcrumb">
        <Link href={getAiGatewayProvidersRoute(orgSlug)} className="hover:text-gray-900">AI Providers</Link>
        <span className="mx-1.5 text-gray-300">/</span><span className="text-gray-900">{provider.name}</span>
      </nav>
      <div className="mt-3 flex items-center gap-3">
        <DenBrandMark name={provider.name} className="h-8 w-8 rounded-[8px]" imageClassName="h-4 w-4" />
        <Heading className="min-w-0 flex-1 truncate text-[20px] font-medium tracking-[-0.02em] text-gray-900" data-testid="gateway-provider-title">{provider.name}</Heading>
        {editable ? <DenButton variant="secondary" icon={RefreshCw} loading={refetching} disabled={busy && !refetching} onClick={() => void refetch()} data-testid="custom-provider-refetch">Re-fetch models</DenButton> : null}
      </div>
      {!enabled ? <div data-testid="custom-provider-feature-off"><DenNotice className="mt-4" tone="neutral" icon={LockKeyhole} message="Custom providers aren't turned on for your organization, so this provider can't be changed. Ask OpenWork to turn them on. You can still remove it." /></div> : null}
      {enabled && !custom ? <DenNotice className="mt-4" tone="error" message="Could not read this provider's settings. Reload the page, or remove the provider and add it again." /> : null}
      {error ? <DenNotice tone="error" message={error} className="mt-4" /> : null}
      {refetchNotice ? <div data-testid="custom-provider-refetch-result"><DenNotice className="mt-4" tone={refetchNotice.tone} message={refetchNotice.message} /></div> : null}

      {custom ? (
        <>
          <section className={`${CARD} mt-5`} aria-labelledby="custom-connection-heading" data-testid="custom-provider-connection">
            <h2 id="custom-connection-heading" className={CARD_TITLE}>Connection</h2>
            <label className={LABEL}>Name
              <DenInput className={`mt-1.5 ${fieldInvalid("name") ? INVALID : ""}`} value={name} disabled={!editable || busy} aria-invalid={fieldInvalid("name")} data-testid="custom-provider-name"
                onChange={(event) => { setName(event.target.value); if (fieldInvalid("name")) setFieldError(null); }} />
            </label>
            {fieldInvalid("name") ? <p className="mt-1.5 text-[12px] text-red-700" role="alert">{fieldError?.message}</p> : null}
            <label className={LABEL}>API URL
              <DenInput className={`mt-1.5 font-mono text-[12px] ${fieldInvalid("baseUrl") ? INVALID : ""}`} value={baseUrl} disabled={!editable || busy} inputMode="url" autoComplete="off" aria-invalid={fieldInvalid("baseUrl")} data-testid="custom-provider-base-url"
                onChange={(event) => { setBaseUrl(event.target.value); if (fieldInvalid("baseUrl")) setFieldError(null); }} />
            </label>
            {fieldInvalid("baseUrl") ? <p className="mt-1.5 text-[12px] text-red-700" role="alert" data-testid="custom-provider-base-url-error">{fieldError?.message}</p> : null}
            <p className="mt-1.5 text-[12px] text-gray-500" data-testid="custom-provider-endpoint">
              {endpoint ? <>Requests go to <span className="break-all font-mono text-gray-700">{endpoint}</span>. </> : null}Public HTTPS addresses only; private networks such as localhost or 10.x need your OpenWork operator&apos;s approval.
            </p>
            <label className={LABEL}>API key
              <DenSecretInput className={`mt-1.5 font-mono text-[12px] ${fieldInvalid("apiKey") ? INVALID : ""}`} value={apiKey} disabled={!editable || busy} autoComplete="new-password" placeholder="Paste the new key"
                saved={custom.hasKey} replacing={replacingKey} onReplacingChange={setReplacingKey} replaceTestId="custom-provider-replace-key" aria-invalid={fieldInvalid("apiKey")} data-testid="custom-provider-api-key"
                onChange={(value) => { setApiKey(value); if (fieldInvalid("apiKey")) setFieldError(null); }} />
            </label>
            {fieldInvalid("apiKey") ? <p className="mt-1.5 text-[12px] text-red-700" role="alert" data-testid="custom-provider-api-key-error">{fieldError?.message}</p> : null}
          </section>

          <section className={`${CARD} mt-3`} aria-labelledby="custom-models-heading" data-testid="custom-provider-models">
            <h2 id="custom-models-heading" className={CARD_TITLE}>Models</h2>
            <CustomProviderModelList drafts={drafts} expandedKey={expandedKey} highlight={highlight} templates={templates} disabled={!editable || busy}
              onToggle={(key) => editDraft(key, (draft) => ({ ...draft, selected: !draft.selected }))}
              onSetAll={(value) => setDrafts((current) => current.map((draft) => ({ ...draft, selected: value })))}
              onUpdate={(key, patch) => editDraft(key, (draft) => ({ ...draft, settings: { ...draft.settings, ...patch }, configured: true }))}
              onApplyTemplate={applyTemplate}
              onSetUpManually={(key) => { editDraft(key, (draft) => ({ ...draft, configured: true, selected: true, origin: draft.origin.kind === "unknown" ? { kind: "custom" } : draft.origin })); setExpandedKey(key); }}
              onAddTemplate={(template) => addDraft(template.settings, { kind: "template", templateId: template.id, templateName: template.name })}
              onAddCustom={() => addDraft({ ...EMPTY_MODEL_SETTINGS }, { kind: "custom" })}
              onRemove={(key) => { setDrafts((current) => current.filter((draft) => draft.key !== key)); if (expandedKey === key) setExpandedKey(null); }}
              onExpand={setExpandedKey} />
          </section>

          {needsTest ? (
            <section className={`${CARD} mt-3`} aria-labelledby="custom-test-heading" data-testid="custom-provider-test-step">
              <h2 id="custom-test-heading" className={CARD_TITLE}>Test before saving</h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <div className="w-[300px] max-w-full">
                  <DenSelect aria-label="Model to test" value={testModelKey ?? ""} onChange={(event) => setTestModelChoice(event.target.value)} data-testid="custom-provider-test-model">
                    {selected.map((draft) => <option key={draft.key} value={draft.key}>{draft.settings.name.trim() || draft.settings.id}</option>)}
                  </DenSelect>
                </div>
                <DenButton variant={passed ? "secondary" : "primary"} loading={testing} disabled={busy || !testModelKey} data-testid="custom-provider-test" onClick={() => void runTest()}>{`Test ${name.trim() || provider.name}`}</DenButton>
              </div>
              {testResult ? (
                <div data-testid="custom-provider-test-result" data-ok={testResult.ok}>
                  <DenNotice className="mt-3" presentation="inline" tone={testResult.ok ? "success" : "error"} message={testResult.ok ? `${name.trim() || provider.name} answered a test prompt from ${testedModelLabel(testResult.model)}. You can save now.` : testResult.message} />
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="mt-5" aria-labelledby="custom-access-heading">
            <h2 id="custom-access-heading" className={`${CARD_TITLE} mb-2`}>Who can use it</h2>
            <WhoCanUseIt value={access} onChange={setAccess} members={orgContext?.members ?? []} teams={orgContext?.teams ?? []} owner={null} canShareWithEveryone disabled={!editable || busy}
              everyoneOffDescription="Off. Only the people and teams below can use these models." />
          </section>
        </>
      ) : null}

      <DenStickyActionBar testId="custom-provider-actions" summary={<span>{custom ? `${selected.length} ${selected.length === 1 ? "model" : "models"}` : provider.name}{provider.updatedAt ? ` · saved ${formatProviderTimestamp(provider.updatedAt)}` : ""}</span>}>
        <AlertDialog.Root open={confirmDelete && !reauthDialogOpen} onOpenChange={(open) => { if (removing) return; setConfirmDelete(open); if (open) setError(null); else removalLimits.reset(); }}>
          <AlertDialog.Trigger disabled={busy} className={buttonVariants({ variant: "secondary" })} data-testid="gateway-provider-remove">Remove</AlertDialog.Trigger>
          <AlertDialog.Portal>
            <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
            <AlertDialog.Popup initialFocus={cancelDeleteRef} aria-busy={removing} className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[16px] border border-gray-200 bg-white p-5 outline-none">
              <AlertDialog.Title className="text-[15px] font-medium text-gray-950">Remove {provider.name}?</AlertDialog.Title>
              <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-gray-600">People lose these models the next time they open OpenWork. This cannot be undone.</AlertDialog.Description>
              <ProviderRemovalUsageLimits providerName={provider.name} usageLimits={removalLimits.usageLimits} targets={removalLimits.targets} choice={removalLimits.choice} onChange={removalLimits.setChoice} disabled={removing} />
              {error ? <DenNotice className="mt-4" tone="error" message={error} /> : null}
              <div className="mt-5 flex justify-end gap-2">
                <AlertDialog.Close ref={cancelDeleteRef} disabled={removing} className={buttonVariants({ variant: "secondary" })}>Cancel</AlertDialog.Close>
                <DenButton variant="destructive" loading={removing} onClick={() => void remove()}>Remove provider</DenButton>
              </div>
            </AlertDialog.Popup>
          </AlertDialog.Portal>
        </AlertDialog.Root>
        {editable ? (
          <DenButton data-testid="custom-provider-save" loading={saving} disabled={!dirty || (busy && !saving) || (needsTest && !passed)} onClick={() => void save()}>Save changes</DenButton>
        ) : null}
      </DenStickyActionBar>
    </div>
  );
}
