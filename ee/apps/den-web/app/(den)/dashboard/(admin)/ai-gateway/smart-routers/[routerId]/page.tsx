import { AutoRouterScreen } from "../../../../_components/auto-router-screen";
import { SmartRouterFeatureGate } from "../../../../_components/auto-router-feature-gate";

/** A Smart Router's page; `?step=access` is step two of adding one: who it applies to. */
export default async function AiGatewaySmartRouterPage({
  params,
  searchParams,
}: {
  params: Promise<{ routerId: string }>;
  searchParams: Promise<{ step?: string }>;
}) {
  const [{ routerId }, { step }] = await Promise.all([params, searchParams]);
  return (
    <SmartRouterFeatureGate>
      <AutoRouterScreen key={routerId} routerId={routerId} step={step === "access" ? "access" : undefined} />
    </SmartRouterFeatureGate>
  );
}
