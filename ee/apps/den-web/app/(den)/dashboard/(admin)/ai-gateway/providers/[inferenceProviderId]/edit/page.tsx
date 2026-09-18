import { InferenceProviderEditorScreen } from "../../../../../_components/inference-provider-editor-screen";

export default async function EditAiGatewayProviderPage({
  params,
}: {
  params: Promise<{ inferenceProviderId: string }>;
}) {
  const { inferenceProviderId } = await params;
  return <InferenceProviderEditorScreen key={inferenceProviderId} inferenceProviderId={inferenceProviderId} routeContext="ai-gateway" embedded />;
}
