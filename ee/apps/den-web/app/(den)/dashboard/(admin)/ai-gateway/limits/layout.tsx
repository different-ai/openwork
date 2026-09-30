import { AiGatewayScreen } from "../../../_components/ai-gateway-screen";
import { GatewayDashboardCapabilityGuard } from "../../../_components/gateway-dashboard-capability-guard";

export default function AiGatewayLimitsLayout({ children }: { children: React.ReactNode }) {
  return (
    <AiGatewayScreen
      pageTab="limits"
      pageContent={<GatewayDashboardCapabilityGuard>{children}</GatewayDashboardCapabilityGuard>}
    />
  );
}
