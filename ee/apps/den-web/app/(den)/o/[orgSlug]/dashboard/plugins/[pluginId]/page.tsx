import { PluginDetailScreen } from "../../_components/plugin-detail-screen";

export default async function PluginPage({
  params,
}: {
  params: Promise<{ pluginId: string }>;
}) {
  const { pluginId } = await params;

  return <PluginDetailScreen pluginId={pluginId} />;
}
