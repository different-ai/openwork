import { Suspense } from "react";
import { AdminConnectorSetupScreen } from "../../../../_components/admin-connector-setup-screen";
import { isNativeProviderCatalogId } from "../../../../_components/connector-catalog";
import { NativeProviderSetupScreen } from "../../../../_components/native-provider-setup";

export default async function AddConnectorSetupPage({ params }: { params: Promise<{ catalogId: string }> }) {
  const { catalogId } = await params;
  const id = decodeURIComponent(catalogId);
  if (isNativeProviderCatalogId(id)) return <NativeProviderSetupScreen providerKey={id} />;
  return (
    <Suspense fallback={null}>
      <AdminConnectorSetupScreen catalogId={id} />
    </Suspense>
  );
}
