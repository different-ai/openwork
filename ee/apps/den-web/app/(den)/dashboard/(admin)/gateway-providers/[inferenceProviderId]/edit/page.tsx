import { GatewayProviderForm } from "../../../../_components/gateway-provider-form";

/** Old "/edit" links land on the same form: there is no separate edit mode. */
export default async function EditGatewayProviderPage({
  params,
}: {
  params: Promise<{ inferenceProviderId: string }>;
}) {
  const { inferenceProviderId } = await params;
  return <GatewayProviderForm inferenceProviderId={inferenceProviderId} />;
}
