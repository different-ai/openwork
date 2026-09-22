import { GatewayProviderForm } from "../../../_components/gateway-provider-form";

export default async function GatewayProviderPage({
  params,
}: {
  params: Promise<{ inferenceProviderId: string }>;
}) {
  const { inferenceProviderId } = await params;
  return <GatewayProviderForm inferenceProviderId={inferenceProviderId} />;
}
