import { AdminPluginCreateScreen } from "../../../_components/plugin-create-screen";
import { PluginEditorScreen } from "../../../_components/plugin-editor-screen";

export default async function NewPluginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { marketplaceId } = await searchParams;
  return marketplaceId ? <PluginEditorScreen /> : <AdminPluginCreateScreen />;
}
