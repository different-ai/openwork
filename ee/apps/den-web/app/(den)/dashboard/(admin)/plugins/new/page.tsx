import { AdminPluginCreateScreen } from "../../../_components/plugin-create-screen";
import { PluginEditorScreen } from "../../../_components/plugin-editor-screen";
import { newPluginPageUsesEditor } from "../../../_components/plugin-import-draft";

export default async function NewPluginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return newPluginPageUsesEditor(await searchParams) ? <PluginEditorScreen /> : <AdminPluginCreateScreen />;
}
