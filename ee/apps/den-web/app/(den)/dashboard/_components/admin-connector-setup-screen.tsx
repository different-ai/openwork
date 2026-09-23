"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { getAddConnectorRoute, getAllMcpConnectionsRoute, getMcpConnectionRoute, getMcpConnectionsRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { type AccessDraft, accessPeopleIds, peopleLabel } from "./access-summary";
import { useConnectorSetup } from "./connector-setup";
import { changeAddressHref, useConnectorTarget, withCheckActions } from "./connector-setup-screen";
import { useDenToast } from "./den-toast";
import { ItemHeader, ItemPage, SectionTitle, StepFooter } from "./item-header";
import { ConfirmDialog } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { useSaveConnectionAccess } from "./item-sharing";
import { type ExternalMcpCredentialMode, useUpdateMcpConnection } from "./mcp-connections-data";
import { SetupChecks } from "./setup-checks";
import { WhoCanUseIt } from "./who-can-use-it";

function SignInChoice({ name, value, onChange, disabled }: {
  name: string;
  value: ExternalMcpCredentialMode;
  onChange: (value: ExternalMcpCredentialMode) => void;
  disabled: boolean;
}) {
  const options: { value: ExternalMcpCredentialMode; title: string; description: string }[] = [
    { value: "per_member", title: "Each person signs in", description: `Everyone uses their own ${name} account.` },
    { value: "shared", title: "One account for everyone", description: `Everyone uses one ${name} account you sign in with.` },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="How people sign in">
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

/** C3 and C4: the checks fill in, the admin continues, then picks how people sign in and who gets it. */
export function AdminConnectorSetupScreen({ catalogId }: { catalogId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useDenToast();
  const { orgSlug, orgContext } = useOrgDashboard();
  const { target, loading, missing, failed } = useConnectorTarget(catalogId);
  const updateConnection = useUpdateMcpConnection();
  const saveAccess = useSaveConnectionAccess();
  const viewerId = orgContext?.currentMember.id ?? null;
  const [mode, setMode] = useState<ExternalMcpCredentialMode | null>(null);
  const [draft, setDraft] = useState<AccessDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [continued, setContinued] = useState(false);
  const setup = useConnectorSetup({
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
  const chosenMode: ExternalMcpCredentialMode = mode ?? connection?.credentialMode ?? "per_member";
  const access: AccessDraft = draft ?? (connection?.access
    ? { orgWide: connection.access.orgWide, memberIds: connection.access.memberIds, teamIds: connection.access.teamIds }
    : { orgWide: false, memberIds: viewerId ? [viewerId] : [], teamIds: [] });
  const reached = accessPeopleIds(access, orgContext, viewerId).length;
  const me = orgContext.members.find((member) => member.id === viewerId);
  const viewerName = me?.user.name || me?.user.email || "You";
  const switchingToShared = signsIn && chosenMode === "shared" && connection?.credentialMode === "per_member";
  const ready = setup.allDone && Boolean(connection);

  const checks = withCheckActions(setup, {
    name,
    changeAddress: changeAddressHref(getAddConnectorRoute(orgSlug), catalogId, target),
    advancedSetup: getAllMcpConnectionsRoute(orgSlug),
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
      const connectionId = connection.id;
      toast({
        title: `${name} is ready`,
        description: reached > 0 ? `${peopleLabel(reached)} will find it in My Library.` : "Only you have it so far.",
        action: { label: "View", onClick: () => router.push(getMcpConnectionRoute(orgSlug, connectionId)) },
      });
      router.push(getMcpConnectionsRoute(orgSlug));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }

  if (!ready || !continued) {
    return (
      <ItemPage testId="connector-setup">
        <ItemHeader
          back={back}
          logo={<ConnectorLogo name={name} url={target.url} size="md" />}
          title={ready ? `${name} passed all ${checks.length} checks` : `Add ${name}`}
          description={ready
            ? undefined
            : chosenMode === "shared" && connection?.credentialMode === "shared"
              ? `Sign in with the ${name} account everyone will use.`
              : `OpenWork checks ${name}, then you sign in to try it.`}
        />
        <SetupChecks checks={checks} />
        <StepFooter note={ready ? "Next, choose who can use it." : `Step ${setup.stepNumber} of ${checks.length}`}>
          <DenButton variant="secondary" loading={busy} onClick={() => void cancel()}>Cancel</DenButton>
          {ready ? <DenButton onClick={() => setContinued(true)}>Continue</DenButton> : null}
        </StepFooter>
      </ItemPage>
    );
  }

  return (
    <ItemPage testId="connector-setup">
      <ItemHeader
        back={back}
        logo={<ConnectorLogo name={name} url={target.url} size="md" />}
        title={`Add ${name}`}
      />
      {signsIn ? (
        <section className="flex flex-col gap-2.5">
          <SectionTitle title="How people sign in" />
          <SignInChoice name={name} value={chosenMode} onChange={setMode} disabled={busy} />
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
          canShareWithEveryone
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
