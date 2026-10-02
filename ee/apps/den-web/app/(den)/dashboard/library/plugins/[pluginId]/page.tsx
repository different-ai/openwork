import { PluginPageScreen } from "../../../_components/plugin-page-screen";

export default async function LibraryPluginPage({ params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params;
  return <PluginPageScreen pluginId={decodeURIComponent(pluginId)} mode="member" />;
}
