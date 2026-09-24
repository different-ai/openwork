import { PluginPageScreen } from "../../../_components/plugin-page-screen";

export default async function PluginPage({ params }: { params: Promise<{ pluginId: string }> }) {
  const { pluginId } = await params;
  return <PluginPageScreen pluginId={pluginId} mode="admin" />;
}
