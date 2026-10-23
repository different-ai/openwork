import { EnvironmentVariableEditorScreen } from "../../../_components/environment-variable-editor-screen";

export default async function EditEnvironmentVariablePage({
  params,
}: {
  params: Promise<{ environmentVariableId: string }>;
}) {
  const { environmentVariableId } = await params;
  return <EnvironmentVariableEditorScreen environmentVariableId={environmentVariableId} />;
}
