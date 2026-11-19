import { AiGatewayScreen } from "../../../_components/ai-gateway-screen";
import { GatewayDashboardCapabilityGuard } from "../../../_components/gateway-dashboard-capability-guard";

/** Smart Routers sit under AI Providers, like a provider's own pages. */
export default function AiGatewaySmartRoutersLayout({ children }: { children: React.ReactNode }) {
  return (
    <AiGatewayScreen
      providerContent={<GatewayDashboardCapabilityGuard area="providers">{children}</GatewayDashboardCapabilityGuard>}
    />
  );
}
