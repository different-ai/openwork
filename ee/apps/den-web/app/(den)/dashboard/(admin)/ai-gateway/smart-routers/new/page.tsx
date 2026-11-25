import { AutoRouterScreen } from "../../../../_components/auto-router-screen";
import { GatewayDashboardCapabilityGuard } from "../../../../_components/gateway-dashboard-capability-guard";

export default function NewAiGatewaySmartRouterPage() {
  return (
    <GatewayDashboardCapabilityGuard area="manage-providers">
      <AutoRouterScreen />
    </GatewayDashboardCapabilityGuard>
  );
}
