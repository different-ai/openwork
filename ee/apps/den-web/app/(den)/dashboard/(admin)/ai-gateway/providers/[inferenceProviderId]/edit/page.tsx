import { GatewayDashboardCapabilityGuard } from "../../../../../_components/gateway-dashboard-capability-guard";
import { InferenceProviderEditorScreen } from "../../../../../_components/inference-provider-editor-screen";

export default async function EditAiGatewayProviderPage({
  params,
}: {
  params: Promise<{ inferenceProviderId: string }>;
}) {
  const { inferenceProviderId } = await params;
  return (
    <GatewayDashboardCapabilityGuard area="manage-providers">
      <InferenceProviderEditorScreen key={inferenceProviderId} inferenceProviderId={inferenceProviderId} embedded />
    </GatewayDashboardCapabilityGuard>
  );
}
