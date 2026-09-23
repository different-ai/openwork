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
import { customConnectorQuery } from "./connector-catalog-screen";
import { shortDescription } from "./connector-picker";
import { type ConnectorTarget, useConnectorSetup } from "./connector-setup";
import { ItemHeader, ItemPage, StepFooter } from "./item-header";
import { LinkButton } from "./item-list";
import { ConnectorLogo } from "./item-logo";
import { useMcpConnectionPresets } from "./mcp-connections-data";
import { type SetupCheck, SetupChecks } from "./setup-checks";

export function useConnectorTarget(catalogId: string): { target: ConnectorTarget | null; loading: boolean; missing: boolean; failed: boolean } {
  const searchParams = useSearchParams();
  const presets = useMcpConnectionPresets();
  const customUrl = searchParams.get("url");
  const customName = searchParams.get("name");
  return useMemo(() => {
    if (catalogId === "custom") {
      if (!customUrl) return { target: null, loading: false, missing: true, failed: false };
      return { target: { name: customName?.trim() || "MCP server", url: customUrl, description: "" }, loading: false, missing: false, failed: false };
    }
    const preset = presets.data?.find((entry) => entry.presetId === catalogId);
    if (!preset && presets.error) return { target: null, loading: false, missing: false, failed: true };
    if (!preset) return { target: null, loading: presets.isLoading, missing: !presets.isLoading, failed: false };
    return {
      target: { name: preset.displayName, url: preset.url, description: shortDescription(preset.description) },
      loading: false,
      missing: false,
      failed: false,
    };
  }, [catalogId, customName, customUrl, presets.data, presets.error, presets.isLoading]);
}

/** Back to the address form with what the person typed, for an address that did not answer. */
export function changeAddressHref(catalogRoute: string, catalogId: string, target: ConnectorTarget): string | null {
  return catalogId === "custom" ? `${catalogRoute}${customConnectorQuery(target)}` : null;
}

/** Puts each check's next step on its row: sign in, change the address, or finish setup in Advanced setup. */
export function withCheckActions(
  setup: Pick<ReturnType<typeof useConnectorSetup>, "checks" | "canSignIn" | "startSignIn">,
  { name, changeAddress, advancedSetup }: { name: string; changeAddress: string | null; advancedSetup?: string },
): SetupCheck[] {
  return setup.checks.map((check) => {
    if (check.id === "sign-in" && setup.canSignIn) {
      return { ...check, action: <DenButton size="sm" onClick={() => void setup.startSignIn()}>{`Sign in with ${name}`}</DenButton> };
    }
    if (check.status !== "failed") return check;
    if (check.id === "find" && changeAddress) {
      return { ...check, action: <LinkButton size="sm" href={changeAddress}>Change address</LinkButton> };
    }
    if (check.id === "sign-in-method" && advancedSetup) {
      return { ...check, action: <LinkButton size="sm" href={advancedSetup}>Advanced setup</LinkButton> };
    }
    return check;
  });
}

/** A4 and A5: the checks fill in, the member signs in, and the connector is theirs. */
export function MemberConnectorSetupScreen({ catalogId }: { catalogId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { orgSlug } = useOrgDashboard();
  const { target, loading, missing, failed } = useConnectorTarget(catalogId);
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
  if (!target) {
    return <ItemPage><ItemHeader back={back} title={loading ? "Loading..." : "Add a connector"} /></ItemPage>;
  }

  const checks = withCheckActions(setup, {
    name,
    changeAddress: changeAddressHref(getLibraryAddConnectorRoute(orgSlug), catalogId, target),
  });

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
