import { Suspense } from "react";
import { AdminConnectorSetupScreen } from "../../../../_components/admin-connector-setup-screen";

export default async function AddConnectorSetupPage({ params }: { params: Promise<{ catalogId: string }> }) {
  const { catalogId } = await params;
  return (
    <Suspense fallback={null}>
      <AdminConnectorSetupScreen catalogId={decodeURIComponent(catalogId)} />
    </Suspense>
  );
}
