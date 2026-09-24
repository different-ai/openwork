import { LibraryConnectorScreen } from "../../../_components/connector-page-screen";

export default async function LibraryConnectorPage({ params }: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await params;
  return <LibraryConnectorScreen connectionId={decodeURIComponent(connectionId)} />;
}
