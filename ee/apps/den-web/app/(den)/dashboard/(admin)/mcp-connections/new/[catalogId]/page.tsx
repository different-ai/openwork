import { Suspense } from "react";
import { AdminConnectorSetupScreen } from "../../../../_components/admin-connector-setup-screen";
import { redirect } from "next/navigation";
import { isNativeProviderCatalogId, SLACK_SEARCH_QUICK_ADD_ID } from "../../../../_components/connector-catalog";
import { NativeProviderSetupScreen } from "../../../../_components/native-provider-setup";

export default async function AddConnectorSetupPage({ params }: { params: Promise<{ catalogId: string }> }) {
  const { catalogId } = await params;
  const id = decodeURIComponent(catalogId);
  if (id === SLACK_SEARCH_QUICK_ADD_ID) redirect("/dashboard/library/connectors/slack");
  if (isNativeProviderCatalogId(id)) return <NativeProviderSetupScreen providerKey={id} />;
  return (
    <Suspense fallback={null}>
      <AdminConnectorSetupScreen catalogId={id} />
    </Suspense>
  );
}
