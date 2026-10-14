import { Suspense } from "react";
import { redirect } from "next/navigation";
import { SLACK_SEARCH_QUICK_ADD_ID } from "../../../../_components/connector-catalog";
import { MemberConnectorSetupScreen } from "../../../../_components/connector-setup-screen";

export default async function LibraryConnectorSetupPage({ params }: { params: Promise<{ catalogId: string }> }) {
  const { catalogId } = await params;
  if (decodeURIComponent(catalogId) === SLACK_SEARCH_QUICK_ADD_ID) redirect("/dashboard/library/connectors/slack");
  return (
    <Suspense fallback={null}>
      <MemberConnectorSetupScreen catalogId={decodeURIComponent(catalogId)} />
    </Suspense>
  );
}
