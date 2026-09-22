import { GatewayProviderForm } from "../../../../_components/gateway-provider-form";

export default async function NewGatewayProviderForCatalogPage({
  params,
}: {
  params: Promise<{ catalogProviderId: string }>;
}) {
  const { catalogProviderId } = await params;
  return <GatewayProviderForm catalogProviderId={decodeURIComponent(catalogProviderId)} />;
}
