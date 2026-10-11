"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { orgFeatureEnabled, getAddConnectorRoute, getMcpConnectionRoute, getMcpConnectionsRoute, getOrgAccessFlags } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { type AccessDraft, accessPeopleIds, peopleLabel } from "./access-summary";
import { useConnectorSetup } from "./connector-setup";
import { ApiKeyFields, ApiKeySchemeAdvanced, OAuthAppFields } from "./connector-setup-fields";
import { useConnectorTarget } from "./connector-setup-screen";
import { useDenToast } from "./den-toast";
import { ItemHeader, ItemPage, SectionTitle, StepFooter } from "./item-header";
import { ConfirmDialog } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { useSaveConnectionAccess } from "./item-sharing";
import { DEFAULT_API_KEY_AUTH_SCHEME, type ExternalMcpApiKeyAuthScheme, type ExternalMcpCredentialMode, useUpdateMcpConnection, useCheckMcpConnection } from "./mcp-connections-data";
import { usesMemberApiKey } from "./member-api-key";
import { SetupChecks } from "./setup-checks";
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

/** C3 and C4: the checks fill in, then the admin picks how people sign in and who gets it. */
export function AdminConnectorSetupScreen({ catalogId }: { catalogId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
  const canShareWithEveryone = orgContext
    ? getOrgAccessFlags(orgContext.currentMember.role, orgContext.currentMember.isOwner, orgContext.currentMember.permissions).canShareWithEveryone
    : false;
  const { target, loading, missing, failed } = useConnectorTarget(catalogId);
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
  const setup = useConnectorSetup({
    mode: "admin",
    target,
    initialConnectionId: searchParams.get("connection"),
    onConnectionCreated: (connectionId) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("connection", connectionId);
      router.replace(`?${params.toString()}`, { scroll: false });
    },
  });

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
  const ready = setup.allDone && Boolean(connection);

  const checks = setup.checks.map((check) => {
    if (check.id === "sign-in" && setup.canSignIn) {
      return { ...check, action: <DenButton size="sm" onClick={() => void setup.startSignIn()}>{`Sign in with ${name}`}</DenButton> };
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
          : <OAuthAppFields secretRequired={setup.secretRequired} saving={setup.saving} error={setup.saveError} onSave={(input) => void setup.saveOAuthApp(input)} />,
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
      const checked = orgContext && orgFeatureEnabled(orgContext, "connectorReadiness")
        ? await checkConnection.mutateAsync(connection.id) : null;
      const connectionId = connection.id;
      toast({
        title: checked?.status === "could_not_verify" ? `${name} couldn't be verified` : `${name} is ready`,
        description: `${reached > 0 ? `${peopleLabel(reached)} will find it in My Library.` : "Only you have it so far."}`,
        action: { label: "View", onClick: () => router.push(getMcpConnectionRoute(orgSlug, connectionId)) },
      });
      router.push(getMcpConnectionsRoute(orgSlug));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
    return (
      <ItemPage testId="connector-setup">
        <ItemHeader
          back={back}
          logo={<ConnectorLogo name={name} url={target.url} size="md" />}
          title={`Add ${name}`}
        />
        <SetupChecks checks={checks} />
        <StepFooter note={`Step ${setup.stepNumber} of ${checks.length}`}>
          <DenButton variant="secondary" loading={busy} onClick={() => void cancel()}>Cancel</DenButton>
        </StepFooter>
      </ItemPage>
    );
  }

  return (
    <ItemPage testId="connector-setup">
      <ItemHeader
        back={back}
        logo={<ConnectorLogo name={name} url={target.url} size="md" />}
        title={usesIndividualKeys ? `${name} is ready` : `${name} passed all ${checks.length} checks`}
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
