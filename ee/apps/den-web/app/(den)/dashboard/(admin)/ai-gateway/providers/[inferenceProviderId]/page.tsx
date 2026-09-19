import { InferenceProviderDetailScreen } from "../../../../_components/inference-provider-detail-screen";

export default async function AiGatewayProviderPage({
  params,
}: {
  params: Promise<{ inferenceProviderId: string }>;
}) {
  const { inferenceProviderId } = await params;
  return <InferenceProviderDetailScreen key={inferenceProviderId} inferenceProviderId={inferenceProviderId} embedded />;
}
