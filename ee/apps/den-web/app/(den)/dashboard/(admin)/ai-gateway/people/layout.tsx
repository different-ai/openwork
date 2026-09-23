import { AiGatewayScreen } from "../../../_components/ai-gateway-screen";
import { GatewayDashboardCapabilityGuard } from "../../../_components/gateway-dashboard-capability-guard";

export default function AiGatewayPeopleLayout({ children }: { children: React.ReactNode }) {
  return (
    <AiGatewayScreen
      pageTab="users-and-teams"
      pageContent={<GatewayDashboardCapabilityGuard>{children}</GatewayDashboardCapabilityGuard>}
    />
  );
}
