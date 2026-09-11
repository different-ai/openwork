import { GatewayDashboardCapabilityGuard } from "../../_components/gateway-dashboard-capability-guard";

export default function GatewayProvidersLayout({ children }: { children: React.ReactNode }) {
  return <GatewayDashboardCapabilityGuard>{children}</GatewayDashboardCapabilityGuard>;
}
