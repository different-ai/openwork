import { CustomProviderWizardScreen } from "../../../../../_components/custom-provider-wizard-screen";
import { GatewayDashboardCapabilityGuard } from "../../../../../_components/gateway-dashboard-capability-guard";

export default function NewAiGatewayCustomProviderPage() {
  return (
    <GatewayDashboardCapabilityGuard area="manage-providers">
      <CustomProviderWizardScreen embedded />
    </GatewayDashboardCapabilityGuard>
  );
}
