import { Suspense } from "react";
import { ConnectorSetupFallback } from "../../../../_components/connector-setup-fallback";
import { AdminConnectorSetupScreen } from "../../../../_components/admin-connector-setup-screen";
import { isNativeProviderCatalogId } from "../../../../_components/connector-catalog";
import { NativeProviderSetupScreen } from "../../../../_components/native-provider-setup";

export default async function AddConnectorSetupPage({ params, searchParams }: {
  params: Promise<{ catalogId: string }>;
  searchParams: Promise<{ from?: string; name?: string; url?: string }>;
}) {
  const { catalogId } = await params;
  const { from, name, url } = await searchParams;
  const id = decodeURIComponent(catalogId);
  if (isNativeProviderCatalogId(id)) return <NativeProviderSetupScreen providerKey={id} returnToAgent={from === "my-agent"} />;
  return (
    <Suspense fallback={<ConnectorSetupFallback name={name} url={url} />}>
      <AdminConnectorSetupScreen catalogId={id} />
    </Suspense>
  );
}
