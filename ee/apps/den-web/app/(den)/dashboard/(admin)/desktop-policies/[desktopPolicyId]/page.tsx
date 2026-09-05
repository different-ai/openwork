import { RestrictedOnboardingScreen } from "../../../_components/restricted-onboarding-screen";
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
  if (setup === "restricted") return <RestrictedOnboardingScreen desktopPolicyId={desktopPolicyId} />;
  return <DesktopPolicyEditorScreen desktopPolicyId={desktopPolicyId} />;
}
