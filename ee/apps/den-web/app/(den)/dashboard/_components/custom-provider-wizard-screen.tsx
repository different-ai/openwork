"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useStore } from "zustand";
import { Check, Loader2, LockKeyhole } from "lucide-react";
import { createAuditOperationContext } from "@openwork/types/den/audit";
import { normalizeGatewayCustomBaseUrl, type GatewayCustomDiscoverResponse } from "@openwork/types/den/gateway-custom-providers";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSecretInput } from "../../_components/ui/secret-input";
import { DenSelect } from "../../_components/ui/select";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { getAiGatewayProvidersRoute, getNewAiGatewayProviderRoute, orgFeatureEnabled } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { createCustomProvider, discoverCustomProviderModels, testCustomProvider, testRequestFailure } from "./custom-provider-data";
import { chatCompletionsUrl, checkSelectedModels, type ConnectionField } from "./custom-provider-models";
import { CustomProviderModelList, useModelTemplates } from "./custom-provider-model-list";
import {
  connectionKey, createWizardStore, currentTestResult, needsDiscovery, WIZARD_STEPS, wizardFingerprint, wizardTestModelKey, wizardTestPassed,
  type WizardState, type WizardStep, type WizardStore,
} from "./custom-provider-wizard-store";
import { WhoCanUseIt } from "./who-can-use-it";

const CARD = "rounded-[12px] border border-gray-100 bg-white p-4";
const CARD_TITLE = "text-[13px] font-medium text-gray-900";
const LABEL = "mt-3 block text-[12px] font-medium text-gray-700";
const INVALID = "border-red-300 ring-2 ring-red-100";

/** Custom provider pages exist only while `gatewayCustomProviders` is on for the organization. */
export function CustomProvidersFeatureGate({ children }: { children: React.ReactNode }) {
  const { orgContext, orgSlug } = useOrgDashboard();
  if (!orgContext) return null;
  if (!orgFeatureEnabled(orgContext, "gatewayCustomProviders")) {
    return (
      <div data-testid="custom-provider-feature-off">
        <DenNotice tone="neutral" icon={LockKeyhole} message="Custom providers aren't turned on for your organization yet. Ask OpenWork to turn them on."
          action={<Link href={getNewAiGatewayProviderRoute(orgSlug)} className={buttonVariants({ variant: "secondary", size: "sm" })}>Add another provider</Link>} />
      </div>
    );
  }
  return <>{children}</>;
}

export function CustomProviderWizardScreen({ embedded = false }: { embedded?: boolean }) {
  // One store per visit: in memory only, gone when the admin leaves the page.
  const [store] = useState(() => createWizardStore());
  return <CustomProvidersFeatureGate><Wizard store={store} embedded={embedded} /></CustomProvidersFeatureGate>;
}

function discoveryMessage(name: string, response: GatewayCustomDiscoverResponse): string {
  const total = response.models.length;
  const matched = response.models.filter((model) => model.match !== null).length;
  const models = `${total} ${total === 1 ? "model" : "models"}`;
  if (response.status === "unavailable") return `${name} didn't list its models${response.reason ? `: ${response.reason}` : "."} Add them on the next step.`;
  if (!total) return `${name} answered, but listed no models. Add them on the next step.`;
  const matchedText = matched === total ? (total === 1 ? "It matched a known model." : "All matched known models.") : matched ? `${matched} matched ${matched === 1 ? "a known model" : "known models"}; the rest need settings.` : "None matched known models; they need settings.";
  return response.status === "detailed" ? `${name} listed ${models} with their details. ${matchedText}` : `${name} listed ${models}. ${matchedText}`;
}

function StepIndicator({ step, onGo }: { step: WizardStep; onGo: (step: WizardStep) => void }) {
  return (
    <ol className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Steps" data-testid="custom-provider-steps">
      {WIZARD_STEPS.map((entry) => {
        const done = entry.step < step;
        const current = entry.step === step;
        const content = (
          <>
            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-medium ${current ? "bg-gray-900 text-white" : done ? "bg-gray-200 text-gray-700" : "border border-gray-200 text-gray-400"}`}>
              {done ? <Check className="h-3 w-3" aria-hidden="true" strokeWidth={2} /> : entry.step}
            </span>
            <span className={current ? "font-medium text-gray-900" : done ? "text-gray-700" : "text-gray-400"}>{entry.label}</span>
          </>
        );
        return (
          <li key={entry.step} aria-current={current ? "step" : undefined} data-testid={`custom-provider-step-${entry.step}`} data-state={current ? "current" : done ? "done" : "todo"}>
            {done ? <button type="button" className="flex items-center gap-2 text-[12px] hover:text-gray-900" onClick={() => onGo(entry.step)}>{content}</button>
              : <span className="flex items-center gap-2 text-[12px]">{content}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function FieldError({ show, message, testId }: { show: boolean; message: string | null; testId: string }) {
  return show && message ? <p className="mt-1.5 text-[12px] text-red-700" role="alert" data-testid={testId}>{message}</p> : null;
}

function Wizard({ store, embedded }: { store: WizardStore; embedded: boolean }) {
  const Heading = embedded ? "h2" : "h1";
  const router = useRouter();
  const { orgId, orgSlug, orgContext, runReauthableAction } = useOrgDashboard();
  const state = useStore(store);
  const templates = useModelTemplates(orgId);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const displayName = state.name.trim() || "custom provider";
  const fieldHighlight = (field: ConnectionField) => state.highlight?.kind === "field" && state.highlight.field === field;
  const endpoint = chatCompletionsUrl(state.baseUrl);
  const selected = state.models.filter((draft) => draft.selected);
  const testModelKey = wizardTestModelKey(state);
  const testResult = currentTestResult(state);
  const passed = wizardTestPassed(state);
  const testing = state.test.state === "running" && state.test.fingerprint === wizardFingerprint(state);
  const connection = connectionKey(state);
  const discoveryNeeded = needsDiscovery(state);
  const discoveryLoading = state.discovery.state === "loading";

  async function discover() {
    const current: WizardState = store.getState();
    const baseUrl = normalizeGatewayCustomBaseUrl(current.baseUrl);
    if (!baseUrl) return;
    const key = connectionKey(current);
    current.discoveryStarted(key);
    try {
      await runReauthableAction("discover-custom-provider-models", async () => {
        const response = await discoverCustomProviderModels({ baseUrl, apiKey: current.apiKey.trim() });
        store.getState().discoveryFinished(key, response);
      });
    } catch (cause) {
      store.getState().discoveryFailed(key, cause instanceof Error ? cause.message : "Could not fetch models. Try again.");
    }
  }

  // Step 2 fetches once per connection; going back and forth with the same URL and key keeps the result.
  useEffect(() => {
    // A failed fetch for this same connection waits for "Try again" instead of looping.
    const failedHere = state.discovery.state === "error" && state.discovery.connection === connection;
    if (state.step !== 2 || !discoveryNeeded || discoveryLoading || failedHere) return;
    void discover();
  }, [state.step, connection, discoveryNeeded, discoveryLoading, state.discovery]);

  async function runTest() {
    setAddError(null);
    const current = store.getState();
    const check = checkSelectedModels(current.models);
    if (!check.ok) {
      store.setState({ step: 3, highlight: check.key ? { kind: "model", key: check.key, field: check.field } : null, message: check.message, expandedKey: check.key ?? current.expandedKey });
      return;
    }
    const baseUrl = normalizeGatewayCustomBaseUrl(current.baseUrl);
    const key = wizardTestModelKey(current);
    const index = current.models.filter((draft) => draft.selected).findIndex((draft) => draft.key === key);
    const model = check.models[index];
    if (!baseUrl || !model) return;
    const fingerprint = wizardFingerprint(current);
    current.testStarted(fingerprint);
    let result = testRequestFailure(model.id, null);
    try {
      await runReauthableAction("test-custom-provider", async () => {
        result = await testCustomProvider({ baseUrl, apiKey: current.apiKey.trim(), model });
      });
    } catch (cause) {
      result = testRequestFailure(model.id, cause);
    }
    store.getState().testFinished(fingerprint, result);
  }

  async function add() {
    const current = store.getState();
    if (!wizardTestPassed(current)) return setAddError(`Test ${displayName} before adding it.`);
    const check = checkSelectedModels(current.models);
    const baseUrl = normalizeGatewayCustomBaseUrl(current.baseUrl);
    if (!check.ok || !baseUrl) return setAddError(check.ok ? "Check the API URL." : check.message);
    setAdding(true);
    setAddError(null);
    try {
      await runReauthableAction("create-custom-provider", async () => {
        await createCustomProvider({
          name: current.name.trim(),
          baseUrl,
          apiKey: current.apiKey.trim(),
          models: check.models,
          ...(current.discovery.state === "done" ? { discoveryStatus: current.discovery.response.status, listedModelIds: current.listedModelIds } : {}),
          allMembers: current.access.orgWide,
          memberIds: current.access.orgWide ? [] : [...new Set(current.access.memberIds)],
          teamIds: current.access.orgWide ? [] : [...new Set(current.access.teamIds)],
        }, createAuditOperationContext());
        router.push(getAiGatewayProvidersRoute(orgSlug));
        router.refresh();
      });
    } catch (cause) {
      setAddError(cause instanceof Error ? cause.message : "Could not add the provider.");
    } finally { setAdding(false); }
  }

  const modelHighlight = state.highlight?.kind === "model" ? { key: state.highlight.key, field: state.highlight.field, message: state.message } : null;
  const listMessage = state.step === 3 && state.message && state.highlight === null ? state.message : null;
  const testedModelName = testResult ? (selected.find((draft) => draft.settings.id.trim() === testResult.model)?.settings.name.trim() || testResult.model) : null;

  return (
    <div className={embedded ? "pb-28" : "mx-auto max-w-[860px] px-6 py-6 pb-28"} data-testid="custom-provider-wizard" data-step={state.step}>
      <nav className="text-[12px] text-gray-500" aria-label="Breadcrumb">
        <Link href={getAiGatewayProvidersRoute(orgSlug)} className="hover:text-gray-900">AI Providers</Link>
        <span className="mx-1.5 text-gray-300">/</span><Link href={getNewAiGatewayProviderRoute(orgSlug)} className="hover:text-gray-900">Add a provider</Link>
        <span className="mx-1.5 text-gray-300">/</span><span className="text-gray-900">Another provider</span>
      </nav>
      <Heading className="mt-3 text-[20px] font-medium tracking-[-0.02em] text-gray-900" data-testid="gateway-provider-title">Add {state.name.trim() || "a provider"}</Heading>
      <StepIndicator step={state.step} onGo={state.goTo} />

      {state.step === 1 ? (
        <section className={`${CARD} mt-5`} aria-labelledby="custom-connection-heading" data-testid="custom-provider-connection">
          <h2 id="custom-connection-heading" className={CARD_TITLE}>Connection</h2>
          <label className={LABEL}>Name
            <DenInput className={`mt-1.5 ${fieldHighlight("name") ? INVALID : ""}`} value={state.name} onChange={(event) => state.setName(event.target.value)} placeholder="Acme AI" autoComplete="off"
              aria-invalid={fieldHighlight("name")} data-testid="custom-provider-name" />
          </label>
          <FieldError show={fieldHighlight("name")} message={state.message} testId="custom-provider-name-error" />
          <label className={LABEL}>API URL
            <DenInput className={`mt-1.5 font-mono text-[12px] ${fieldHighlight("baseUrl") ? INVALID : ""}`} value={state.baseUrl} onChange={(event) => state.setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" autoComplete="off" inputMode="url"
              aria-invalid={fieldHighlight("baseUrl")} aria-describedby="custom-endpoint" data-testid="custom-provider-base-url" />
          </label>
          <FieldError show={fieldHighlight("baseUrl")} message={state.message} testId="custom-provider-base-url-error" />
          <p id="custom-endpoint" className="mt-1.5 text-[12px] text-gray-500" data-testid="custom-provider-endpoint">
            {endpoint ? <>Requests go to <span className="break-all font-mono text-gray-700">{endpoint}</span>. </> : null}Public HTTPS addresses only; private networks such as localhost or 10.x need your OpenWork operator&apos;s approval.
          </p>
          <label className={LABEL}>API key
            <DenSecretInput className={`mt-1.5 font-mono text-[12px] ${fieldHighlight("apiKey") ? INVALID : ""}`} value={state.apiKey} onChange={state.setApiKey} placeholder="Paste the key" autoComplete="new-password"
              aria-invalid={fieldHighlight("apiKey")} data-testid="custom-provider-api-key" />
          </label>
          <FieldError show={fieldHighlight("apiKey")} message={state.message} testId="custom-provider-api-key-error" />
        </section>
      ) : null}

      {state.step === 2 ? (
        <section className={`${CARD} mt-5`} aria-labelledby="custom-fetch-heading" aria-busy={discoveryLoading || discoveryNeeded} data-testid="custom-provider-discovery">
          <h2 id="custom-fetch-heading" className={CARD_TITLE}>Fetch models</h2>
          {state.discovery.state === "error" && state.discovery.connection === connection ? (
            <div data-testid="custom-provider-discovery-error">
              <DenNotice className="mt-3" tone="error" presentation="inline" message={state.discovery.message}
                action={<span className="flex gap-2"><DenButton size="sm" variant="secondary" onClick={() => state.goTo(1)}>Change connection</DenButton><DenButton size="sm" variant="secondary" data-testid="custom-provider-discovery-retry" onClick={() => void discover()}>Try again</DenButton></span>} />
            </div>
          ) : state.discovery.state === "done" && !discoveryNeeded ? (
            <div data-testid="custom-provider-discovery-result" data-status={state.discovery.response.status}>
              <DenNotice className="mt-3" presentation="inline" tone={state.discovery.response.status === "unavailable" ? "neutral" : "success"} message={discoveryMessage(displayName, state.discovery.response)} />
            </div>
          ) : (
            <p className="mt-3 flex items-center gap-2 text-[13px] text-gray-600" role="status" data-testid="custom-provider-discovery-loading">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" strokeWidth={1.5} />Fetching models from {displayName}…
            </p>
          )}
        </section>
      ) : null}

      {state.step === 3 ? (
        <section className={`${CARD} mt-5`} aria-labelledby="custom-models-heading" data-testid="custom-provider-models">
          <h2 id="custom-models-heading" className={CARD_TITLE}>Models</h2>
          {listMessage ? <DenNotice className="mt-3" tone="error" presentation="inline" message={listMessage} /> : null}
          <CustomProviderModelList drafts={state.models} expandedKey={state.expandedKey} highlight={modelHighlight} templates={templates}
            onToggle={state.toggleModel} onSetAll={state.setAllSelected} onUpdate={state.updateModel} onApplyTemplate={state.applyTemplate} onSetUpManually={state.setUpManually}
            onAddTemplate={state.addFromTemplate} onAddCustom={state.addCustomModel} onRemove={state.removeModel} onExpand={state.setExpanded} />
        </section>
      ) : null}

      {state.step === 4 ? (
        <>
          <section className={`${CARD} mt-5`} aria-labelledby="custom-test-heading" data-testid="custom-provider-test-step">
            <h2 id="custom-test-heading" className={CARD_TITLE}>Test</h2>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <div className="w-[300px] max-w-full">
                <DenSelect aria-label="Model to test" value={testModelKey ?? ""} onChange={(event) => state.setTestModel(event.target.value)} data-testid="custom-provider-test-model">
                  {selected.map((draft) => <option key={draft.key} value={draft.key}>{draft.settings.name.trim() || draft.settings.id}</option>)}
                </DenSelect>
              </div>
              <DenButton variant={passed ? "secondary" : "primary"} loading={testing} disabled={adding || !testModelKey} data-testid="custom-provider-test" onClick={() => void runTest()}>{`Test ${displayName}`}</DenButton>
            </div>
            {testResult ? (
              <div data-testid="custom-provider-test-result" data-ok={testResult.ok}>
                <DenNotice className="mt-3" presentation="inline" tone={testResult.ok ? "success" : "error"}
                  message={testResult.ok ? `${displayName} answered a test prompt from ${testedModelName}. You can add it now.` : testResult.message} />
              </div>
            ) : null}
          </section>
          <section className="mt-5" aria-labelledby="custom-access-heading">
            <h2 id="custom-access-heading" className={`${CARD_TITLE} mb-2`}>Who can use it</h2>
            <WhoCanUseIt value={state.access} onChange={state.setAccess} members={orgContext?.members ?? []} teams={orgContext?.teams ?? []} owner={null} canShareWithEveryone disabled={adding}
              everyoneOffDescription="Off. Only the people and teams below can use these models." />
          </section>
          {addError ? <DenNotice tone="error" message={addError} className="mt-3" /> : null}
        </>
      ) : null}

      <DenStickyActionBar testId="custom-provider-actions" summary={<span>{state.step >= 3 ? `${selected.length} ${selected.length === 1 ? "model" : "models"}` : WIZARD_STEPS[state.step - 1]?.label}{state.step === 4 ? ` · ${state.access.orgWide ? "everyone" : `${state.access.teamIds.length + state.access.memberIds.length} teams or people`}` : ""}</span>}>
        {state.step === 1 ? <Link href={getNewAiGatewayProviderRoute(orgSlug)} className={buttonVariants({ variant: "secondary" })}>Cancel</Link>
          : <DenButton variant="secondary" disabled={adding} data-testid="custom-provider-back" onClick={state.back}>Back</DenButton>}
        {state.step < 4 ? (
          <DenButton data-testid="custom-provider-next" disabled={state.step === 2 && (state.discovery.state !== "done" || discoveryNeeded)} onClick={() => { state.next(); }}>
            {state.step === 1 ? "Fetch models" : state.step === 2 ? "Choose models" : "Continue to test"}
          </DenButton>
        ) : (
          <DenButton data-testid="custom-provider-add" loading={adding} disabled={!passed || testing} onClick={() => void add()}>{`Add ${displayName}`}</DenButton>
        )}
      </DenStickyActionBar>
    </div>
  );
}
