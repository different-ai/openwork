import { InferenceProviderEditorScreen } from "../../../../_components/inference-provider-editor-screen";
import { InferenceProviderPickerScreen } from "../../../../_components/inference-provider-picker-screen";
import { LITELLM_PROVIDER_ID } from "../../../../_components/litellm-provider-data";
import { LiteLlmSetupScreen } from "../../../../_components/litellm-provider-screen";

export default async function NewAiGatewayProviderPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string }>;
}) {
  const { provider } = await searchParams;
  if (!provider) return <InferenceProviderPickerScreen embedded />;
  if (provider === LITELLM_PROVIDER_ID) return <LiteLlmSetupScreen embedded />;
  return <InferenceProviderEditorScreen key={provider} catalogProviderId={provider} embedded />;
}
