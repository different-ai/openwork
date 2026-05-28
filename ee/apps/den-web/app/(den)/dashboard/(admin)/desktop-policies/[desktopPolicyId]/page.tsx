import { DesktopPolicyEditorScreen } from "../../../_components/desktop-policy-editor-screen";

export default async function EditDesktopPolicyPage({
  params,
}: {
  params: Promise<{ desktopPolicyId: string }>;
}) {
  const { desktopPolicyId } = await params;
  return <DesktopPolicyEditorScreen desktopPolicyId={desktopPolicyId} />;
}
