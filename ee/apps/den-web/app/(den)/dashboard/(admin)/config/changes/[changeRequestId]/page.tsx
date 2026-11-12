import { ConfigChangeRequestScreen } from "../../../../_components/config-blobs/config-change-request-screen";

export default async function ConfigChangeRequestPage({ params }: { params: Promise<{ changeRequestId: string }> }) {
  const { changeRequestId } = await params;
  return <ConfigChangeRequestScreen changeRequestId={decodeURIComponent(changeRequestId)} />;
}
