"use client";

import { Lock } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenSwitch } from "../../_components/ui/switch";
import { getAddConnectorRoute, getMcpConnectionRoute, getMcpConnectionsRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { type AccessDraft, accessPeopleIds, peopleLabel } from "./access-summary";
import type { ConnectorRoute } from "./connector-route";
import { ConnectorRouteStep } from "./connector-route-step";
import { ConnectorConnectionProgress } from "./connector-connection-progress";
import { connectorAccountReady } from "./connector-detail";
import { useConnectorSetup } from "./connector-setup";
import { ApiKeyFields, ApiKeySchemeAdvanced, OAuthAppFields, createOAuthAppDraft } from "./connector-setup-fields";
import { useConnectorTarget } from "./connector-setup-screen";
import { useDenToast } from "./den-toast";
import { ItemHeader, ItemPage, SectionTitle, StepFooter } from "./item-header";
import { ConfirmDialog } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { useSaveConnectionAccess } from "./item-sharing";
import { DEFAULT_API_KEY_AUTH_SCHEME, type ExternalMcpApiKeyAuthScheme, type ExternalMcpCredentialMode, useUpdateMcpConnection, useCheckMcpConnection, useMcpConnectionPresets } from "./mcp-connections-data";
import { usesMemberApiKey } from "./member-api-key";
import { SetupChecks } from "./setup-checks";
import { SLACK_ASSISTANT_SECTION_ID } from "./slack-assistant-setup";
import { SlackSetupChecklist, useSlackSetupState } from "./slack-connector-setup-checks";
import { type SlackScopeChoice, withSlackScopeChoice } from "./slack-connector-setup";
import { WhoCanUseIt } from "./who-can-use-it";

function SignInChoice({ name, value, onChange, disabled, kind = "oauth", sharedDescription }: {
  name: string;
  value: ExternalMcpCredentialMode;
  onChange: (value: ExternalMcpCredentialMode) => void;
  disabled: boolean;
  kind?: "oauth" | "api_key";
  sharedDescription?: string;
}) {
  const options: { value: ExternalMcpCredentialMode; title: string; description: string }[] = [
    kind === "api_key"
      ? { value: "per_member", title: "Each person adds a key", description: `One ${name} connection; each person adds their own key.` }
      : { value: "per_member", title: "Each person signs in", description: `Everyone uses their own ${name} account.` },
    kind === "api_key"
      ? { value: "shared", title: "One key for everyone", description: sharedDescription ?? `Everyone uses one ${name} API key.` }
      : { value: "shared", title: "One account for everyone", description: sharedDescription ?? `Everyone uses one ${name} account you sign in with.` },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="How people connect">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <label
            key={option.value}
            className={`flex cursor-pointer items-start gap-3 rounded-2xl border bg-white px-4 py-3.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gray-200 ${selected ? "border-gray-400" : "border-gray-100 hover:border-gray-200"}`}
          >
            <input
              type="radio"
              name="sign-in-mode"
              value={option.value}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-gray-900"
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-[14px] font-medium leading-5 text-gray-900">{option.title}</span>
              <span className="text-[13px] leading-[18px] text-gray-500">{option.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Draft credentials belong to one server and organization, never the next connector visited. */
export function AdminConnectorSetupScreen({ catalogId }: { catalogId: string }) {
  const { orgId } = useOrgDashboard();
  const params = useSearchParams();
  return <AdminConnectorSetupFlow key={`${orgId ?? ""}:${catalogId}:${params.get("url") ?? ""}`} catalogId={catalogId} />;
}

/** C3 and C4: the admin connects the server, then chooses account mode and access. */
function AdminConnectorSetupFlow({ catalogId }: { catalogId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
  const canShareWithEveryone = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canShareWithEveryone
    : false;
  const { target: catalogTarget, loading, missing, failed } = useConnectorTarget(catalogId);
  // Guided Slack setup: the admin's explicit access choice becomes the new connection's scopes.
  const [slackScopeChoice, setSlackScopeChoice] = useState<SlackScopeChoice | null>(null);
  const target = useMemo(() => withSlackScopeChoice(catalogTarget, slackScopeChoice), [catalogTarget, slackScopeChoice]);
  const updateConnection = useUpdateMcpConnection();
  const checkConnection = useCheckMcpConnection();
  const saveAccess = useSaveConnectionAccess();
  const viewerId = orgContext?.currentMember.id ?? null;
  const [mode, setMode] = useState<ExternalMcpCredentialMode | null>(null);
  const [apiKeyAuthScheme, setApiKeyAuthScheme] = useState<ExternalMcpApiKeyAuthScheme>(DEFAULT_API_KEY_AUTH_SCHEME);
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [showOAuthApp, setShowOAuthApp] = useState(false);
  // A custom connector first shows what OpenWork detected and lets the admin pick another route.
  const isCustom = catalogId === "custom";
  const presets = useMcpConnectionPresets();
  const callbackUrl = presets.data?.find((preset) => preset.oauthCallbackUrl)?.oauthCallbackUrl ?? undefined;
  const [oauthDraft, setOAuthDraft] = useState(createOAuthAppDraft);
  const initialConnectionId = searchParams.get("connection");
  const [route, setRoute] = useState<ConnectorRoute | null>(null);
  const [previousRoute, setPreviousRoute] = useState<ConnectorRoute | null>(null);
  const setup = useConnectorSetup({
    mode: "admin",
    target,
    route,
    routeRequired: isCustom && !initialConnectionId,
    liveDiscovery: isCustom,
    initialConnectionId,
    onConnectionCreated: (connectionId) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("connection", connectionId);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
  });

  const slackSetup = useSlackSetupState(setup, target, slackScopeChoice);
  const [assistantNext, setAssistantNext] = useState(false);

  const name = target?.name ?? "";
  const back = { href: getAddConnectorRoute(orgSlug), label: "Add a connector" };

  if (missing || failed) {
    return (
      <ItemPage>
        <ItemHeader
          back={back}
          title={failed ? "The list did not load" : "Connector not found"}
          description={failed ? "Reload the page to try again." : "Pick it again from the list."}
        />
      </ItemPage>
    );
  }
  if (!target || !orgContext) {
    return <ItemPage><ItemHeader back={back} title={loading || !orgContext ? "Loading..." : "Add a connector"} /></ItemPage>;
  }

  const connection = setup.connection;
  const signsIn = connection ? connection.authType === "oauth" : true;
  const usesKey = connection?.authType === "apikey";
  const usesIndividualKeys = Boolean(connection && usesMemberApiKey(connection));
  const chosenMode: ExternalMcpCredentialMode = mode ?? connection?.credentialMode ?? (setup.method === "api_key" ? "shared" : "per_member");
  const access: AccessDraft = draft ?? (connection?.access
    ? { orgWide: connection.access.orgWide, memberIds: connection.access.memberIds, teamIds: connection.access.teamIds }
    : { orgWide: false, memberIds: viewerId ? [viewerId] : [], teamIds: [] });
  const reached = accessPeopleIds(access, orgContext, viewerId).length;
  const me = orgContext.members.find((member) => member.id === viewerId);
  const viewerName = me?.user.name || me?.user.email || "You";
  const switchingToShared = signsIn && chosenMode === "shared" && connection?.credentialMode === "per_member";
  const ready = (setup.allDone || setup.skipped) && Boolean(connection);
  const stepNumber = slackSetup.slack ? slackSetup.progress.step : setup.stepNumber;
  const stepTotal = slackSetup.slack ? slackSetup.progress.total : setup.checks.length;
  // @openwork in Slack needs each person's own Slack sign-in and this OpenWork's assistant runner.
  const assistantOffered = slackSetup.slack && slackSetup.assistant?.eligible === true && !slackSetup.assistant.installed;
  const assistantAvailable = assistantOffered && slackSetup.assistant?.runnerAvailable === true && chosenMode === "per_member";
  const assistantLock = !assistantOffered ? null
    : slackSetup.assistant?.runnerAvailable !== true ? "Not available on this OpenWork. Whoever runs it can turn on the Slack assistant."
    : chosenMode !== "per_member" ? "Needs Each person signs in." : null;

  const checks = setup.checks.map((check) => {
    if (check.id === "sign-in" && (setup.canSignIn || setup.signInFailed)) {
      return {
        ...check,
        ...(setup.canSignIn ? { action: <DenButton size="sm" onClick={() => void setup.startSignIn()}>{`Sign in with ${name}`}</DenButton> } : {}),
        ...(setup.signInFailed ? {
          body: showOAuthApp ? (
            <div className="flex flex-col gap-2" data-testid="connector-setup-own-oauth-app">
              <p className="text-[13px] leading-[18px] text-gray-500">{`Add the client ID and secret from your ${name} OAuth app, then sign in again.`}</p>
              <OAuthAppFields url={target.url} discovery={setup.discovery} secretRequired={setup.secretRequired} saving={setup.saving} error={setup.saveError} onSave={(input) => void setup.saveOAuthApp(input)} />
            </div>
          ) : (
            <DenButton size="sm" variant="secondary" onClick={() => setShowOAuthApp(true)}>Use your own OAuth app</DenButton>
          ),
        } : {}),
      };
    }
    if (check.id === "sign-in-method" && setup.needsInput) {
      return {
        ...check,
        body: setup.method === "api_key"
          ? (
            <div className="flex flex-col gap-3">
              <SignInChoice name={name} value={chosenMode} onChange={setMode} disabled={setup.saving} kind="api_key" />
              <ApiKeySchemeAdvanced value={apiKeyAuthScheme} onChange={setApiKeyAuthScheme} disabled={setup.saving} testId="connector-setup-api-key-auth-scheme" />
              {chosenMode === "shared" ? (
                <ApiKeyFields name={name} saving={setup.saving} error={setup.saveError} onSave={(apiKey) => void setup.saveApiKey(apiKey, apiKeyAuthScheme)} />
              ) : (
                <div className="flex flex-col items-start gap-2">
                  <DenButton size="sm" loading={setup.saving} onClick={() => void setup.savePerMemberApiKeys(apiKeyAuthScheme)}>Use individual keys</DenButton>
                  {setup.saveError ? <p className="text-[12px] text-red-600" role="alert">{setup.saveError}</p> : null}
                </div>
              )}
            </div>
          )
          : <OAuthAppFields url={target.url} discovery={setup.discovery} secretRequired={setup.secretRequired} saving={setup.saving} error={setup.saveError} onSave={(input) => void setup.saveOAuthApp(input)} />,
      };
    }
    return check;
  });

  async function cancel() {
    setBusy(true);
    await setup.discard();
    router.push(getMcpConnectionsRoute(orgSlug));
  }

  async function switchToShared() {
    if (!connection) return;
    await updateConnection.mutateAsync({
      connectionId: connection.id,
      expectedUpdatedAt: connection.updatedAt ?? new Date().toISOString(),
      name: connection.name,
      url: connection.url,
      authType: connection.authType,
      credentialMode: "shared",
      exposeDirectly: connection.exposeDirectly,
      access,
    });
  }

  async function add() {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      await saveAccess(connection.id, access);
      // Individual-key setup publishes the connection; each person's key is
      // checked when they enroll it, not against an admin's nonexistent key.
      // Added anyway: a failing check is expected, so it never blocks the add.
      const checked = usesIndividualKeys
        ? null
        : setup.skipped
        ? await checkConnection.mutateAsync(connection.id).catch(() => null)
        : await checkConnection.mutateAsync(connection.id);
      const connectionId = connection.id;
      const openAssistant = assistantNext && assistantAvailable;
      const unverified = checked?.status === "could_not_verify" || (setup.skipped && checked?.status !== "ready");
      toast({
        title: usesIndividualKeys ? `${name} is set up` : unverified ? `${name} couldn't be verified` : `${name} is ready`,
        description: `${reached > 0 ? `${peopleLabel(reached)} will find it in My Library.` : "Only you have it so far."}`,
        action: { label: "View", onClick: () => router.push(getMcpConnectionRoute(orgSlug, connectionId)) },
      });
      router.push(openAssistant
        ? `${getMcpConnectionRoute(orgSlug, connectionId)}#${SLACK_ASSISTANT_SECTION_ID}`
        : getMcpConnectionsRoute(orgSlug));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  if (isCustom && route === null && !setup.connectionId && !initialConnectionId) {
    return (
      <ConnectorRouteStep
        name={name}
        url={target.url}
        back={back}
        initial={previousRoute}
        discovery={setup.discovery}
        discovering={setup.discovering}
        unreachable={setup.unreachable}
        secretRequired={setup.secretRequired}
        callbackUrl={callbackUrl}
        oauthDraft={oauthDraft}
        onOAuthDraftChange={setOAuthDraft}
        liveChecks={{ checks: setup.discoveryChecks, failed: setup.discoveryFailed, onRetry: setup.retryDiscovery }}
        onCancel={() => router.push(getAddConnectorRoute(orgSlug))}
        onContinue={(chosen, oauthApp) => {
          setRoute(chosen);
          if (chosen.auth === "oauth") void setup.startSignIn({ route: chosen, oauthApp });
        }}
      />
    );
  }

  async function editSetup() {
    if (!(await setup.restartSetup())) return;
    setPreviousRoute(route);
    setRoute(null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("connection");
    router.replace(`?${params.toString()}`, { scroll: false });
  }

  if (isCustom && (route || initialConnectionId) && !ready) {
    const needsKey = setup.method === "api_key" && setup.needsInput;
    const keyFields = needsKey ? checks.find((check) => check.id === "sign-in-method")?.body : undefined;
    const toolFailure = setup.checks.find((check) => check.id === "tools" && check.status === "failed")?.description ?? null;
    return <ConnectorConnectionProgress
      name={name} url={target.url} back={back}
      waitingForSignIn={setup.signingIn}
      problem={setup.connectionProblem ?? toolFailure}
      keyFields={keyFields}
      busy={busy || setup.saving}
      onRetry={(setup.connectionProblem || toolFailure) && connection && connectorAccountReady(connection) ? () => void setup.retryTools() : setup.canSignIn ? () => void setup.startSignIn() : undefined}
      onEdit={setup.canEditSetup ? () => void editSetup() : undefined}
      onCancel={() => void cancel()}
    />;
  }

  if (!ready) {
    return (
      <ItemPage testId="connector-setup">
        <ItemHeader
          back={back}
          logo={<ConnectorLogo name={name} url={target.url} size="md" />}
          title={`Add ${name}`}
        />
        {slackSetup.slack ? (
          <SlackSetupChecklist
            steps={slackSetup.steps}
            callbackUrl={slackSetup.callbackUrl}
            scopes={slackSetup.scopes}
            mcpConfirmed={slackSetup.mcpConfirmed}
            onConfirmMcp={slackSetup.setMcpConfirmed}
            oauthAppFields={<OAuthAppFields url={target.url} discovery={setup.discovery} secretRequired={setup.secretRequired} saving={setup.saving} error={setup.saveError} onSave={(input) => void setup.saveOAuthApp(input)} />}
            onSignIn={() => void setup.startSignIn()}
            onCheckAgain={slackSetup.checkAgain}
            checking={slackSetup.checking}
            leading={checks.filter((check) => check.id === "find" && check.status === "failed")}
            scopeChoice={slackScopeChoice}
            onChooseScopes={setSlackScopeChoice}
          />
        ) : <SetupChecks checks={checks} />}
        {setup.skipError ? <p className="text-[13px] text-red-600" role="alert">{setup.skipError}</p> : null}
        <StepFooter note={setup.canSkip ? "You can add it anyway and finish its settings on its page." : `Step ${stepNumber} of ${stepTotal}`}>
          {isCustom && route && !setup.connectionId && !setup.saving ? (
            <DenButton variant="secondary" disabled={busy || setup.skipping || setup.signingIn} onClick={() => { setPreviousRoute(route); setRoute(null); }} data-testid="connector-setup-change-route">Back</DenButton>
          ) : (
            <DenButton variant="secondary" loading={busy} disabled={setup.skipping} onClick={() => void cancel()}>Cancel</DenButton>
          )}
          {setup.canSkip ? (
            <DenButton loading={setup.skipping} disabled={busy} onClick={() => void setup.skipChecks()} data-testid="connector-setup-add-anyway">Add anyway</DenButton>
          ) : null}
        </StepFooter>
      </ItemPage>
    );
  }

  return (
    <ItemPage testId="connector-setup">
      <ItemHeader
        back={back}
        logo={<ConnectorLogo name={name} url={target.url} size="md" />}
        title={isCustom ? name : usesIndividualKeys ? `${name} is set up` : setup.allDone ? `${name} passed all ${stepTotal} checks` : `Add ${name} anyway`}
        actions={isCustom ? <DenBadge>{usesIndividualKeys ? "Set up" : "Connected"}</DenBadge> : undefined}
        description={isCustom || setup.allDone ? undefined : `Some checks did not pass. Finish its settings, like its OAuth app, on its page after you add it.`}
      />
      {signsIn || usesKey ? (
        <section className="flex flex-col gap-2.5">
          <SectionTitle title="How people connect" />
          <SignInChoice
            name={name}
            value={chosenMode}
            onChange={setMode}
            disabled={busy || usesKey}
            kind={usesKey ? "api_key" : "oauth"}
            sharedDescription={usesKey ? `Everyone uses the ${name} API key you added.` : undefined}
          />
        </section>
      ) : null}
      <section className="flex flex-col gap-2.5">
        <SectionTitle title="Who can use it" />
        <WhoCanUseIt
          value={access}
          onChange={setDraft}
          members={orgContext.members}
          teams={orgContext.teams}
          owner={viewerId ? { id: viewerId, name: viewerName, isYou: true } : null}
          canShareWithEveryone={canShareWithEveryone}
          everyoneOffDescription="Off. Only the people and teams below get it."
          disabled={busy}
        />
      </section>
      {assistantOffered ? (
        <div className="flex min-h-12 items-center justify-between gap-4 border-b border-gray-100" data-testid="slack-setup-assistant-next">
          <div className="min-w-0">
            <p className="text-[14px] font-medium leading-5 text-gray-900">Set up @openwork in Slack next</p>
            {assistantLock ? (
              <p className="flex items-center gap-1.5 text-[13px] leading-[18px] text-gray-500">
                <Lock className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
                {assistantLock}
              </p>
            ) : null}
          </div>
          <DenSwitch
            checked={assistantNext && assistantAvailable}
            disabled={busy || !assistantAvailable}
            onChange={setAssistantNext}
            aria-label="Set up @openwork in Slack next"
            testId="slack-setup-assistant-next-switch"
          />
        </div>
      ) : null}
      {error ? <p className="text-[13px] text-red-600" role="alert">{error}</p> : null}
      <StepFooter note={switchingToShared
        ? `Next, sign in with the ${name} account everyone will use.`
        : reached > 0 ? `${peopleLabel(reached)} will find ${name} in My Library.` : `Only you will have ${name}.`}
      >
        <DenButton variant="secondary" disabled={busy} onClick={() => void cancel()}>Cancel</DenButton>
        <DenButton loading={busy} onClick={() => (switchingToShared ? setConfirmSwitch(true) : void add())}>{switchingToShared ? "Continue" : `Add ${name}`}</DenButton>
      </StepFooter>
      <ConfirmDialog
        confirm={confirmSwitch ? {
          title: "Switch to one account for everyone?",
          description: `This signs you out of ${name}. Next, you sign in with the ${name} account everyone will use.`,
          action: "Sign out and continue",
        } : null}
        onConfirm={switchToShared}
        onClose={() => setConfirmSwitch(false)}
      />
    </ItemPage>
  );
}
