import { DesktopPolicyEditorScreen } from "../../../_components/desktop-policy-editor-screen";

export default async function EditDesktopPolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ desktopPolicyId: string }>;
  searchParams: Promise<{ setup?: string }>;
}) {
  const { desktopPolicyId } = await params;
  const { setup } = await searchParams;
  return <DesktopPolicyEditorScreen desktopPolicyId={desktopPolicyId} setupRestricted={setup === "restricted"} />;
}
