import { AutoRouterScreen } from "../../../../_components/auto-router-screen";
import { GatewayDashboardCapabilityGuard } from "../../../../_components/gateway-dashboard-capability-guard";

/** Step one of adding a Smart Router: its name, models and tasks. */
export default function NewAiGatewaySmartRouterPage() {
  return (
    <GatewayDashboardCapabilityGuard area="manage-providers">
      <AutoRouterScreen />
    </GatewayDashboardCapabilityGuard>
  );
}
