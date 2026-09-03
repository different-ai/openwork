import { InferenceProviderEditorScreen } from "../../../../_components/inference-provider-editor-screen";

export default async function EditGatewayProviderPage({
  params,
}: {
  params: Promise<{ inferenceProviderId: string }>;
}) {
  const { inferenceProviderId } = await params;
  return <InferenceProviderEditorScreen inferenceProviderId={inferenceProviderId} />;
}
