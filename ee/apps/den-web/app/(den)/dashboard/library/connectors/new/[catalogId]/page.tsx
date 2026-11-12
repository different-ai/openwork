import { Suspense } from "react";
import { MemberConnectorSetupScreen } from "../../../../_components/connector-setup-screen";
import { isNativeProviderCatalogId } from "../../../../_components/connector-catalog";
import { LibraryNativeProviderSetup } from "../../../../_components/library-native-provider-setup";
import { LibrarySetupIntro } from "../../../../_components/library-setup-intro";

export default async function LibraryConnectorSetupPage({ params }: { params: Promise<{ catalogId: string }> }) {
  const { catalogId } = await params;
  const id = decodeURIComponent(catalogId);
  return (
    <Suspense fallback={null}>
      <LibrarySetupIntro introKey="library.connectors.add" />
      {isNativeProviderCatalogId(id) ? <LibraryNativeProviderSetup providerKey={id} /> : <MemberConnectorSetupScreen catalogId={id} />}
    </Suspense>
  );
}
