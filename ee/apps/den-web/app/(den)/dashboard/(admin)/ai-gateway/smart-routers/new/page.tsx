import { AutoRouterScreen } from "../../../../_components/auto-router-screen";
import { GatewayDashboardCapabilityGuard } from "../../../../_components/gateway-dashboard-capability-guard";
import { SmartRouterFeatureGate } from "../../../../_components/auto-router-feature-gate";

/** Step one of adding a Smart Router: its name, models and tasks. */
export default function NewAiGatewaySmartRouterPage() {
  return (
    <GatewayDashboardCapabilityGuard area="manage-providers">
      <SmartRouterFeatureGate>
        <AutoRouterScreen />
      </SmartRouterFeatureGate>
    </GatewayDashboardCapabilityGuard>
  );
}
