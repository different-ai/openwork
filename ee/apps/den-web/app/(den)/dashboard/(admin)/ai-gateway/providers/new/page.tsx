import { GatewayDashboardCapabilityGuard } from "../../../../_components/gateway-dashboard-capability-guard";
import { InferenceProviderEditorScreen } from "../../../../_components/inference-provider-editor-screen";
import { InferenceProviderPickerScreen } from "../../../../_components/inference-provider-picker-screen";
import { LITELLM_PROVIDER_ID } from "../../../../_components/litellm-provider-data";
import { LiteLlmSetupScreen } from "../../../../_components/litellm-provider-screen";
import { TRUEFOUNDRY_PROVIDER_ID } from "../../../../_components/truefoundry-provider-data";
import { TrueFoundrySetupScreen } from "../../../../_components/truefoundry-provider-screen";

export default async function NewAiGatewayProviderPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const { provider } = await searchParams;
  return (
    <GatewayDashboardCapabilityGuard area="manage-providers">
      {!provider ? <InferenceProviderPickerScreen embedded />
        : provider === LITELLM_PROVIDER_ID ? <LiteLlmSetupScreen embedded />
        : provider === TRUEFOUNDRY_PROVIDER_ID ? <TrueFoundrySetupScreen embedded />
        : <InferenceProviderEditorScreen key={provider} catalogProviderId={provider} embedded />}
    </GatewayDashboardCapabilityGuard>
  );
}
