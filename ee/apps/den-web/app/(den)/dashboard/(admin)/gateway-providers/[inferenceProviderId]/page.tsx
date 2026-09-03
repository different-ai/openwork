import { InferenceProviderDetailScreen } from "../../../_components/inference-provider-detail-screen";

export default async function GatewayProviderPage({
  params,
}: {
  params: Promise<{ inferenceProviderId: string }>;
}) {
  const { inferenceProviderId } = await params;
  return <InferenceProviderDetailScreen inferenceProviderId={inferenceProviderId} />;
}
