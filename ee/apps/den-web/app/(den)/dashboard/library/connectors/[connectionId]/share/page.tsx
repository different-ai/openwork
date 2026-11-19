import { ShareConnectorScreen } from "../../../../_components/share-screen";

export default async function LibraryConnectorSharePage({ params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  return <ShareConnectorScreen connectionId={decodeURIComponent(connectionId)} />;
}
