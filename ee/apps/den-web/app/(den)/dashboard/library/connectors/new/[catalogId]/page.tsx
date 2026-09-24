import { Suspense } from "react";
import { MemberConnectorSetupScreen } from "../../../../_components/connector-setup-screen";

export default async function LibraryConnectorSetupPage({ params }: { params: Promise<{ catalogId: string }> }) {
  const { catalogId } = await params;
  return (
    <Suspense fallback={null}>
      <MemberConnectorSetupScreen catalogId={decodeURIComponent(catalogId)} />
    </Suspense>
  );
}
