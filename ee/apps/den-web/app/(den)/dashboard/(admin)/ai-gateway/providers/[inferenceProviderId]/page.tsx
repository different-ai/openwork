import { InferenceProviderEditorScreen } from "../../../../_components/inference-provider-editor-screen";

export default async function AiGatewayProviderPage({
  params,
}: {
  params: Promise<{ inferenceProviderId: string }>;
}) {
  const { inferenceProviderId } = await params;
  return <InferenceProviderEditorScreen key={inferenceProviderId} inferenceProviderId={inferenceProviderId} embedded />;
}
