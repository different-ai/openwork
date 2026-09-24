import { SharePluginScreen } from "../../../../_components/share-screen";

export default async function LibraryPluginSharePage({ params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params;
  return <SharePluginScreen pluginId={decodeURIComponent(pluginId)} />;
}
