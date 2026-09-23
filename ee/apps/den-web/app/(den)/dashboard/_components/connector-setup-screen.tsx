"use client";

import { UserPlus } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import {
  getLibraryAddConnectorRoute,
  getLibraryConnectorShareRoute,
  getLibraryRoute,
} from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { shortDescription } from "./connector-picker";
import { type ConnectorTarget, useConnectorSetup } from "./connector-setup";
import { ItemHeader, ItemPage, StepFooter } from "./item-header";
import { LinkButton } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { useMcpConnectionPresets } from "./mcp-connections-data";
import { SetupChecks } from "./setup-checks";

export function useConnectorTarget(catalogId: string): { target: ConnectorTarget | null; loading: boolean; missing: boolean } {
  const searchParams = useSearchParams();
  const presets = useMcpConnectionPresets();
  const customUrl = searchParams.get("url");
  const customName = searchParams.get("name");
  return useMemo(() => {
    if (catalogId === "custom") {
      if (!customUrl) return { target: null, loading: false, missing: true };
      return { target: { name: customName?.trim() || "MCP server", url: customUrl, description: "" }, loading: false, missing: false };
    }
    const preset = presets.data?.find((entry) => entry.presetId === catalogId);
    if (!preset) return { target: null, loading: presets.isLoading, missing: !presets.isLoading };
    return {
      target: { name: preset.displayName, url: preset.url, description: shortDescription(preset.description) },
      loading: false,
      missing: false,
    };
  }, [catalogId, customName, customUrl, presets.data, presets.isLoading]);
}

/** A4 and A5: the checks fill in, the member signs in, and the connector is theirs. */
export function MemberConnectorSetupScreen({ catalogId }: { catalogId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { orgSlug } = useOrgDashboard();
  const { target, loading, missing } = useConnectorTarget(catalogId);
  const [leaving, setLeaving] = useState(false);
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
  const back = { href: getLibraryAddConnectorRoute(orgSlug), label: "Add a connector" };

  if (missing) {
    return (
      <ItemPage>
        <ItemHeader back={back} title="Connector not found" description="Pick it again from the list." />
      </ItemPage>
    );
  }
  if (!target) {
    return <ItemPage><ItemHeader back={back} title={loading ? "Loading..." : "Add a connector"} /></ItemPage>;
  }

  const checks = setup.checks.map((check) => check.id === "sign-in" && setup.canSignIn
    ? { ...check, action: <DenButton size="sm" onClick={() => void setup.startSignIn()}>{`Sign in with ${name}`}</DenButton> }
    : check);

  async function cancel() {
    setLeaving(true);
    await setup.discard();
    router.push(getLibraryRoute(orgSlug));
  }

  return (
    <ItemPage testId="connector-setup">
      <ItemHeader
        back={back}
        logo={<ConnectorLogo name={name} url={target.url} size="md" />}
        title={setup.allDone ? `${name} is ready` : `Connect ${name}`}
        description={setup.allDone
          ? "Only you can use it. Share it when your team needs it too."
          : `OpenWork checks ${name}, then you sign in. Only you can use it.`}
      />
      <SetupChecks checks={checks} />
      {setup.allDone && setup.connectionId ? (
        <StepFooter note={`All ${checks.length} steps done`}>
          <LinkButton href={getLibraryConnectorShareRoute(orgSlug, setup.connectionId)}>
            <UserPlus className="h-4 w-4" aria-hidden />
            Share
          </LinkButton>
          <LinkButton variant="primary" href={getLibraryRoute(orgSlug)}>Done</LinkButton>
        </StepFooter>
      ) : (
        <StepFooter note={`Step ${setup.stepNumber} of ${checks.length}`}>
          <DenButton variant="secondary" loading={leaving} onClick={() => void cancel()}>Cancel</DenButton>
        </StepFooter>
      )}
    </ItemPage>
  );
}
