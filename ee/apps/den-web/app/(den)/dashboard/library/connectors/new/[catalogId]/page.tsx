import { Suspense } from "react";
import { MemberConnectorSetupScreen } from "../../../../_components/connector-setup-screen";
import { isNativeProviderCatalogId } from "../../../../_components/connector-catalog";
import { LibraryNativeProviderSetup } from "../../../../_components/library-native-provider-setup";

export default async function LibraryConnectorSetupPage({ params }: { params: Promise<{ catalogId: string }> }) {
  const { catalogId } = await params;
  const id = decodeURIComponent(catalogId);
  return (
    <Suspense fallback={null}>
      {isNativeProviderCatalogId(id) ? <LibraryNativeProviderSetup providerKey={id} /> : <MemberConnectorSetupScreen catalogId={id} />}
    </Suspense>
  );
}
