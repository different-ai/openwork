import { AiGatewayScreen } from "../../../_components/ai-gateway-screen";
import { GatewayDashboardCapabilityGuard } from "../../../_components/gateway-dashboard-capability-guard";

export default function AiGatewayProvidersLayout({ children }: { children: React.ReactNode }) {
  return (
    <AiGatewayScreen
      providerContent={<GatewayDashboardCapabilityGuard>{children}</GatewayDashboardCapabilityGuard>}
    />
  );
}
