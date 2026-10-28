import { Suspense } from "react";
import { AdminConnectorSetupScreen } from "../../../../_components/admin-connector-setup-screen";
import { isNativeProviderCatalogId } from "../../../../_components/connector-catalog";
import { NativeProviderSetupScreen } from "../../../../_components/native-provider-setup";

export default async function AddConnectorSetupPage({ params, searchParams }: {
  params: Promise<{ catalogId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { catalogId } = await params;
  const { from } = await searchParams;
  const id = decodeURIComponent(catalogId);
  if (isNativeProviderCatalogId(id)) return <NativeProviderSetupScreen providerKey={id} returnToAgent={from === "my-agent"} />;
  return (
    <Suspense fallback={null}>
      <AdminConnectorSetupScreen catalogId={id} />
    </Suspense>
  );
}
